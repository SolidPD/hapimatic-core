// SPDX-License-Identifier: AGPL-3.0-only
import {
  SIGN_IN_WARNING_LEAD_MS,
  computeSignInEnding,
  type AccountHealthEntry,
  type NotifyInput,
  type StoredNotification,
} from "@hapi/protocol";
import type { PushPayload } from "../push/pushService";
import { signInEndingNotification } from "../notifications/producerNotifications";
import type { SignInDeadlineAlertRow } from "../store/signInDeadlineAlertStore";

/**
 * Issue #6161 (Q5): how the producer groups its pushes. `"tick"` (built): one
 * push per node per tick, a summary when several sign-ins are ending; `"account"`:
 * one push per (account, node), each with its own tag. One inbox row per
 * (account, node) either way. Matt picks at Gate 2. With `"account"`, an 8-account
 * tick could send 8 pushes a device whose toggle is off drops silently, and iOS
 * revokes a subscription after 3 silent pushes (the Open Risks row).
 */
export const SIGN_IN_ENDING_PUSH_GROUPING: "tick" | "account" = "tick";

/** One of THIS node's account-health entries, with the node it was read on. */
export type SignInDeadlineAlertInput = {
  entry: AccountHealthEntry;
  nodeId: string;
  nodeLabel: string;
};

export interface SignInDeadlineAlertDeps {
  store: {
    get(accountUuid: string): SignInDeadlineAlertRow | null;
    recordAlerted(
      accountUuid: string,
      deadlineAt: number,
      alertedAt: number
    ): void;
  };
  /** `NotificationService.notify` — never throws by contract. */
  notify: (input: NotifyInput) => StoredNotification | null;
  /** `PushService.sendToNamespace`, or null when push is not configured. */
  push: ((namespace: string, payload: PushPayload) => Promise<void>) | null;
  /** The node owner's namespace (from `cliApiToken`, as the throughput jobs do). */
  namespace: string;
  /** One line per event; the account is named by its uuid prefix only. */
  log?: (line: string) => void;
  grouping?: "tick" | "account";
}

/** The re-login deep link for one node. */
export function reloginUrl(nodeId: string): string {
  return `/settings/account-usage?relogin=anthropic&node=${encodeURIComponent(nodeId)}`;
}

/**
 * Issue #6161 (R14): the sign-in deadline producer. For each local entry inside
 * its warning window it creates ONE `sign-in-ending` notification per login,
 * de-duplicated by one store row per account holding the last alerted deadline:
 * it alerts when there is no row, when the deadline moved more than the warning
 * lead later (a new login), or when the login was signed in after the alert. So
 * a restart, a repeated tick, a rotation that shortens the deadline or a change
 * of the resolved source never creates a second notification.
 *
 * Order: notify, then record, and record only when the returned row persisted.
 * When its store write fails, `notify()` returns an `ephemeral` row: it is still
 * broadcast to open clients (a pop-up) but never stored or pushed. A per-process
 * record of the last alert attempted for each account backs the store up (review
 * F1): the same test runs against the newer of that record and the store row, so
 * a store that keeps failing, or a row an earlier login left behind, costs at
 * most one attempt per login, and a later login still alerts. A restart forgets
 * the record, so a store that never records costs one repeat per restart; a
 * crash between notify and record costs one duplicate.
 *
 * The title holds the account's nickname or email, so `notify` is called with
 * `mirror: false` and the service's own log lines carry the uuid prefix only.
 * The kind sends no push of its own; after the tick's rows persist the service
 * sends one ({@link SIGN_IN_ENDING_PUSH_GROUPING}). Never throws.
 */
export class SignInDeadlineAlertService {
  private readonly deps: SignInDeadlineAlertDeps;
  /** The last alert attempted per account in this process (review F1). */
  private readonly attempted = new Map<string, SignInDeadlineAlertRow>();

  constructor(deps: SignInDeadlineAlertDeps) {
    this.deps = deps;
  }

  /** Returns how many notifications persisted this tick. */
  async checkAndNotify(
    inputs: SignInDeadlineAlertInput[],
    nowMs: number
  ): Promise<number> {
    const persisted: Array<{
      input: SignInDeadlineAlertInput;
      title: string;
    }> = [];
    for (const input of inputs) {
      try {
        const done = this.checkOne(input, nowMs);
        if (done) persisted.push({ input, title: done });
      } catch (err) {
        this.log(
          `[sign-in-deadline] check failed for ${input.entry.accountUuid.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (persisted.length > 0) await this.sendPushes(persisted, nowMs);
    return persisted.length;
  }

  /** The persisted notification's title, or null when nothing persisted. */
  private checkOne(
    input: SignInDeadlineAlertInput,
    nowMs: number
  ): string | null {
    const { entry } = input;
    const uuid = entry.accountUuid;
    const ending = computeSignInEnding(entry, nowMs);
    if (!ending) return null;
    let row: SignInDeadlineAlertRow | null = null;
    try {
      row = this.deps.store.get(uuid);
    } catch (err) {
      this.log(
        `[sign-in-deadline] store read failed for ${uuid.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const memo = this.attempted.get(uuid) ?? null;
    const last =
      memo !== null && (row === null || memo.alertedAt > row.alertedAt)
        ? memo
        : row;
    const due =
      last === null ||
      ending.deadlineAt > last.deadlineAt + SIGN_IN_WARNING_LEAD_MS ||
      entry.capturedAt > last.alertedAt;
    if (!due) {
      if (last === memo && memo !== null) {
        // Only this process's record holds the alert: the store did not keep it.
        this.log(
          `[sign-in-deadline] ${uuid.slice(0, 8)}: not re-sent; this process alerted at ${new Date(memo.alertedAt).toISOString()} but the store holds no record of it`
        );
      }
      return null;
    }

    const notification = signInEndingNotification({
      accountUuid: uuid,
      accountLabel: entry.nickname ?? entry.emailAddress,
      nodeId: input.nodeId,
      nodeLabel: input.nodeLabel,
      daysLeft: ending.daysLeft,
      due: ending.state === "due",
      estimated: ending.estimated,
    });
    this.attempted.set(uuid, {
      deadlineAt: ending.deadlineAt,
      alertedAt: nowMs,
    });
    const stored = this.deps.notify({
      ...notification,
      namespace: this.deps.namespace,
      mirror: false,
    });
    if (!stored || stored.ephemeral === true) {
      this.log(
        `[sign-in-deadline] ${uuid.slice(0, 8)}: notification not persisted; not recorded`
      );
      return null;
    }
    try {
      this.deps.store.recordAlerted(uuid, ending.deadlineAt, nowMs);
    } catch (err) {
      this.log(
        `[sign-in-deadline] record failed for ${uuid.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.log(
      `[sign-in-deadline] notified ${uuid.slice(0, 8)} on ${input.nodeId} (${ending.state}, ${ending.daysLeft} d)`
    );
    return notification.title;
  }

  private async sendPushes(
    rows: Array<{ input: SignInDeadlineAlertInput; title: string }>,
    nowMs: number
  ): Promise<void> {
    const push = this.deps.push;
    if (!push) return;
    const grouping = this.deps.grouping ?? SIGN_IN_ENDING_PUSH_GROUPING;
    const payloads: PushPayload[] =
      grouping === "account"
        ? rows.map(r => ({
            title: r.title,
            body: "Tap to sign in again on that node.",
            tag: `sign-in-ending-${r.input.entry.accountUuid}`,
            data: { type: "sign-in-ending", url: reloginUrl(r.input.nodeId) },
          }))
        : [
            rows.length === 1
              ? {
                  title: rows[0]!.title,
                  body: "Tap to sign in again on that node.",
                  tag: `sign-in-ending-${rows[0]!.input.nodeId}-${nowMs}`,
                  data: {
                    type: "sign-in-ending",
                    url: reloginUrl(rows[0]!.input.nodeId),
                  },
                }
              : {
                  title: `${rows.length} sign-ins are ending`,
                  body: "Open Provider Accounts to sign in again before they end.",
                  tag: `sign-in-ending-${rows[0]!.input.nodeId}-${nowMs}`,
                  data: {
                    type: "sign-in-ending",
                    url: "/settings/account-usage",
                  },
                },
          ];
    for (const payload of payloads) {
      try {
        await push(this.deps.namespace, payload);
      } catch (err) {
        // Logged, never retried: the inbox row and the page still carry it.
        this.log(
          `[sign-in-deadline] push failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }
}
