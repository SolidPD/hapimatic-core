// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The bench helper's lifetime state machine (issue #4352, Tasks 3 and 7).
 *
 * Pure: no I/O, no timers, no process handling. The runtime (`helper.ts`) feeds
 * it events — heartbeat results, heartbeat failures, the server saying the
 * pairing is gone, local approve/deny keypresses, Stop, and a 1-second tick —
 * and executes the actions it returns. Keeping the rules here is what lets
 * every case in the design doc's lifetime table be unit-tested.
 *
 * The rules (docs/internal/architecture/hardware-companion.md, "Lifetime model"):
 *  - a principal reaches the bench only through the server's heartbeat answer;
 *    the bench user approves or denies it locally (or `--approve-for-pairing`
 *    approves it), and only an approved principal gets an `sshd` instance;
 *  - an approved principal is killed when its `validUntil` passes without a
 *    renewal (hard session cap), and when the server stops listing it (the
 *    cloud session ended or was revoked);
 *  - if no heartbeat has succeeded for `staleAfterMs` of wall-clock time —
 *    network loss, or a sleep the process never saw — everything is torn down
 *    and the helper exits: a stale reconnect is refused, re-pair required;
 *  - the server answering "pairing gone" tears everything down;
 *  - Stop tears everything down. Stop never consults activation, licensing or
 *    payment state: nothing in this module (or the helper) imports any of it,
 *    and nothing here kills a running command for any reason other than the
 *    events above (R7).
 */
import type {
  CompanionDecision,
  CompanionPrincipalView,
  CompanionTiming,
} from "@hapi/protocol/companion";

export type LocalPrincipalState = "waiting" | "approved" | "denied";

export type LocalPrincipal = {
  principal: string;
  sessionLabel: string;
  state: LocalPrincipalState;
  /** The end of the current authorization window; `null` until approved. */
  validUntil: number | null;
  /** The server has acknowledged our approval (it lists the principal as approved). */
  serverApproved: boolean;
  /** A local decision not yet acknowledged by the server. */
  pendingDecision: "approve" | "deny" | null;
};

export type KillReason = "expired" | "session-ended";

/** Why the whole bridge is coming down, and the process exit code that goes with it. */
export type TeardownReason =
  | { kind: "stop"; exitCode: 0 }
  | { kind: "stale"; exitCode: 3 }
  | { kind: "pairing-gone"; exitCode: 4; detail: string };

export type LifetimeAction =
  | { kind: "prompt"; principal: string; sessionLabel: string }
  | { kind: "start-instance"; principal: string }
  | { kind: "kill-instance"; principal: string; reason: KillReason }
  | { kind: "teardown"; reason: TeardownReason };

export type CompanionLifetimeOptions = {
  timing: CompanionTiming;
  now: () => number;
  /** `--approve-for-pairing`: admit every principal of this pairing without a keypress. */
  autoApprove: boolean;
};

export class CompanionLifetime {
  private readonly principals = new Map<string, LocalPrincipal>();
  private lastHeartbeatOkAt: number;
  private tornDown: TeardownReason | null = null;
  /** Decisions included in the heartbeat now in flight. */
  private inFlight: CompanionDecision[] = [];

  constructor(private readonly options: CompanionLifetimeOptions) {
    // Pairing just succeeded: that counts as contact with the server.
    this.lastHeartbeatOkAt = options.now();
  }

  /** The teardown that ended this lifetime, if any. */
  get ended(): TeardownReason | null {
    return this.tornDown;
  }

  snapshot(): LocalPrincipal[] {
    return [...this.principals.values()].map(p => ({ ...p }));
  }

  lastContactAt(): number {
    return this.lastHeartbeatOkAt;
  }

  /** The decisions to send with the next heartbeat (marked in flight). */
  takeDecisionsForHeartbeat(): CompanionDecision[] {
    const decisions: CompanionDecision[] = [];
    for (const p of this.principals.values()) {
      if (p.pendingDecision) {
        decisions.push({ principal: p.principal, decision: p.pendingDecision });
      }
    }
    this.inFlight = decisions;
    return decisions;
  }

  /** A heartbeat succeeded; reconcile with the server's view. */
  onHeartbeatOk(views: CompanionPrincipalView[]): LifetimeAction[] {
    if (this.tornDown) return [];
    this.lastHeartbeatOkAt = this.options.now();
    for (const sent of this.inFlight) {
      const p = this.principals.get(sent.principal);
      if (p && p.pendingDecision === sent.decision) p.pendingDecision = null;
    }
    this.inFlight = [];

    const actions: LifetimeAction[] = [];
    const listed = new Set<string>();
    for (const view of views) {
      listed.add(view.principal);
      const local = this.principals.get(view.principal);
      if (!local) {
        const fresh: LocalPrincipal = {
          principal: view.principal,
          sessionLabel: view.sessionLabel,
          state: "waiting",
          validUntil: null,
          serverApproved: false,
          pendingDecision: null,
        };
        this.principals.set(view.principal, fresh);
        if (this.options.autoApprove) {
          actions.push(...this.decide(view.principal, "approve"));
        } else {
          actions.push({
            kind: "prompt",
            principal: view.principal,
            sessionLabel: view.sessionLabel,
          });
        }
        continue;
      }
      local.sessionLabel = view.sessionLabel;
      if (local.state === "approved" && view.state === "approved") {
        local.serverApproved = true;
        if (view.validUntil !== null) local.validUntil = view.validUntil;
      }
    }

    // Anything we hold that the server no longer lists has ended: the cloud
    // session stopped, the pairing was trimmed, or our denial was acknowledged.
    for (const [principal, local] of [...this.principals]) {
      if (listed.has(principal)) continue;
      if (local.pendingDecision) continue; // not yet acknowledged; keep reporting
      this.principals.delete(principal);
      if (local.state === "approved") {
        actions.push({
          kind: "kill-instance",
          principal,
          reason: "session-ended",
        });
      }
    }
    return actions.concat(this.tick());
  }

  /** A heartbeat failed (network, timeout, 5xx). */
  onHeartbeatFailed(): LifetimeAction[] {
    this.inFlight = [];
    return this.tick();
  }

  /** The server says the pairing is gone (401/410): revoked, stale, or restarted. */
  onPairingGone(detail: string): LifetimeAction[] {
    return this.teardown({ kind: "pairing-gone", exitCode: 4, detail });
  }

  /** The bench user's (or `--approve-for-pairing`'s) decision for a waiting principal. */
  decide(principal: string, decision: "approve" | "deny"): LifetimeAction[] {
    if (this.tornDown) return [];
    const p = this.principals.get(principal);
    if (!p || p.state !== "waiting") return [];
    p.pendingDecision = decision;
    if (decision === "deny") {
      p.state = "denied";
      return [];
    }
    p.state = "approved";
    // A provisional window: the server renews it once it acknowledges, and the
    // cap applies even if it never does.
    p.validUntil = this.options.now() + this.options.timing.certTtlMs;
    return [{ kind: "start-instance", principal }];
  }

  /** True while `principal` is approved, so its instance should be running. */
  isApproved(principal: string): boolean {
    return this.principals.get(principal)?.state === "approved";
  }

  /** The oldest principal still waiting for a decision. */
  oldestWaiting(): LocalPrincipal | null {
    for (const p of this.principals.values()) {
      if (p.state === "waiting") return { ...p };
    }
    return null;
  }

  /** Local Stop. Independent of everything else — including activation and payment. */
  stop(): LifetimeAction[] {
    return this.teardown({ kind: "stop", exitCode: 0 });
  }

  /** Run every second: the session cap and the stale-contact rule. */
  tick(): LifetimeAction[] {
    if (this.tornDown) return [];
    const now = this.options.now();
    if (now - this.lastHeartbeatOkAt > this.options.timing.staleAfterMs) {
      return this.teardown({ kind: "stale", exitCode: 3 });
    }
    const actions: LifetimeAction[] = [];
    for (const [principal, p] of [...this.principals]) {
      if (
        p.state === "approved" &&
        p.validUntil !== null &&
        now >= p.validUntil
      ) {
        this.principals.delete(principal);
        actions.push({ kind: "kill-instance", principal, reason: "expired" });
      }
    }
    return actions;
  }

  private teardown(reason: TeardownReason): LifetimeAction[] {
    if (this.tornDown) return [];
    this.tornDown = reason;
    this.principals.clear();
    return [{ kind: "teardown", reason }];
  }
}
