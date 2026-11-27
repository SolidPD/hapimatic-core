// SPDX-License-Identifier: AGPL-3.0-only
//
// Issue #3784 — cross-node refresh-token chain independence.
//
// The idle-refresh backstop (`TokenRefreshService.refreshIdleIsolatedAccounts`)
// historically skipped rotating ANY account a federation node held a live
// session on (the "P-REVOKE skip"), on the premise that one refresh-token family
// backs an account across every node, so rotating here would revoke the remote
// holder's access token (#1645).
//
// That premise is FALSE. The verified invariant (this issue's Mose 3-machine
// coexistence evidence, 2026-09-17, plus the #4423 copy-guard that prevents a
// record ever being copied between nodes) is: a refresh token is single-use and
// DISTINCT grants form INDEPENDENT chains that coexist — only a COPIED token
// collides. So a node rotating its OWN independent chain cannot revoke a remote
// holder's chain. This module decides whether rotating is safe by comparing
// refresh-token FINGERPRINTS (sha256 hex, never a raw token) and sign-in facts
// across nodes. It fails SAFE: any doubt ⇒ "unknown" ⇒ skip.
//
// Issue #6997 extends the rule from the MIXED (local AND remote) case to the
// REMOTE-ONLY case (a live session on another node, none here). Rotating a
// remote-only account here does not "buy nothing", as #3784 first assumed: it
// keeps THIS node's stored token live, which keeps its usage, health and
// utilization reads true, and lets a dead chain show up as `unrefreshable`
// instead of hiding under `refreshing` for days. This supersedes a recorded
// design, by Matt's X1-1 (2026-11-26): #4888's requirement "leave the
// remote-only case unchanged", `sessionLiveness.ts`'s "both keep decaying to
// expiry by design", and epic #6799's 2026-11-21 named limit. The proof is
// stronger than #3784's (R3):
//  (a) every node holding a live binding answered the probe with a fingerprint
//      (remote-only: with its layouts too; an older receiver's lone
//      fingerprint does not cover it, F3);
//  (b) no answering node's fingerprint, in any folder layout or its host login
//      chain, equals this node's (copy-collision);
//  (c) no answering node reports a sign-in deadline within 60 s of this node's,
//      or a sign-in marker equal to this node's (same-sign-in);
//  (d) remote-only only (Matt's D2 = U2): this node's own sign-in deadline is
//      known, or its sign-in marker names its current refresh token.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSignInMarker,
  parseSignInMarkerWrittenAt,
  SIGN_IN_MARKER_FILE,
} from "@hapi/protocol/accounts";
import {
  accountConfigDirFor,
  readIsolatedCredentials,
} from "@/accounts/accountConfigDir";
import { refreshTokenFingerprint } from "@/accounts/machineRotator";

/** A sign-in marker's comparable facts: its fingerprint and time, never a token. */
export interface SignInMarkerFacts {
  /** sha256 hex of the refresh token the sign-in produced, or null. */
  fingerprint: string | null;
  /** The marker's `writtenAt` as epoch ms, or null. */
  writtenAt: number | null;
}

/** Issue #6997: what one remote node reported about its chain for an account. */
export interface RemoteChainNodeFacts {
  /** Every non-null fingerprint the node reported (each folder layout, its host chain). */
  fingerprints: string[];
  /** The node's first-layout sign-in deadline (epoch ms), or null. */
  deadlineAt: number | null;
  /** Every known sign-in deadline the node reported, one per layout. */
  deadlines: number[];
  /** Every sign-in marker the node reported. */
  markers: SignInMarkerFacts[];
  /**
   * True when the node answered with a fingerprint but no per-layout facts: an
   * older receiver (or an older local aggregator) that reports neither its other
   * layouts nor its sign-in facts. A receiver with PR 1 reports a layout for
   * every fingerprint it gives. Absent ⇒ false.
   */
  olderReceiver?: boolean;
}

/** Refresh-token chain fingerprints held by OTHER federation nodes for an
 *  account (sha256 hex; NEVER a raw token) + whether that view is degraded. */
export interface RemoteChainFingerprints {
  fingerprints: Set<string>;
  degraded: boolean;
  /**
   * Issue #6997: the same answers per node id (every non-self node that
   * answered). Optional so older callers and test literals stay valid; absent ⇒
   * no node is known to have answered, so holder coverage cannot pass.
   */
  byNode?: Map<string, RemoteChainNodeFacts>;
}

/**
 * The verdict on whether THIS node's isolated chain for an account is a distinct
 * grant from every remote holder's:
 *  - "independent" — this node's fingerprint differs from every remote one
 *                    (rotating this chain cannot cross-revoke a remote holder);
 *  - "shared"      — this node's fingerprint EQUALS a remote one (a COPIED token:
 *                    rotating WOULD cross-revoke — must not rotate; should not
 *                    exist post-#4423, so it is reported loudly), or, #6997, the
 *                    two chains come from the same sign-in;
 *  - "unknown"     — this node's fingerprint is unreadable OR a remote view was
 *                    degraded this pass (fail SAFE: do not rotate).
 */
export type ChainIndependence = "independent" | "shared" | "unknown";

/**
 * Issue #6997: why a verdict is not "independent". Lives only in the daemon (its
 * log and job row); #6162 owns any transport of it to the display.
 */
export type ChainVerdictCause =
  | "copy-collision"
  | "same-sign-in"
  | "holder-uncovered"
  | "no-provenance"
  | "degraded"
  | "local-unreadable"
  | "assess-error";

/** Issue #6997: a verdict with its cause (null for "independent"). */
export interface ChainAssessment {
  verdict: ChainIndependence;
  cause: ChainVerdictCause | null;
}

/** Which binding the backstop is deciding: local AND remote, or remote only. */
export type RemoteBindingMode = "mixed" | "remote-only";

/** Issue #6997 (R3(c)): two sign-in deadlines this close are one sign-in. */
export const SAME_SIGN_IN_TOLERANCE_MS = 60_000;

/**
 * Issue #6997: what the backstop knows that the remote probe does not. Every
 * field is optional; without a context the verdict is exactly #3784's.
 */
export interface ChainAssessContext {
  mode?: RemoteBindingMode;
  /** The nodes holding a live binding (R3(a)); `?` stands for a session with no node id. */
  holderNodeIds?: ReadonlySet<string>;
  /**
   * This node's fingerprint, from the same parse as its deadline. When the key
   * is present it is used instead of calling the local reader (null ⇒ unreadable).
   */
  localFingerprint?: string | null;
  /** This node's folder sign-in deadline (epoch ms), or null when unknown. */
  localDeadlineAt?: number | null;
  /** This node's sign-in marker, or null when there is none. */
  localMarker?: SignInMarkerFacts | null;
  /** True when this node's sign-in marker names its current refresh token. */
  markerNamesCurrent?: boolean;
}

/** Issue #6997: this node's own chain facts, read in ONE parse of its folder file. */
export interface LocalChainFacts {
  fingerprint: string | null;
  deadlineAt: number | null;
  marker: SignInMarkerFacts | null;
}

/** Default reader for THIS node's own isolated chain fingerprint: sha256 of the
 *  isolated `.credentials.json` refresh token, or null when absent/unreadable. */
export async function defaultLocalChainFingerprint(
  accountUuid: string
): Promise<string | null> {
  const oauth = await readIsolatedCredentials(accountUuid).catch(() => null);
  if (!oauth?.refreshToken) return null;
  return refreshTokenFingerprint(oauth.refreshToken);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Issue #6997: THIS node's chain facts for an account. The fingerprint and the
 * sign-in deadline come from ONE parse of the folder's `.credentials.json`, so
 * they describe the same file state; the sign-in marker is read beside it.
 * Hashes and times only. Never throws.
 */
export async function readLocalChainFacts(
  accountUuid: string
): Promise<LocalChainFacts> {
  const oauth = await readIsolatedCredentials(accountUuid).catch(() => null);
  let marker: SignInMarkerFacts | null = null;
  try {
    const raw = await readFile(
      join(accountConfigDirFor(accountUuid), SIGN_IN_MARKER_FILE),
      "utf-8"
    );
    marker = {
      fingerprint: parseSignInMarker(raw),
      writtenAt: parseSignInMarkerWrittenAt(raw),
    };
  } catch {
    marker = null;
  }
  return {
    fingerprint: oauth?.refreshToken
      ? refreshTokenFingerprint(oauth.refreshToken)
      : null,
    deadlineAt: finiteOrNull(oauth?.refreshTokenExpiresAt),
    marker,
  };
}

/**
 * Issue #6997 (R3(d), Matt's U2): a remote-only rotation needs positive
 * provenance — this node's own sign-in deadline is known, or its sign-in marker
 * names its current refresh token. The marker leg is one-shot: it holds only
 * until the folder's first rotation (the marker then names an older token).
 */
export function hasRemoteOnlyProvenance(context: ChainAssessContext): boolean {
  return (
    finiteOrNull(context.localDeadlineAt) !== null ||
    context.markerNamesCurrent === true
  );
}

/** R3(c): does any remote node report this node's sign-in? */
function sharesSignIn(
  remote: RemoteChainFingerprints,
  context: ChainAssessContext
): boolean {
  const localDeadline = finiteOrNull(context.localDeadlineAt);
  const localMarker = context.localMarker ?? null;
  for (const facts of remote.byNode?.values() ?? []) {
    if (localDeadline !== null) {
      for (const d of facts.deadlines) {
        if (Math.abs(d - localDeadline) <= SAME_SIGN_IN_TOLERANCE_MS) {
          return true;
        }
      }
    }
    if (localMarker) {
      for (const m of facts.markers) {
        if (
          localMarker.fingerprint !== null &&
          m.fingerprint === localMarker.fingerprint
        ) {
          return true;
        }
        if (
          localMarker.writtenAt !== null &&
          m.writtenAt === localMarker.writtenAt
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Issue #6997: the verdict and its cause. Without a context the verdict is
 * exactly #3784's (local unreadable or degraded ⇒ unknown; a remote fingerprint
 * equal to this node's ⇒ shared; else independent). With one, in this order:
 * local unreadable → degraded → R3(a) holder coverage → R3(b) copy-collision →
 * R3(c) same-sign-in → R3(d) provenance (remote-only mode only). Never throws:
 * a throw in either reader maps to the fail-safe "unknown".
 *
 * The remote set MUST already EXCLUDE this node's own id (the daemon closure
 * does so); if it ever includes self, a match reads as "shared" ⇒ skip, which is
 * merely over-conservative, never unsafe.
 */
export async function assessChainIndependenceDetailed(
  accountUuid: string,
  getLocalChainFingerprint: (uuid: string) => Promise<string | null>,
  getRemoteChainFingerprints: (
    uuid: string
  ) => Promise<RemoteChainFingerprints>,
  context?: ChainAssessContext
): Promise<ChainAssessment> {
  const localFp =
    context && "localFingerprint" in context
      ? (context.localFingerprint ?? null)
      : await getLocalChainFingerprint(accountUuid).catch(() => null);
  if (!localFp) return { verdict: "unknown", cause: "local-unreadable" };
  const remote = await getRemoteChainFingerprints(accountUuid).catch(
    (): RemoteChainFingerprints => ({
      fingerprints: new Set<string>(),
      degraded: true,
    })
  );
  if (remote.degraded) return { verdict: "unknown", cause: "degraded" };
  if (!context) {
    return remote.fingerprints.has(localFp)
      ? { verdict: "shared", cause: "copy-collision" }
      : { verdict: "independent", cause: null };
  }
  // R3(a): every holder node answered with at least one fingerprint. A context
  // that names no holder cannot show coverage, so it never passes vacuously.
  if (!context.holderNodeIds || context.holderNodeIds.size === 0) {
    return { verdict: "unknown", cause: "holder-uncovered" };
  }
  for (const nodeId of context.holderNodeIds) {
    const facts = remote.byNode?.get(nodeId);
    if (!facts || facts.fingerprints.length === 0) {
      return { verdict: "unknown", cause: "holder-uncovered" };
    }
    // F3 (#6997): on the remote-only path a holder must also report its other
    // layouts and sign-in facts, which an older receiver does not, so (b) and
    // (c) cannot be checked against it. The mixed path keeps #3784's rule (R2).
    if (context.mode === "remote-only" && facts.olderReceiver === true) {
      return { verdict: "unknown", cause: "holder-uncovered" };
    }
  }
  // R3(b): no answering node holds this node's token, in any layout.
  if (
    remote.fingerprints.has(localFp) ||
    [...(remote.byNode?.values() ?? [])].some(f =>
      f.fingerprints.includes(localFp)
    )
  ) {
    return { verdict: "shared", cause: "copy-collision" };
  }
  // R3(c): no answering node shares this node's sign-in.
  if (sharesSignIn(remote, context)) {
    return { verdict: "shared", cause: "same-sign-in" };
  }
  // R3(d), remote-only only: this node's chain has positive provenance.
  if (context.mode === "remote-only" && !hasRemoteOnlyProvenance(context)) {
    return { verdict: "unknown", cause: "no-provenance" };
  }
  return { verdict: "independent", cause: null };
}

/**
 * Compare this node's isolated chain fingerprint against the remote holders' set
 * (#3784's verdict, no context). Never throws. A thin wrapper over
 * {@link assessChainIndependenceDetailed} for the callers that need only the
 * verdict.
 */
export async function assessRemoteChainIndependence(
  accountUuid: string,
  getLocalChainFingerprint: (uuid: string) => Promise<string | null>,
  getRemoteChainFingerprints: (uuid: string) => Promise<RemoteChainFingerprints>
): Promise<ChainIndependence> {
  return (
    await assessChainIndependenceDetailed(
      accountUuid,
      getLocalChainFingerprint,
      getRemoteChainFingerprints
    )
  ).verdict;
}

/**
 * Issue #6997: turn a verdict from a verdict-only seam (an older injection,
 * which saw no context) into an assessment. Such a seam could check none of
 * R3(a), (c) or (d), so it can never prove the REMOTE-ONLY case: a remote-only
 * "independent" reads "unknown" (holder-uncovered). The mixed case keeps the
 * seam's verdict, as #3784 did; its other causes are not known, so they stay
 * null (and the log lines stay #3784's).
 */
export function assessmentFromVerdict(
  verdict: ChainIndependence,
  context: ChainAssessContext
): ChainAssessment {
  if (verdict === "independent" && context.mode === "remote-only") {
    return { verdict: "unknown", cause: "holder-uncovered" };
  }
  return { verdict, cause: null };
}

/** The aggregator's per-node entry, as the wire carries it (#3784 + #6997). */
interface AggregatorEntry {
  nodeId?: string;
  nodeLabel?: string;
  self?: boolean;
  fingerprint?: string | null;
  layoutFingerprints?: unknown;
  deadlineAt?: unknown;
  layouts?: unknown;
  markers?: unknown;
}

function fingerprintOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Issue #6997: one node's answer as comparable facts. An older peer's reply
 *  (no layouts, deadlines or markers) reads as just its fingerprint, flagged
 *  `olderReceiver` (F3). */
function nodeFactsFromEntry(e: AggregatorEntry): RemoteChainNodeFacts {
  const fingerprints = new Set<string>();
  const deadlines = new Set<number>();
  let layoutCount = 0;
  const top = fingerprintOrNull(e.fingerprint);
  if (top) fingerprints.add(top);
  for (const fp of Array.isArray(e.layoutFingerprints)
    ? e.layoutFingerprints
    : []) {
    const v = fingerprintOrNull(fp);
    if (v) fingerprints.add(v);
  }
  const topDeadline = finiteOrNull(e.deadlineAt);
  if (topDeadline !== null) deadlines.add(topDeadline);
  for (const layout of Array.isArray(e.layouts) ? e.layouts : []) {
    if (typeof layout !== "object" || layout === null) continue;
    layoutCount += 1;
    const l = layout as { fingerprint?: unknown; deadlineAt?: unknown };
    const fp = fingerprintOrNull(l.fingerprint);
    if (fp) fingerprints.add(fp);
    const d = finiteOrNull(l.deadlineAt);
    if (d !== null) deadlines.add(d);
  }
  const markers: SignInMarkerFacts[] = [];
  for (const marker of Array.isArray(e.markers) ? e.markers : []) {
    if (typeof marker !== "object" || marker === null) continue;
    const m = marker as { fingerprint?: unknown; writtenAt?: unknown };
    markers.push({
      fingerprint: fingerprintOrNull(m.fingerprint),
      writtenAt: finiteOrNull(m.writtenAt),
    });
  }
  // F3 (#6997): a fingerprint with no layout behind it comes from a receiver
  // without PR 1, which compared none of its other layouts or sign-in facts.
  const olderReceiver = fingerprints.size > 0 && layoutCount === 0;
  return {
    fingerprints: [...fingerprints],
    deadlineAt: topDeadline,
    deadlines: [...deadlines],
    markers,
    ...(olderReceiver ? { olderReceiver: true } : {}),
  };
}

/**
 * Issue #6997: read the aggregator's body (`/api/federation/account-chain-
 * fingerprints`) into the remote view, EXCLUDING this node's own entry. The flat
 * `fingerprints` set keeps #3784's meaning (each node's first-layout
 * fingerprint); `byNode` carries every node's full answer. Shared by the daemon
 * fetcher and `hapi accounts chain-probe`, so both judge the same input.
 */
export function remoteChainFromAggregatorBody(body: {
  fingerprints?: AggregatorEntry[];
  degraded?: boolean;
}): RemoteChainFingerprints {
  const fingerprints = new Set<string>();
  const byNode = new Map<string, RemoteChainNodeFacts>();
  for (const e of body.fingerprints ?? []) {
    if (e.self) continue;
    if (typeof e.fingerprint === "string") fingerprints.add(e.fingerprint);
    if (typeof e.nodeId === "string" && e.nodeId.length > 0) {
      byNode.set(e.nodeId, nodeFactsFromEntry(e));
    }
  }
  return { fingerprints, degraded: body.degraded === true, byNode };
}

/**
 * Mint a JWT from the LOCAL server (`POST /api/auth` with the CLI token), as the
 * daemon's federation reads need. Throws `auth HTTP <status>` or `no JWT in
 * /api/auth response`; the callers log the message and fail safe.
 */
export async function mintLocalServerJwt(
  serverUrl: string,
  cliApiToken: string | null
): Promise<string> {
  const authResp = await fetch(`${serverUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: cliApiToken }),
  });
  if (!authResp.ok) throw new Error(`auth HTTP ${authResp.status}`);
  const { token } = (await authResp.json()) as { token?: string };
  if (!token) throw new Error("no JWT in /api/auth response");
  return token;
}

/**
 * Build the daemon's `getRemoteChainFingerprints` reader: query the LOCAL
 * server's cross-node aggregator (`/api/federation/account-chain-fingerprints`),
 * EXCLUDE this node's own entry (`!self`), and return the other nodes'
 * fingerprints + a degraded flag. Fails SAFE on any error (degraded: true ⇒ the
 * verdict is "unknown" ⇒ no rotation) — so a probe failure can never cause a
 * blind rotation. Extracted from the daemon so `run.ts` stays thin and the I/O
 * is exercisable in isolation.
 */
export function makeRemoteChainFingerprintsFetcher(opts: {
  serverUrl: string;
  cliApiToken: string | null;
  warn?: (message: string) => void;
}): (accountUuid: string) => Promise<RemoteChainFingerprints> {
  return async (accountUuid: string) => {
    try {
      const token = await mintLocalServerJwt(opts.serverUrl, opts.cliApiToken);
      const resp = await fetch(
        `${opts.serverUrl}/api/federation/account-chain-fingerprints?accountUuid=${encodeURIComponent(accountUuid)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!resp.ok) {
        throw new Error(`account-chain-fingerprints HTTP ${resp.status}`);
      }
      return remoteChainFromAggregatorBody(
        (await resp.json()) as {
          fingerprints?: AggregatorEntry[];
          degraded?: boolean;
        }
      );
    } catch (err) {
      opts.warn?.(
        `[IDLE_REFRESH] chain-fingerprint probe failed (fail-safe skip): ${err instanceof Error ? err.message : String(err)}`
      );
      return { fingerprints: new Set<string>(), degraded: true };
    }
  };
}

/** A decision for the idle backstop's remote-bound near-expiry case. */
export type MixedBindingDecision =
  | {
      action: "skip";
      level: "info" | "warn";
      message: string;
      jobError?: string;
      /** The verdict behind a gate-on skip (absent ⇒ the gate is off). */
      verdict?: ChainIndependence;
      /** Its cause, when the assessment named one. */
      cause?: ChainVerdictCause | null;
    }
  | { action: "rotate"; message: string };

/** Issue #6997: the same shape, for either binding mode. */
export type RemoteBindingDecision = MixedBindingDecision;

/**
 * Decide whether the idle backstop may rotate a near-expiry isolated account a
 * federation node holds: MIXED (live here too) or, #6997, REMOTE-ONLY (none
 * here). Pure except for the injected `assess` seam; produces the exact log line
 * + optional job-error so the caller stays a thin logger. Gated: `enabled ===
 * false` ⇒ today's skip line for the mode, with no probe (R7).
 */
export async function decideRemoteBindingRotation(args: {
  accountUuid: string;
  emailAddress: string;
  enabled: boolean;
  mode: RemoteBindingMode;
  assess: (accountUuid: string) => Promise<ChainAssessment>;
}): Promise<RemoteBindingDecision> {
  const { accountUuid: uuid, emailAddress: email, enabled, mode } = args;
  const remoteOnly = mode === "remote-only";
  if (!enabled) {
    return {
      action: "skip",
      level: "info",
      message: remoteOnly
        ? `[IDLE_REFRESH] skip ${uuid} (${email}) — live session bound on a federation node, none local (P-REVOKE guard; no cross-node restart)`
        : `[IDLE_REFRESH] skip ${uuid} (${email}) — live session bound on a federation node (P-REVOKE guard; cross-node independence check disabled)`,
    };
  }
  const { verdict, cause } = await args
    .assess(uuid)
    .catch(
      (): ChainAssessment => ({ verdict: "unknown", cause: "assess-error" })
    );
  if (verdict === "shared") {
    if (cause === "same-sign-in") {
      return {
        action: "skip",
        level: "warn",
        message: `[IDLE_REFRESH] skip ${uuid} (${email}) — SAME sign-in as a federation node's chain (same-sign-in: a sign-in deadline within 60 s or an equal sign-in marker; P-REVOKE guard)`,
        jobError: `[IDLE_REFRESH] same-sign-in: ${uuid} (${email}) shares a sign-in with a federation node — not rotating (P-REVOKE)`,
        verdict,
        cause,
      };
    }
    return {
      action: "skip",
      level: "warn",
      message: `[IDLE_REFRESH] skip ${uuid} (${email}) — SHARED refresh-token chain with a federation node (copy-collision; P-REVOKE guard)`,
      jobError: `[IDLE_REFRESH] copy-collision: ${uuid} (${email}) shares a refresh-token chain with a federation node — not rotating (P-REVOKE)`,
      verdict,
      cause,
    };
  }
  if (verdict !== "independent") {
    const why = cause ? `${cause}; ` : "";
    return {
      action: "skip",
      level: "info",
      message: remoteOnly
        ? `[IDLE_REFRESH] skip ${uuid} (${email}) — live session bound on a federation node, none local; cannot confirm cross-node chain independence this pass (${why}fail-safe; P-REVOKE guard)`
        : `[IDLE_REFRESH] skip ${uuid} (${email}) — cannot confirm cross-node chain independence this pass (${why}fail-safe; P-REVOKE guard)`,
      verdict: "unknown",
      cause,
    };
  }
  return {
    action: "rotate",
    message: remoteOnly
      ? `[IDLE_REFRESH] rotate-eligible ${uuid} (${email}) — independent chain, held only on a federation node (P-REVOKE lifted; #6997)`
      : `[IDLE_REFRESH] rotate-eligible ${uuid} (${email}) — independent chain, remote holder present (P-REVOKE lifted; #3784)`,
  };
}

/**
 * #3784's MIXED-case decision over a verdict-only `assess` seam: a thin wrapper
 * over {@link decideRemoteBindingRotation}, with today's lines.
 */
export async function decideMixedBindingRotation(args: {
  accountUuid: string;
  emailAddress: string;
  enabled: boolean;
  assess: (accountUuid: string) => Promise<ChainIndependence>;
}): Promise<MixedBindingDecision> {
  return decideRemoteBindingRotation({
    accountUuid: args.accountUuid,
    emailAddress: args.emailAddress,
    enabled: args.enabled,
    mode: "mixed",
    assess: async uuid => ({ verdict: await args.assess(uuid), cause: null }),
  });
}
