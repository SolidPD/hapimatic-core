// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Isolated-credentials mirror and wipe detector (issue #5020, R3 + R4).
 *
 * Native Claude Code owns in-session refresh of an isolated account: it rotates
 * the pair in `<accountConfigsDir>/<uuid>/.credentials.json` and never tells
 * Hapimatic. Before #5020 nothing copied those rotations into the instance's
 * account store, so the store kept the pair it was seeded with (ms1, 2026-10-10:
 * Emily's store still held the 2026-10-09T22:57Z capture pair, `lastRefreshedAt`
 * 0), and every store-based repair later wrote that long-consumed pair back over
 * the file — then `invalid_grant`, then `unrefreshable`.
 *
 * Once per daemon maintenance tick this module:
 *  - MIRRORS a well-formed file pair whose `expiresAt` is newer than the store's
 *    into the store (tokens, `lastRefreshedAt`, and `isolatedHeadExpiresAt`, the
 *    file lineage spawn-time recovery checks before it seeds — R5). The
 *    `unrefreshable` flag clears only by the #4423 fingerprint rule.
 *  - DETECTS a file native emptied after its own refresh failed (`cleared`:
 *    both tokens empty, `expiresAt` 0). Native clears only a head that just got
 *    `invalid_grant` while it was on disk, so a copy of that head is equally
 *    dead and nothing can restore it without a re-login. The account is marked
 *    `unrefreshable` (reason `native-cleared`, fingerprint of the store head) and
 *    one `error_logs` entry is written — instead of the silent loss before.
 *  - REPORTS a malformed file to `error_logs` once per change, without flagging:
 *    spawn-time recovery can still repair it from a store head the lineage
 *    guard accepts.
 *
 * It never writes the credentials file and never calls OAuth. It runs on every
 * daemon (each instance has its own store; the same reason #4423's stale-flag
 * clear runs everywhere). It skips env-token accounts (no refresh token, never
 * isolated) and the host-default account (native's host credentials and the
 * CredentialsWatcher own that one, #1520). Never throws. Token values never
 * reach the logger.
 */

import type { StoredAccount } from "@hapi/protocol/accounts";
import { isEnvTokenAccount } from "@hapi/protocol/accounts";
import {
  readIsolatedCredentialsState,
  type IsolatedClaudeAiOauth,
  type IsolatedCredentialsState,
} from "@/accounts/accountConfigDir";
import {
  adoptPairIntoStore,
  refreshTokenFingerprint,
  withIsolatedLineage,
} from "@/accounts/machineRotator";
import { logger } from "@/ui/logger";

/** `unrefreshableReason` for a file native emptied. */
export const NATIVE_CLEARED_REASON = "native-cleared";

export type MirrorDecision =
  | { action: "none" }
  | { action: "mirror"; oauth: IsolatedClaudeAiOauth }
  | { action: "lineage"; expiresAt: number }
  | { action: "flag-cleared"; fingerprint: string | null }
  | { action: "report-malformed"; detail: string };

/**
 * What the mirror does for one account, given its store record and the file
 * state (pure):
 *  - absent → nothing;
 *  - a readable pair newer than the store's → mirror it;
 *  - a readable pair the store already holds (or a newer one) but that is
 *    beyond the recorded lineage → advance the lineage only;
 *  - cleared → flag (once: an account already flagged `native-cleared` is left
 *    alone);
 *  - malformed → report.
 */
export function decideMirror(
  account: StoredAccount,
  state: IsolatedCredentialsState
): MirrorDecision {
  switch (state.kind) {
    case "absent":
      return { action: "none" };
    case "readable": {
      if (state.oauth.expiresAt > account.expiresAt) {
        return { action: "mirror", oauth: state.oauth };
      }
      if ((account.isolatedHeadExpiresAt ?? 0) < state.oauth.expiresAt) {
        return { action: "lineage", expiresAt: state.oauth.expiresAt };
      }
      return { action: "none" };
    }
    case "cleared":
      if (
        account.unrefreshable === true &&
        account.unrefreshableReason === NATIVE_CLEARED_REASON
      ) {
        return { action: "none" };
      }
      return {
        action: "flag-cleared",
        fingerprint: account.refreshToken
          ? refreshTokenFingerprint(account.refreshToken)
          : null,
      };
    case "malformed":
      return { action: "report-malformed", detail: state.detail };
  }
}

/**
 * The store merge for a mirrored pair: the rotation's adoption merge (tokens,
 * lineage, the #4423 fingerprint clear rule) plus `lastRefreshedAt`.
 */
export function mergeMirroredPair(
  current: StoredAccount,
  oauth: IsolatedClaudeAiOauth,
  now: number
): StoredAccount {
  return { ...adoptPairIntoStore(current, oauth), lastRefreshedAt: now };
}

export interface MirrorReport {
  message: string;
  category: string;
  severity: "warn" | "error";
  context: string;
}

export interface IsolatedMirrorDeps {
  /** Anthropic account uuids in this instance's store. */
  listAccountUuids: () => Promise<string[]>;
  /** A store record, or null when missing / malformed. */
  getAccount: (uuid: string) => Promise<StoredAccount | null>;
  /** Read-merge-write onto this instance's store record. */
  mergeStore: (
    uuid: string,
    mergeFn: (current: StoredAccount) => StoredAccount
  ) => Promise<void>;
  /** The host-default account, or null. */
  hostDefaultUuid: () => Promise<string | null>;
  now: () => number;
  /** Test seam; production reads the real file. */
  readState?: (uuid: string) => Promise<IsolatedCredentialsState>;
  /** Test seam; production writes to the server's `error_logs`. */
  report?: (report: MirrorReport) => void;
  /** Per-account file mtime last reported (one report per change). */
  reported?: Map<string, number>;
}

/** Process-wide report dedupe: one `error_logs` entry per file change. */
const reportedMtimes = new Map<string, number>();

/** Test hook: forget every reported mtime. */
export function clearMirrorReportCache(): void {
  reportedMtimes.clear();
}

function defaultReport(r: MirrorReport): void {
  logger.reportError({
    message: r.message,
    category: r.category,
    severity: r.severity,
    context: r.context,
  });
}

function fp8(fingerprint: string | null): string {
  return fingerprint ? fingerprint.slice(0, 8) : "none";
}

/**
 * One mirror pass over this instance's Anthropic accounts. Never throws: a
 * failure on one account is logged and the pass moves on.
 */
export async function runIsolatedCredentialsMirror(
  deps: IsolatedMirrorDeps
): Promise<void> {
  const readState = deps.readState ?? readIsolatedCredentialsState;
  const report = deps.report ?? defaultReport;
  const reported = deps.reported ?? reportedMtimes;
  let uuids: string[];
  let hostDefault: string | null;
  try {
    uuids = await deps.listAccountUuids();
    hostDefault = await deps.hostDefaultUuid().catch(() => null);
  } catch (err) {
    logger.warn(
      `[ISOLATED_MIRROR] pass skipped: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  for (const uuid of uuids) {
    try {
      if (hostDefault && uuid === hostDefault) continue;
      const account = await deps.getAccount(uuid);
      if (!account || isEnvTokenAccount(account)) continue;
      const state = await readState(uuid);
      const decision = decideMirror(account, state);
      switch (decision.action) {
        case "none":
          break;
        case "mirror": {
          const now = deps.now();
          await deps.mergeStore(uuid, current =>
            mergeMirroredPair(current, decision.oauth, now)
          );
          logger.info(
            `[ISOLATED_MIRROR] mirrored the isolated pair for ${uuid} into the store (refresh=${fp8(refreshTokenFingerprint(decision.oauth.refreshToken))} expiresAt=${new Date(decision.oauth.expiresAt).toISOString()})`
          );
          break;
        }
        case "lineage":
          await deps.mergeStore(uuid, current =>
            withIsolatedLineage(current, decision.expiresAt)
          );
          break;
        case "flag-cleared": {
          await deps.mergeStore(uuid, current => ({
            ...current,
            unrefreshable: true,
            unrefreshableReason: NATIVE_CLEARED_REASON,
            ...(decision.fingerprint
              ? { unrefreshableTokenFingerprint: decision.fingerprint }
              : {}),
          }));
          const mtimeMs = state.kind === "cleared" ? state.mtimeMs : 0;
          logger.warn(
            `[ISOLATED_MIRROR] isolated credentials for ${uuid} (${account.emailAddress}) were cleared by a native refresh failure; marked unrefreshable (store head ${fp8(decision.fingerprint)}) — re-login required`
          );
          if (reported.get(uuid) !== mtimeMs) {
            reported.set(uuid, mtimeMs);
            report({
              message: "isolated credentials cleared by native refresh failure",
              category: "accounts",
              severity: "error",
              context: JSON.stringify({
                accountUuid: uuid,
                storeHeadFingerprint: fp8(decision.fingerprint),
                fileMtime: new Date(mtimeMs).toISOString(),
              }),
            });
          }
          break;
        }
        case "report-malformed": {
          const mtimeMs = state.kind === "malformed" ? state.mtimeMs : 0;
          if (reported.get(uuid) === mtimeMs) break;
          reported.set(uuid, mtimeMs);
          logger.warn(
            `[ISOLATED_MIRROR] isolated credentials for ${uuid} are malformed (${decision.detail}); left for spawn-time recovery`
          );
          report({
            message: "isolated credentials file is malformed",
            category: "accounts",
            severity: "warn",
            context: JSON.stringify({
              accountUuid: uuid,
              detail: decision.detail,
            }),
          });
          break;
        }
      }
    } catch (err) {
      logger.warn(
        `[ISOLATED_MIRROR] ${uuid}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
