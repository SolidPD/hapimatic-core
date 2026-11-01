// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Minimal daemon-control client for the SERVER package (issue #1805).
 *
 * The server CANNOT import `cli/` — its only workspace dep is `@hapi/protocol`,
 * and every `cli/src` mention in `server/src` is a comment, never an import
 * (the same boundary that forced `accountService`/`anthropicOauthLoginClient`
 * to reimplement rather than import). This client mirrors
 * `cli/src/daemon/controlClient.ts:daemonPost` (read daemon.state.json →
 * bearer → POST → `{error}` on failure) and
 * `server/src/web/routes/launcher.ts:resolveSettingsPath` (HAPI_HOME path).
 *
 * It reaches the LOCAL daemon's process-local `/effective-count` control
 * endpoint (`127.0.0.1:<httpPort>`, established in #1477) to read the
 * authoritative spawn capacity — NOT the federation `sessionCount`, which is a
 * different number (see `routes/federation/infrastructure.ts`).
 *
 * Fallback Preservation: every failure path (no state file, stale daemon,
 * non-2xx, timeout, malformed JSON) returns `{ error }` and NEVER throws — the
 * caller (`GET /api/daemon/capacity`) maps that to a typed `{null, null}`
 * (HTTP 200), so a down daemon renders the meter as "—" and does NOT block
 * spawning (R5).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseAmbientOnboardingTokenState,
  type AmbientOnboardingTokenState,
} from "@hapi/protocol/accounts";
import {
  DaemonCapSourceSchema,
  type DaemonCapSource,
} from "@hapi/protocol/schemas";
import { EFFORT_LEVELS, type EffortLevel } from "@hapi/protocol/effort";

/**
 * The subset of daemon.state.json this client needs. `controlToken` survives in
 * the CLI's `DaemonState` via `.passthrough()`; we type it explicitly here
 * (the in-path correctness note from the #1805 code review).
 */
interface DaemonStateFields {
  httpPort?: number;
  controlToken?: string;
  pid?: number;
  /** #4736: validated with `parseAmbientOnboardingTokenState` before any use. */
  ambientOnboardingToken?: unknown;
}

/** Result of a capacity read — either the numbers or a diagnostic error.
 *  #4417: `recommendedConcurrent` + `capSource` are OPTIONAL — an older daemon omits
 *  them, and the caller fails open (no warn threshold, inferred source). */
export type DaemonCapacityResult =
  | {
      effectiveCount: number;
      maxConcurrent: number;
      recommendedConcurrent?: number;
      capSource?: DaemonCapSource;
    }
  | { error: string };

const DAEMON_CAPACITY_TIMEOUT_MS = process.env.HAPI_DAEMON_HTTP_TIMEOUT
  ? parseInt(process.env.HAPI_DAEMON_HTTP_TIMEOUT, 10)
  : 4000;

/** `<HAPI_HOME>/daemon.state.json` (mirrors launcher.ts:resolveSettingsPath). */
export function resolveDaemonStatePath(): string {
  if (process.env.HAPI_HOME) {
    const expanded = process.env.HAPI_HOME.replace(/^~/, homedir());
    return join(expanded, "daemon.state.json");
  }
  return join(homedir(), ".hapi", "daemon.state.json");
}

function readDaemonState(): DaemonStateFields | null {
  const file = resolveDaemonStatePath();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DaemonStateFields;
  } catch {
    return null;
  }
}

/** Cheap liveness probe — avoids a wasted fetch + full timeout on a dead daemon. */
function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * #4736: the local daemon's recorded disposition of the onboarding env token
 * (`ambientOnboardingToken`, written by the cli's envSeedTokenDisposition.ts), or
 * `null` when unknown — no state file, a dead daemon (a crash mid-seed would leave
 * `pending` stuck), or an unrecognized value. Uses only `pid` (liveness) and that
 * field, and returns only the validated enum: the same file holds the daemon's
 * `controlToken`, so nothing else is returned or logged.
 * Never throws.
 */
export function readOnboardingSeedState(): AmbientOnboardingTokenState | null {
  const state = readDaemonState();
  if (!state || typeof state !== "object" || !isPidAlive(state.pid)) {
    return null;
  }
  return parseAmbientOnboardingTokenState(state.ambientOnboardingToken);
}

/**
 * Read the local daemon's authoritative capacity ({effectiveCount, max}) and
 * map it to the #1805 wire vocabulary ({effectiveCount, maxConcurrent}, KD-4).
 * Returns `{ error }` on any failure — never throws (Fallback Preservation).
 */
export async function getDaemonCapacity(): Promise<DaemonCapacityResult> {
  const state = readDaemonState();
  if (!state?.httpPort) {
    return { error: "No daemon running (no state file or httpPort)" };
  }
  if (!isPidAlive(state.pid)) {
    return { error: "Daemon not running (stale state file)" };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Defense-in-depth bearer (issue #1738). Guarded so we never send
    // "Bearer undefined" against a pre-#1738 daemon state file.
    if (state.controlToken) {
      headers["Authorization"] = `Bearer ${state.controlToken}`;
    }

    const res = await fetch(
      `http://127.0.0.1:${state.httpPort}/effective-count`,
      {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(DAEMON_CAPACITY_TIMEOUT_MS),
      }
    );

    if (!res.ok) {
      return { error: `Daemon /effective-count HTTP ${res.status}` };
    }

    const data = (await res.json()) as {
      effectiveCount?: number;
      max?: number;
      recommended?: number;
      source?: unknown;
    };
    if (
      typeof data.effectiveCount !== "number" ||
      typeof data.max !== "number"
    ) {
      return { error: "Daemon returned a malformed effective-count payload" };
    }

    // #4417: map the daemon's `recommended`/`source` to the wire vocabulary. Both are
    // OPTIONAL — an older daemon omits them. `source` is validated through the schema so
    // an unexpected value degrades to `undefined` (fail-open) rather than propagating.
    const parsedSource = DaemonCapSourceSchema.safeParse(data.source);
    return {
      effectiveCount: data.effectiveCount,
      maxConcurrent: data.max,
      recommendedConcurrent:
        typeof data.recommended === "number" ? data.recommended : undefined,
      capSource: parsedSource.success ? parsedSource.data : undefined,
    };
  } catch (err) {
    return {
      error: `Daemon /effective-count failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Result of a spawn-quiesce toggle — the applied state or a diagnostic error. */
export type DaemonSpawnPausedResult =
  | { ok: true; paused: boolean }
  | { error: string };

/**
 * Toggle the local daemon's spawn-quiesce flag (issue #1774, Sub E, Task 10 /
 * R9). POSTs `/spawn-paused {paused}` to the daemon control endpoint — the same
 * bearer-gated transport `getDaemonCapacity` uses. Returns `{ error }` on any
 * failure and NEVER throws (Fallback Preservation): a down daemon means the
 * quiesce is simply skipped, and the self-update flow proceeds without it (the
 * flow is correct without the quiesce — it only narrows the spawn race).
 */
export async function setDaemonSpawnPaused(
  paused: boolean
): Promise<DaemonSpawnPausedResult> {
  const state = readDaemonState();
  if (!state?.httpPort) {
    return { error: "No daemon running (no state file or httpPort)" };
  }
  if (!isPidAlive(state.pid)) {
    return { error: "Daemon not running (stale state file)" };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (state.controlToken) {
      headers["Authorization"] = `Bearer ${state.controlToken}`;
    }

    const res = await fetch(`http://127.0.0.1:${state.httpPort}/spawn-paused`, {
      method: "POST",
      headers,
      body: JSON.stringify({ paused }),
      signal: AbortSignal.timeout(DAEMON_CAPACITY_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { error: `Daemon /spawn-paused HTTP ${res.status}` };
    }

    const data = (await res.json()) as { paused?: boolean };
    return { ok: true, paused: data.paused ?? paused };
  } catch (err) {
    return {
      error: `Daemon /spawn-paused failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * POST a JSON body to a local daemon control endpoint (bearer-gated, #1738) and
 * return the parsed JSON, or `{ error }`. Never throws.
 */
async function postDaemonControl(
  path: string,
  body: unknown
): Promise<{ data: unknown } | { error: string }> {
  const state = readDaemonState();
  if (!state?.httpPort) {
    return { error: "No daemon running (no state file or httpPort)" };
  }
  if (!isPidAlive(state.pid)) {
    return { error: "Daemon not running (stale state file)" };
  }
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (state.controlToken) {
      headers["Authorization"] = `Bearer ${state.controlToken}`;
    }
    const res = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DAEMON_CAPACITY_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `Daemon ${path} HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (err) {
    return {
      error: `Daemon ${path} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Result of a spawn-defaults read — the default effort or a diagnostic error. */
export type DaemonSpawnDefaultsResult =
  | { effort: EffortLevel }
  | { error: string };

/**
 * Read the local daemon's resolved spawn default effort (issue #6028) from
 * `/spawn-defaults` — the level a fresh claude spawn on this node gets before
 * the per-model fit (env `HAPI_DEFAULT_EFFORT` on the daemon's unit > settings
 * `defaultEffort` > xhigh). The server cannot resolve it itself: the env tier
 * lives on the daemon's unit. `{ error }` on any failure (an older daemon has no
 * such endpoint); never throws.
 */
export async function getDaemonSpawnDefaults(): Promise<DaemonSpawnDefaultsResult> {
  const res = await postDaemonControl("/spawn-defaults", {});
  if ("error" in res) return res;
  const effort = (res.data as { effort?: unknown } | null)?.effort;
  if (
    typeof effort !== "string" ||
    !(EFFORT_LEVELS as readonly string[]).includes(effort)
  ) {
    return { error: "Daemon returned a malformed spawn-defaults payload" };
  }
  return { effort: effort as EffortLevel };
}
