// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccountHealthSinceSource,
  AccountMonogram,
  ProviderId,
} from "@hapi/protocol";
import type { ApiKeyProvider, RedactedApiKey } from "@hapi/protocol/schemas";
import { ApiError } from "@/api/client";

/**
 * Pure helpers behind the "+ Add" modal (issue #4464): the Done planner, the
 * paste-several parser, the UTC timestamp formatter the node rows and #4466's
 * alert tooltip share, and the add-key result wording. No React, no network.
 */

/** One API-key row's lifecycle. Under #4463 D-1 A a key is stored only after it
 *  validates, so `passed` is the only state with a stored id. A `failed` row
 *  with `keyStored` is the exception: its add failed, but the server kept the
 *  key (`mint_rollback_failed`, #5429), so the row is final for this modal and
 *  is never sent again (#5646 F1). */
export type KeyRowStatus =
  | { kind: "draft" }
  | { kind: "testing" }
  | {
      kind: "passed";
      id: string;
      maskedKey: string;
      modelCount?: number;
      modelCountCapped?: boolean;
    }
  | { kind: "failed"; message: string; keyStored?: true };

export type KeyRow = {
  /** Row-local id; also the monogram's colour seed while the row is a draft. */
  rowId: string;
  name: string;
  key: string;
  monogram?: AccountMonogram;
  status: KeyRowStatus;
};

/** The modal's three providers write these vault providers. Gemini keys use the
 *  vault's `gemini` provider, as `GeminiKeyEntry` did before #4464. */
export function vaultProviderFor(provider: ProviderId): ApiKeyProvider {
  return provider === "google" ? "gemini" : provider;
}

/**
 * Split pasted text into keys: one per line, trimmed, empty lines dropped,
 * duplicates collapsed to their first occurrence.
 */
export function parseKeyLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** True for a row whose add failed but whose key the server kept
 *  (`mint_rollback_failed`, #5429): the row is final for this modal (#5646 F1). */
export function keyKeptByServer(status: KeyRowStatus): boolean {
  return status.kind === "failed" && status.keyStored === true;
}

/** True when a row still has work for Done: a key, no pass yet, no test in
 *  flight, and no key the server kept after a failed add (#5646 F1: sending it
 *  again only answers 409 `duplicate_key`). */
export function rowNeedsAdd(row: KeyRow): boolean {
  return (
    row.key.trim() !== "" &&
    row.status.kind !== "passed" &&
    row.status.kind !== "testing" &&
    !keyKeptByServer(row.status)
  );
}

export type DonePlan = {
  /** The completion call, when a sign-in was started and a code is pasted. */
  completeCode?: { loginToken: string; code: string };
  /** Rows Done adds (validate, then store). */
  addRows: string[];
};

/**
 * What Done runs (R7): one completion call when a code is present, and one add
 * per untested non-empty row. Rows that already passed are stored, so they are
 * skipped. The plan carries no node: the login's node is the option the hook was
 * built with, and the token alone routes the completion (#4462).
 */
export function planDone(state: {
  loginToken: string | null;
  code: string;
  rows: KeyRow[];
}): DonePlan {
  const code = state.code.trim();
  return {
    ...(state.loginToken && code
      ? { completeCode: { loginToken: state.loginToken, code } }
      : {}),
    addRows: state.rows.filter(rowNeedsAdd).map(r => r.rowId),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Epoch ms → `YYYY-MM-DD HH:MM:SS UTC`, or `YYYY-MM-DDTHH:MM:SSZ` when
 * `compact` (the 393 px form, R3).
 */
export function formatRefreshUtc(
  ms: number,
  opts?: { compact?: boolean }
): string {
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return opts?.compact ? `${date}T${time}Z` : `${date} ${time} UTC`;
}

/**
 * The re-login "since" text (R3; #4466 Task 3 uses the same wording in its alert
 * tooltip): "since <ts>" when the time is the last refresh, else "never
 * refreshed; added <ts>". An entry without `since` yields null (the picker's
 * alert icon passes such entries too).
 */
export function formatSince(
  entry: { since?: number; sinceSource?: AccountHealthSinceSource },
  opts?: { compact?: boolean }
): string | null {
  if (entry.since === undefined) return null;
  const ts = formatRefreshUtc(entry.since, opts);
  return entry.sinceSource === "lastRefreshedAt"
    ? `since ${ts}`
    : `never refreshed; added ${ts}`;
}

/** The row text for a stored key (R6). */
export function describeValidKey(
  key: Pick<RedactedApiKey, "lastValidation">
): string {
  const count = key.lastValidation?.modelCount;
  if (count === undefined) return "Valid";
  const capped = key.lastValidation?.modelCountCapped ? "+" : "";
  return `Valid · ${count}${capped} model${count === 1 && !capped ? "" : "s"} reachable`;
}

const STATUS_TYPE: Record<number, string> = {
  400: "key rejected",
  401: "authentication",
  403: "permission",
  429: "rate limited",
};

function serverMessageOf(err: ApiError): string | undefined {
  if (!err.body) return undefined;
  try {
    const parsed = JSON.parse(err.body) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.trim()
      ? parsed.error.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function upstreamStatusOf(err: ApiError): number | undefined {
  if (!err.body) return undefined;
  try {
    const parsed = JSON.parse(err.body) as { upstreamStatus?: unknown };
    return typeof parsed.upstreamStatus === "number"
      ? parsed.upstreamStatus
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Did a failed add still leave the key stored (#5429)? Only when its Google
 * account could not be created AND the server could not undo the vault write
 * (`mint_rollback_failed`): the user must remove that key before adding it again.
 */
export function addErrorLeftKeyStored(err: unknown): boolean {
  return err instanceof ApiError && err.code === "mint_rollback_failed";
}

/**
 * Map a failed add (validate, then store) to the row text (R6). `uiNode` names
 * the vault the key would have gone to. A row becomes `passed` only on success,
 * so the row stays unsaved. Every server answer but a failed mint rollback
 * (#5429), where the server kept the key, left the vault unchanged; a request
 * that got no complete answer (a dropped connection or a client timeout) may or
 * may not have stored the key.
 */
export function describeAddKeyError(err: unknown, uiNode: string): string {
  if (err instanceof ApiError) {
    const upstream = upstreamStatusOf(err);
    if (err.code === "duplicate_key") return "This key is already stored";
    if (err.code === "key_rejected") {
      const type = upstream !== undefined ? STATUS_TYPE[upstream] : undefined;
      const detail =
        upstream !== undefined ? ` (${upstream}${type ? ` ${type}` : ""})` : "";
      return `Rejected${detail} · check the key`;
    }
    if (err.code === "key_unverified") {
      let why = "no answer from the provider";
      if (upstream === 429) why = "429 rate limited";
      else if (upstream !== undefined && upstream >= 500)
        why = `${upstream} provider unavailable`;
      else if (upstream !== undefined) why = String(upstream);
      return `Could not verify (${why}) · not saved · try again`;
    }
    // #5429: the key IS stored (its rollback failed), so never say "not saved".
    if (addErrorLeftKeyStored(err)) {
      return "Saved without its account · remove the key, then add it again";
    }
    // The server answered with something else: say what it said.
    const message = serverMessageOf(err);
    if (message) return `${message} · not saved`;
    return `${uiNode} answered ${err.status} · not saved`;
  }
  // No answer at all (a network error): the vault could not be reached.
  return `Could not reach ${uiNode} · not saved`;
}
