// SPDX-License-Identifier: AGPL-3.0-only
import axios from "axios";
import chalk from "chalk";
import { PmSpawnReconciliationStatusSchema } from "@hapi/protocol";
import {
  BULK_SESSION_MAX_IDS,
  BulkSessionResultSchema,
  type BulkSessionResult,
} from "@hapi/protocol/bulkSessionResult";
import {
  ModelModeSchema,
  SessionRoleSchema,
  SESSION_ROLES,
} from "@hapi/protocol/schemas";
import { MODEL_MODES } from "@hapi/protocol/modes";
import { configuration } from "@/configuration";
import { readSettings } from "@/persistence";
import { writeStdout } from "@/utils/stdout";
import { handleErrorLogs } from "./apiErrorLogs";
import { handleApiCall } from "./apiCall";
import { authenticateCli, cliApiTokenSourcesNote } from "./cliAuth";
import {
  SPAWN_CLIENT_TIMEOUT_MS,
  isAxiosTimeout,
  spawnTimeoutMessage,
} from "./apiSpawnError";
import type { CommandDefinition } from "./types";

function authHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/**
 * Parsed result of `hapi api sessions spawn` flags. `--dir` is required;
 * `machineId` defaults to the local machine when `--machine` is omitted
 * (issue #994); `name` is the optional session display name.
 */
export type ResolvedSpawnArgs = {
  dir: string;
  machineId: string;
  name?: string;
  /** Issue #2155: role-scoped `@`-include profile (pm/worker/researcher/closer/
   *  interactive). Validated strictly here (clear CLI error on a typo); absent
   *  → the spawned session loads the FULL stack. */
  sessionRole?: string;
  /** Issue #2434: Claude model-mode pin (default/sonnet/opus/fable). Validated
   *  strictly here (clear CLI error on a typo); absent → the session follows
   *  the normal default-mode resolution, byte-identical to pre-#2434. */
  modelMode?: string;
  /** Issue #2479: link the spawned session to a parent (managed peer). Defaults
   *  to the caller's HAPI_SESSION_ID when the flag is omitted, so a spawn from
   *  inside a session auto-links to it. May be a tag; the server resolves it. */
  parentSessionId?: string;
};
export type SpawnArgsError = { error: string };

/**
 * Resolve `sessions spawn` flags, defaulting `--machine` to the local machine
 * ID from `<HAPI_HOME>/settings.json` (`configuration.settingsFile`) when
 * omitted (issue #994). An explicit `--machine` always wins and short-circuits
 * the settings read (R2). Returns a `{ error }` shape — never throws — so the
 * caller controls exit.
 *
 * `readSettingsFn` is injectable for unit tests, matching the codebase's
 * no-mocking test style (the test passes a plain stub, not a module mock).
 * `settingsPath` is injectable the same way, and names the file in the
 * missing-machine-id error (#5098).
 */
export async function resolveSpawnArgs(
  args: string[],
  readSettingsFn: typeof readSettings = readSettings,
  // #2479: injectable so the function stays pure/testable (like readSettingsFn).
  // Production callers get the caller's HAPI_SESSION_ID; tests pass an explicit
  // value (or undefined) to avoid depending on the runner's environment.
  parentSessionIdEnv: string | undefined = process.env.HAPI_SESSION_ID,
  settingsPath: string = configuration.settingsFile
): Promise<ResolvedSpawnArgs | SpawnArgsError> {
  const dir = parseFlag(args, "--dir");
  if (!dir) {
    return {
      error:
        "Usage: hapi api sessions spawn --dir <path> [--machine <id>] [--name <display-name>] [--session-role <role>] [--model-mode <mode>] [--parent-session-id <id>]",
    };
  }

  // Issue #2155: validate --session-role strictly at the CLI (human-facing
  // surface) so a typo gets a clear error naming the valid roles, rather than
  // silently loading the full stack. The server contract itself fail-opens on
  // an unknown role (machines.ts `.catch(undefined)`), but the CLI is a
  // convenience wrapper where an explicit error is the better UX.
  const sessionRoleRaw = parseFlag(args, "--session-role");
  if (
    sessionRoleRaw !== undefined &&
    !SessionRoleSchema.safeParse(sessionRoleRaw).success
  ) {
    return {
      error: `Invalid --session-role '${sessionRoleRaw}'. Valid roles: ${SESSION_ROLES.join(", ")}.`,
    };
  }

  // Issue #2434: validate --model-mode strictly at the CLI (human-facing
  // surface) so a typo gets a clear error naming the valid modes, mirroring
  // --session-role above. The server's flavor guard (machines.ts) is the
  // AUTHORITATIVE check — it also rejects a Claude mode on a non-Claude spawn,
  // which the CLI cannot know here (the spawn's agent is server-side default).
  const modelModeRaw = parseFlag(args, "--model-mode");
  if (
    modelModeRaw !== undefined &&
    !ModelModeSchema.safeParse(modelModeRaw).success
  ) {
    return {
      error: `Invalid --model-mode '${modelModeRaw}'. Valid modes: ${MODEL_MODES.join(", ")}.`,
    };
  }

  // An explicit --machine wins and avoids consulting settings.json (R2).
  let machineId = parseFlag(args, "--machine");
  if (!machineId) {
    const settings = await readSettingsFn();
    machineId = settings.machineId;
  }
  if (!machineId) {
    return {
      error:
        `No machine id found in ${settingsPath}. ` +
        "Start the daemon with 'hapi daemon start' (if it is already running, run 'hapi daemon stop' first) to register this machine, or pass --machine <id> explicitly.",
    };
  }

  const name = parseFlag(args, "--name");
  // Issue #2479: default the parent link to the caller's HAPI_SESSION_ID so a
  // spawn issued from inside a session (a hook, or Sub-Issue R's hapi-spawn.sh)
  // auto-links the new managed peer to its spawner. An explicit flag wins. The
  // value may be a session TAG (HAPI_SESSION_ID is the tag) — the server
  // resolves tag→uuid before persisting (machines.ts, expert-review D1a).
  const parentSessionId =
    parseFlag(args, "--parent-session-id") ?? parentSessionIdEnv;
  return {
    dir,
    machineId,
    ...(name ? { name } : {}),
    ...(sessionRoleRaw ? { sessionRole: sessionRoleRaw } : {}),
    ...(modelModeRaw ? { modelMode: modelModeRaw } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

/**
 * Request descriptor produced by `resolveSpawnRosterRequest` — a method + path +
 * body/query triple that `handleSessionMetadata` dispatches via axios. Extracted
 * as a pure function (mirrors `resolveSpawnArgs`) so the verb → endpoint mapping is
 * unit-testable without a running server (issue #1938).
 */
export type SpawnRosterRequest =
  | { method: "POST"; path: string; body: Record<string, unknown> }
  | { method: "PATCH"; path: string; body: Record<string, unknown> }
  | { method: "GET"; path: string; query: Record<string, string> };
export type SpawnRosterArgsError = { error: string };

const SPAWN_ROSTER_NODE_LOCAL_PATH = "/api/session-metadata/spawn-roster";
const SPAWN_ROSTER_FEDERATION_PATH =
  "/api/federation/session-metadata/spawn-roster";
const SPAWN_ROSTER_USAGE =
  "Usage: hapi api session-metadata spawn-roster <register|enrich|set-status|query> [flags]";

/** True when `value` is one of the server's reconciliation-status enum members.
 *  Reuses `PmSpawnReconciliationStatusSchema` so the CLI's accepted values stay in
 *  lockstep with the server schema (issue #1936: spawned | complete | re-driving). */
function isReconciliationStatus(value: string): boolean {
  return PmSpawnReconciliationStatusSchema.safeParse(value).success;
}

/**
 * Map a `session-metadata spawn-roster` verb + flags to a request descriptor for
 * the #1936 endpoints, or an `{ error }` shape (never throws — the caller controls
 * exit, matching `resolveSpawnArgs`). `args[0]` is the verb; the rest are
 * `--flag value` pairs and/or a positional `<token>`. The four verbs map to the
 * live, JWT-gated endpoints:
 *   - register   → POST   /api/session-metadata/spawn-roster
 *   - enrich     → PATCH  /api/session-metadata/spawn-roster/:token  (ids)
 *   - set-status → PATCH  /api/session-metadata/spawn-roster/:token  (status)
 *   - query      → GET    /api/session-metadata/spawn-roster         (node-local)
 *                  GET    /api/federation/session-metadata/spawn-roster (--all-nodes)
 */
export function resolveSpawnRosterRequest(
  args: string[]
): SpawnRosterRequest | SpawnRosterArgsError {
  const verb = args[0];

  if (verb === "register") {
    const completionToken = parseFlag(args, "--completion-token");
    const pmSessionId = parseFlag(args, "--pm-session-id");
    const nodeId = parseFlag(args, "--node-id");
    const spawnedAtRaw = parseFlag(args, "--spawned-at-ms");
    if (!completionToken || !pmSessionId || !nodeId || !spawnedAtRaw) {
      return {
        error:
          "Usage: hapi api session-metadata spawn-roster register " +
          "--completion-token <t> --pm-session-id <id> --node-id <id> --spawned-at-ms <n> " +
          "[--hapi-session-id <id>] [--cc-session-id <id>] [--issue <n>] [--repo <r>] " +
          "[--worktree-path <p>] [--status <spawned|complete|re-driving>]",
      };
    }
    const spawnedAtMs = Number(spawnedAtRaw);
    if (!Number.isFinite(spawnedAtMs)) {
      return {
        error: `--spawned-at-ms must be a number (got '${spawnedAtRaw}')`,
      };
    }
    const status = parseFlag(args, "--status");
    if (status !== undefined && !isReconciliationStatus(status)) {
      return {
        error: `--status must be one of spawned|complete|re-driving (got '${status}')`,
      };
    }
    const hapiSessionId = parseFlag(args, "--hapi-session-id");
    const ccSessionId = parseFlag(args, "--cc-session-id");
    const issue = parseFlag(args, "--issue");
    const repo = parseFlag(args, "--repo");
    const worktreePath = parseFlag(args, "--worktree-path");
    const body: Record<string, unknown> = {
      completionToken,
      pmSessionId,
      nodeId,
      spawnedAtMs,
      ...(hapiSessionId ? { hapiSessionId } : {}),
      ...(ccSessionId ? { ccSessionId } : {}),
      ...(issue ? { issue } : {}),
      ...(repo ? { repo } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(status ? { reconciliationStatus: status } : {}),
    };
    return { method: "POST", path: SPAWN_ROSTER_NODE_LOCAL_PATH, body };
  }

  if (verb === "enrich") {
    const token = args[1];
    if (!token || token.startsWith("--")) {
      return {
        error:
          "Usage: hapi api session-metadata spawn-roster enrich <token> " +
          "[--cc-session-id <id>] [--hapi-session-id <id>]",
      };
    }
    const ccSessionId = parseFlag(args, "--cc-session-id");
    const hapiSessionId = parseFlag(args, "--hapi-session-id");
    if (ccSessionId === undefined && hapiSessionId === undefined) {
      return {
        error:
          "enrich requires at least one of --cc-session-id or --hapi-session-id",
      };
    }
    const body: Record<string, unknown> = {
      ...(ccSessionId ? { ccSessionId } : {}),
      ...(hapiSessionId ? { hapiSessionId } : {}),
    };
    return {
      method: "PATCH",
      path: `${SPAWN_ROSTER_NODE_LOCAL_PATH}/${encodeURIComponent(token)}`,
      body,
    };
  }

  if (verb === "set-status") {
    const token = args[1];
    if (!token || token.startsWith("--")) {
      return {
        error:
          "Usage: hapi api session-metadata spawn-roster set-status <token> " +
          "--status <spawned|complete|re-driving>",
      };
    }
    const status = parseFlag(args, "--status");
    if (!status) {
      return {
        error: "set-status requires --status <spawned|complete|re-driving>",
      };
    }
    if (!isReconciliationStatus(status)) {
      return {
        error: `--status must be one of spawned|complete|re-driving (got '${status}')`,
      };
    }
    return {
      method: "PATCH",
      path: `${SPAWN_ROSTER_NODE_LOCAL_PATH}/${encodeURIComponent(token)}`,
      body: { reconciliationStatus: status },
    };
  }

  if (verb === "query") {
    const pmSessionId = parseFlag(args, "--pm-session-id");
    if (!pmSessionId) {
      return {
        error:
          "Usage: hapi api session-metadata spawn-roster query " +
          "--pm-session-id <id> [--status <spawned|complete|re-driving>] [--all-nodes]",
      };
    }
    const status = parseFlag(args, "--status");
    if (status !== undefined && !isReconciliationStatus(status)) {
      return {
        error: `--status must be one of spawned|complete|re-driving (got '${status}')`,
      };
    }
    const allNodes = args.includes("--all-nodes");
    const query: Record<string, string> = {
      pmSessionId,
      ...(status ? { status } : {}),
    };
    return {
      method: "GET",
      path: allNodes
        ? SPAWN_ROSTER_FEDERATION_PATH
        : SPAWN_ROSTER_NODE_LOCAL_PATH,
      query,
    };
  }

  return { error: SPAWN_ROSTER_USAGE };
}

/**
 * Resolve the `hapi api sessions capabilities <id>` verb to a GET request path.
 * Pure (mirrors `resolveSpawnRosterRequest`) so the verb → endpoint mapping is
 * unit-testable without a running server (issue #2418, R5/R6). `args[0]` is the
 * action ("capabilities"); `args[1]` is the session id.
 */
export function resolveCapabilitiesRequest(
  args: string[]
): { path: string } | { error: string } {
  const sessionId = args[1];
  if (!sessionId) {
    return { error: "Usage: hapi api sessions capabilities <id>" };
  }
  return {
    path: `/api/sessions/${encodeURIComponent(sessionId)}/capabilities`,
  };
}

/** The server's per-call ceiling for a wait (issue #3816, `sessionStateWaiter`). */
const WAIT_UNTIL_MAX_MS = 25_000;

const WAIT_UNTIL_USAGE =
  "Usage: hapi api sessions wait-until <id> --state <state> [--timeout <ms>]";

/**
 * Issue #3816: build the wait-until request. `--timeout` travels as
 * `?timeoutMs=` (the server clamps it to 25 000); the HTTP client waits 5 s
 * longer than the server will hold the request, so a server-side timeout is
 * always answered rather than cut off.
 */
export function resolveWaitUntilRequest(
  args: string[]
): { path: string; clientTimeoutMs: number } | { error: string } {
  const sessionId = args[1];
  if (!sessionId || sessionId.startsWith("--")) {
    return { error: WAIT_UNTIL_USAGE };
  }
  let state: string | undefined;
  let timeout: string | undefined;
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--state" || flag === "--timeout") {
      if (value === undefined || value.startsWith("--")) {
        return { error: `${flag} needs a value. ${WAIT_UNTIL_USAGE}` };
      }
      if (flag === "--state") state = value;
      else timeout = value;
      i++;
    } else {
      return { error: `Unknown option "${flag}". ${WAIT_UNTIL_USAGE}` };
    }
  }
  if (!state) return { error: WAIT_UNTIL_USAGE };

  let path = `/api/sessions/${encodeURIComponent(sessionId)}/wait-until/${encodeURIComponent(state)}`;
  let serverTimeoutMs = WAIT_UNTIL_MAX_MS;
  if (timeout !== undefined) {
    if (!/^\d+$/.test(timeout)) {
      return {
        error: `--timeout must be a whole number of milliseconds. ${WAIT_UNTIL_USAGE}`,
      };
    }
    serverTimeoutMs = Math.min(Number(timeout), WAIT_UNTIL_MAX_MS);
    path += `?timeoutMs=${timeout}`;
  }
  return { path, clientTimeoutMs: serverTimeoutMs + 5_000 };
}

async function handleSessions(args: string[]): Promise<void> {
  const action = args[0];

  if (action === "list") {
    const jwt = await authenticateCli();
    const headers = authHeaders(jwt);
    const url = configuration.serverUrl;

    const [localResp, remoteResp] = await Promise.all([
      axios.get(`${url}/api/sessions`, { headers, timeout: 10_000 }),
      axios
        .get(`${url}/api/federation/all-sessions`, {
          headers,
          timeout: 10_000,
        })
        .catch(() => ({ data: { sessions: [], nodes: [] } })),
    ]);

    writeStdout(
      JSON.stringify(
        {
          local: localResp.data.sessions,
          remote: remoteResp.data.sessions,
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "spawn") {
    const resolved = await resolveSpawnArgs(args);
    if ("error" in resolved) {
      console.error(resolved.error);
      process.exit(1);
    }
    const { dir, machineId, name, sessionRole, modelMode, parentSessionId } =
      resolved;

    const jwt = await authenticateCli();
    // Issue #1565: request the early-return spawn path (Option B). A new server
    // acks {type:"accepted", sessionId} immediately and we poll /api/sessions for
    // the session's lifecycleState (spawning → running/failed), surfacing a
    // "spawning…" affordance. An OLDER server ignores the flag and returns the
    // legacy synchronous {success|error}, which we print unchanged (R5 fallback).
    // #1559: keep the raised client timeout for the (now rarer) synchronous case
    // and reuse it as the overall poll ceiling.
    let resp: { data: { type?: string; sessionId?: string } };
    try {
      resp = await axios.post(
        `${configuration.serverUrl}/api/machines/${encodeURIComponent(machineId)}/spawn`,
        {
          directory: dir,
          earlyReturn: true,
          ...(name ? { name } : {}),
          ...(sessionRole ? { sessionRole } : {}),
          // Issue #2434: forward the Claude model-mode pin so the session
          // starts on the intended model atomically — no post-spawn
          // `POST /sessions/:id/model` correction. The spread-guard keeps an
          // omitted flag byte-identical to the pre-#2434 request body.
          ...(modelMode ? { modelMode } : {}),
          // Issue #2479: forward the parent link so the spawned session groups
          // under its spawner as a managed peer. May be a tag — server resolves.
          ...(parentSessionId ? { parentSessionId } : {}),
        },
        { headers: authHeaders(jwt), timeout: SPAWN_CLIENT_TIMEOUT_MS }
      );
    } catch (error) {
      if (isAxiosTimeout(error)) {
        // The daemon may still be completing the spawn — not necessarily a
        // failure (R3). Point the user at `sessions list` and exit non-zero.
        console.error(spawnTimeoutMessage(SPAWN_CLIENT_TIMEOUT_MS));
        process.exit(1);
      }
      // Genuine errors (server 4xx/5xx, connection refused) surface via the
      // existing outer catch in apiCommand.run, preserving its uniform
      // "status — body.error" formatting (R2 — real failures still surface).
      throw error;
    }

    if (resp.data?.type !== "accepted") {
      // Legacy synchronous server (R5 fallback): print the {success|error}
      // result exactly as before.
      writeStdout(JSON.stringify(resp.data, null, 2));
      return;
    }

    // Early-return path: poll /api/sessions for the spawn lifecycle. The
    // spawning placeholder (lifecycleState "spawning") flips to "running" (==
    // ready) when the real session — same id — reports in, or to "failed" on a
    // background spawn failure (R2). Reconciliation by exact id means at most one
    // record per id, so a non-"spawning" record is the terminal state.
    const sessionId = resp.data.sessionId;
    if (!sessionId) {
      // Defensive: an "accepted" response without a sessionId is a server bug.
      console.error("Spawn accepted but the server returned no sessionId.");
      process.exit(1);
    }
    console.error(`Spawning session ${sessionId}…`);
    const POLL_INTERVAL_MS = 2000;
    const deadline = Date.now() + SPAWN_CLIENT_TIMEOUT_MS;
    for (;;) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      let sessions: Array<{
        id?: string;
        tag?: string | null;
        lifecycleState?: string;
        metadata?: { summary?: { text?: string } | null } | null;
      }> = [];
      try {
        const listResp = await axios.get(
          `${configuration.serverUrl}/api/sessions`,
          { headers: authHeaders(jwt), timeout: 10_000 }
        );
        sessions = listResp.data?.sessions ?? [];
      } catch {
        // Transient list failure — keep polling until the deadline.
      }
      // Match by tag first (the real session's tag == the accepted hapiSessionId;
      // its id is a different happySessionId UUID) then id (the failed placeholder,
      // whose id == the hapiSessionId, since no real session reconciles it).
      const s = sessions.find(x => x.tag === sessionId || x.id === sessionId);
      const state = s?.lifecycleState;
      if (state === "failed") {
        // The placeholder's summary already reads "Spawn failed: <error>",
        // so print it as-is (avoids a doubled "Spawn failed: Spawn failed:").
        console.error(s?.metadata?.summary?.text ?? "Spawn failed.");
        process.exit(1);
      }
      if (s && state !== "spawning") {
        writeStdout(
          JSON.stringify(
            { type: "success", sessionId, lifecycleState: state ?? "running" },
            null,
            2
          )
        );
        return;
      }
      if (Date.now() >= deadline) {
        console.error(spawnTimeoutMessage(SPAWN_CLIENT_TIMEOUT_MS));
        process.exit(1);
      }
      console.error("  still spawning…");
    }
  }

  if (action === "send") {
    const sessionId = args[1];
    const text = args[2];
    if (!sessionId || !text) {
      console.error('Usage: hapi api sessions send <id> "<message>"');
      process.exit(1);
    }

    const jwt = await authenticateCli();
    // #3331 (Task 5, ruling D6(a)): attach the CLI's own session id so the server
    // classes this send `cli-api` (the origin discriminator) and runs the R3
    // self-send check. Unset HAPI_SESSION_ID → no header → the send degrades to
    // web-user (documented, NON-adversarial-proof).
    const sendHeaders: Record<string, string> = { ...authHeaders(jwt) };
    const hapiSessionId = process.env.HAPI_SESSION_ID;
    if (hapiSessionId) {
      sendHeaders["X-Hapi-Session-Id"] = hapiSessionId;
    }
    const resp = await axios.post(
      `${configuration.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      { text },
      { headers: sendHeaders, timeout: 30_000 }
    );
    writeStdout(JSON.stringify(resp.data, null, 2));
    return;
  }

  if (action === "messages") {
    const sessionId = args[1];
    if (!sessionId) {
      console.error("Usage: hapi api sessions messages <id>");
      process.exit(1);
    }

    const jwt = await authenticateCli();
    const resp = await axios.get(
      `${configuration.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      { headers: authHeaders(jwt), timeout: 10_000, params: { limit: 50 } }
    );
    writeStdout(JSON.stringify(resp.data, null, 2));
    return;
  }

  if (action === "capabilities") {
    // Issue #2418: enumerate a session's live RPC capabilities. Federated
    // sessions are proxied server-side to the owning node, so the CLI just GETs
    // the local endpoint like the sibling `messages` verb.
    const resolved = resolveCapabilitiesRequest(args);
    if ("error" in resolved) {
      console.error(resolved.error);
      process.exit(1);
    }

    const jwt = await authenticateCli();
    const resp = await axios.get(`${configuration.serverUrl}${resolved.path}`, {
      headers: authHeaders(jwt),
      timeout: 10_000,
    });
    writeStdout(JSON.stringify(resp.data, null, 2));
    return;
  }

  if (action === "wait-until") {
    // Issue #3816: block until a session reaches a state, or the timeout.
    // Same-node only; a session on another node answers 409.
    const resolved = resolveWaitUntilRequest(args);
    if ("error" in resolved) {
      console.error(resolved.error);
      process.exit(1);
    }

    const jwt = await authenticateCli();
    const resp = await axios.get(`${configuration.serverUrl}${resolved.path}`, {
      headers: authHeaders(jwt),
      timeout: resolved.clientTimeoutMs,
    });
    writeStdout(JSON.stringify(resp.data, null, 2));
    return;
  }

  if (action === "delete") {
    const sessionId = args[1];
    if (!sessionId) {
      console.error("Usage: hapi api sessions delete <id>");
      process.exit(1);
    }

    const jwt = await authenticateCli();
    const resp = await axios.delete(
      `${configuration.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
      { headers: authHeaders(jwt), timeout: 10_000 }
    );
    writeStdout(JSON.stringify(resp.data, null, 2));
    return;
  }

  if (action === "branch") {
    const sessionId = args[1];
    if (!sessionId) {
      console.error("Usage: hapi api sessions branch <id>");
      process.exit(1);
    }

    const jwt = await authenticateCli();
    const resp = await axios.post(
      `${configuration.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/branch`,
      {},
      { headers: authHeaders(jwt), timeout: 30_000 }
    );
    writeStdout(JSON.stringify(resp.data, null, 2));
    return;
  }

  if (action === "abort") {
    const sessionId = args[1];
    if (!sessionId) {
      console.error("Usage: hapi api sessions abort <id>");
      process.exit(1);
    }

    const jwt = await authenticateCli();
    const resp = await axios.post(
      `${configuration.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/abort`,
      {},
      { headers: authHeaders(jwt), timeout: 10_000 }
    );
    writeStdout(JSON.stringify(resp.data, null, 2));
    return;
  }

  if (action === "archive") {
    const sessionId = args[1];
    if (!sessionId) {
      console.error("Usage: hapi api sessions archive <id>");
      process.exit(1);
    }

    const jwt = await authenticateCli();
    const resp = await axios.post(
      `${configuration.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/archive`,
      {},
      { headers: authHeaders(jwt), timeout: 30_000 }
    );
    writeStdout(JSON.stringify(resp.data, null, 2));
    return;
  }

  if (isBulkSessionSubcommand(action)) {
    const ids = args.slice(1);
    if (ids.length === 0) {
      console.error(`Usage: hapi api sessions ${action} <id> [<id>...]`);
      process.exit(1);
    }

    const jwt = await authenticateCli();
    const results = await runBulkSessionsRequest(
      action,
      ids,
      async (path, body) =>
        (
          await axios.post(`${configuration.serverUrl}${path}`, body, {
            headers: authHeaders(jwt),
            timeout: BULK_SESSIONS_TIMEOUT_MS,
          })
        ).data
    );
    writeStdout(JSON.stringify(results, null, 2));
    // Scripts read the exit status: 1 when any session FAILED (a skipped
    // session — idle, already disconnected, still connected — is not a failure).
    if (bulkResultsHaveFailure(results)) {
      process.exit(1);
    }
    return;
  }

  printSessionsHelp();
}

/**
 * #3815 (operator ruling D1, 2026-10-01): three bulk subcommands, one route and
 * one risk tier each — Stop turn, Disconnect, Delete. There is deliberately no
 * compound disconnect-and-delete: a script runs `bulk-archive` and then
 * `bulk-delete`, two deliberate commands (the CLI analogue of the UI's two
 * dialogs; the delete route refuses sessions that are still connected).
 */
export const BULK_SESSION_SUBCOMMANDS = {
  "bulk-abort": "/api/sessions/bulk-abort",
  "bulk-archive": "/api/sessions/bulk-archive",
  "bulk-delete": "/api/sessions/bulk-delete",
} as const;

export type BulkSessionSubcommand = keyof typeof BULK_SESSION_SUBCOMMANDS;

/**
 * A session RPC may take 30 s (server `rpcGateway`) and each bulk route waits
 * for its whole fan-out, so this is wider than the single `abort`'s 10 s.
 */
const BULK_SESSIONS_TIMEOUT_MS = 60_000;

export function isBulkSessionSubcommand(
  action: string | undefined
): action is BulkSessionSubcommand {
  return (
    action !== undefined && Object.hasOwn(BULK_SESSION_SUBCOMMANDS, action)
  );
}

/** True when any session failed outright (skips are not failures). */
export function bulkResultsHaveFailure(results: BulkSessionResult): boolean {
  return results.some(r => !r.ok && r.skipped !== true);
}

function describeRequestError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const body = error.response?.data as { error?: string } | undefined;
    return `${status ?? "network error"} — ${body?.error ?? error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * POST `ids` to the subcommand's bulk route in chunks of the server's 100-id
 * cap and merge each chunk's per-session `results` in request order — the
 * same `BulkSessionResult` the web UI reports. A chunk whose request fails as a
 * whole yields one `{ id, ok: false, error }` per id and later chunks still
 * run. `post` is injected (cli/CLAUDE.md no-module-mock convention).
 */
export async function runBulkSessionsRequest(
  action: BulkSessionSubcommand,
  ids: readonly string[],
  post: (path: string, body: { ids: string[] }) => Promise<unknown>
): Promise<BulkSessionResult> {
  const path = BULK_SESSION_SUBCOMMANDS[action];
  const unique = Array.from(new Set(ids));
  const results: BulkSessionResult = [];
  for (let i = 0; i < unique.length; i += BULK_SESSION_MAX_IDS) {
    const chunk = unique.slice(i, i + BULK_SESSION_MAX_IDS);
    let data: unknown;
    try {
      data = await post(path, { ids: chunk });
    } catch (error) {
      const message = describeRequestError(error);
      results.push(...chunk.map(id => ({ id, ok: false, error: message })));
      continue;
    }
    const parsed = BulkSessionResultSchema.safeParse(
      (data as { results?: unknown } | null)?.results
    );
    if (!parsed.success) {
      // An older server answers bulk-delete with counts only: the request may
      // well have run, so say "unknown" rather than imply nothing happened.
      const message = `Outcome unknown: ${path} answered without per-session results (older server?)`;
      results.push(...chunk.map(id => ({ id, ok: false, error: message })));
      continue;
    }
    results.push(...parsed.data);
  }
  return results;
}

function printSessionsHelp(): void {
  console.log(`
${chalk.bold("hapi api sessions")} - Session management

${chalk.bold("Usage:")}
  hapi api sessions list                               List all sessions (local + federated)
  hapi api sessions spawn --dir <path> [opts]          Create a new session (defaults to local machine)
                          --machine <id>               Override local machine (optional)
                          --name <display-name>        Set session display name (optional)
                          --session-role <role>        Role-scoped @-include profile: pm|worker|researcher|closer|interactive (optional)
  hapi api sessions send <id> "<message>"              Send a message to a session
  hapi api sessions messages <id>                      Get message history
  hapi api sessions capabilities <id>                  List a session's live RPC capabilities (name + meta)
  hapi api sessions wait-until <id> --state <state>    Block until the session reaches a state, or the timeout
                          [--timeout <ms>]             Max wait in ms (default and ceiling 25000)
  hapi api sessions delete <id>                        Delete an inactive session
  hapi api sessions branch <id>                        Branch a session's conversation
  hapi api sessions abort <id>                         Interrupt the active query (session stays active)
  hapi api sessions archive <id>                       Kill an active session (required before delete)
  hapi api sessions bulk-abort <id> [<id>...]          Stop the turn of every listed session (sessions stay active)
  hapi api sessions bulk-archive <id> [<id>...]        Disconnect every listed session
  hapi api sessions bulk-delete <id> [<id>...]         Delete every listed session — disconnect first (bulk-archive)

${chalk.bold("Notes:")}
  - 'abort' interrupts the current Claude query but the session stays active
  - 'archive' kills the session process, marking it inactive (required before delete)
  - 'wait-until' states: idle, busy, blocked, rate-limited, completed, errored. It
    prints { ok: true, data: { result: "matched"|"timeout", state, sessionId } }.
    idle must hold 3 s, so a --timeout under 3000 never matches idle. After
    sending work, wait busy then idle. Same-node only: a session on another
    node answers 409 federation_unsupported, so poll it instead
  - 'bulk-*' run on each session's owning node and print one result per session
    ({ id, ok, skipped?, code?, error?, queued? }); a session that is not mid-turn
    is skipped by bulk-abort, and bulk-delete refuses a session that is still
    connected — run bulk-archive first. Delete is permanent. Exit status 1 when
    any session failed (skipped sessions do not count).
  - All commands output JSON to stdout
  - ${cliApiTokenSourcesNote()}
`);
}

async function handleSessionMetadata(args: string[]): Promise<void> {
  if (args[0] !== "spawn-roster") {
    printSessionMetadataHelp();
    return;
  }

  const req = resolveSpawnRosterRequest(args.slice(1));
  if ("error" in req) {
    console.error(req.error);
    process.exit(1);
  }

  const jwt = await authenticateCli();
  const headers = authHeaders(jwt);
  const url = `${configuration.serverUrl}${req.path}`;

  let resp: { data: unknown };
  if (req.method === "POST") {
    resp = await axios.post(url, req.body, { headers, timeout: 10_000 });
  } else if (req.method === "PATCH") {
    resp = await axios.patch(url, req.body, { headers, timeout: 10_000 });
  } else {
    resp = await axios.get(url, {
      headers,
      timeout: 10_000,
      params: req.query,
    });
  }
  writeStdout(JSON.stringify(resp.data, null, 2));
}

function printSessionMetadataHelp(): void {
  console.log(`
${chalk.bold("hapi api session-metadata spawn-roster")} - PM spawn-roster (issue #1936)

${chalk.bold("Usage:")}
  hapi api session-metadata spawn-roster register \\
      --completion-token <t> --pm-session-id <id> --node-id <id> --spawned-at-ms <n> \\
      [--hapi-session-id <id>] [--cc-session-id <id>] [--issue <n>] \\
      [--repo <r>] [--worktree-path <p>] [--status <s>]   Register a spawn (POST)
  hapi api session-metadata spawn-roster enrich <token> \\
      [--cc-session-id <id>] [--hapi-session-id <id>]      Enrich session ids (PATCH)
  hapi api session-metadata spawn-roster set-status <token> --status <s>   Transition status (PATCH)
  hapi api session-metadata spawn-roster query --pm-session-id <id> \\
      [--status <s>] [--all-nodes]                         Query roster (GET)

${chalk.bold("Status values:")} spawned | complete | re-driving

${chalk.bold("Notes:")}
  - All commands output JSON to stdout
  - ${cliApiTokenSourcesNote()}
  - --all-nodes queries the hub federation aggregate across all nodes
`);
}

/**
 * `hapi api initiatives <action>` — CRUD + roster/phase/reconcile over the
 * initiative object (issue #2156). One handler + `authenticateCli()`/`authHeaders()`
 * + `axios` against `/api/initiatives…`, mirroring handleSessionMetadata.
 */
async function handleInitiatives(args: string[]): Promise<void> {
  const action = args[0];
  if (!action || action === "help") {
    printInitiativesHelp();
    return;
  }

  const jwt = await authenticateCli();
  const headers = authHeaders(jwt);
  const base = `${configuration.serverUrl}/api/initiatives`;
  const jlog = (data: unknown): void =>
    writeStdout(JSON.stringify(data, null, 2));

  switch (action) {
    case "create": {
      const scope = parseFlag(args, "--scope");
      if (!scope) {
        console.error(
          'create requires --scope "<epic:|milestone:|project:>owner/repo#N"'
        );
        process.exit(1);
      }
      const body: Record<string, unknown> = { scopeRef: scope };
      const phase = parseFlag(args, "--phase");
      if (phase !== undefined) body.phase = phase;
      const budget = parseFlag(args, "--budget");
      if (budget !== undefined) body.tokenBudget = Number(budget);
      const resp = await axios.post(base, body, { headers, timeout: 10_000 });
      jlog(resp.data);
      return;
    }
    case "get": {
      const id = args[1];
      if (!id) {
        console.error("get requires <id>");
        process.exit(1);
      }
      const params: Record<string, string> = {};
      const limit = parseFlag(args, "--limit");
      if (limit !== undefined) params.limit = limit;
      const stale = parseFlag(args, "--stale-after-ms");
      if (stale !== undefined) params.staleAfterMs = stale;
      const resp = await axios.get(`${base}/${encodeURIComponent(id)}`, {
        headers,
        timeout: 10_000,
        params,
      });
      jlog(resp.data);
      return;
    }
    case "list": {
      const params: Record<string, string> = {};
      const scope = parseFlag(args, "--scope");
      if (scope !== undefined) params.scopeRef = scope;
      const phase = parseFlag(args, "--phase");
      if (phase !== undefined) params.phase = phase;
      const resp = await axios.get(base, { headers, timeout: 10_000, params });
      jlog(resp.data);
      return;
    }
    case "update": {
      const id = args[1];
      if (!id) {
        console.error("update requires <id>");
        process.exit(1);
      }
      const body: Record<string, unknown> = {};
      const phase = parseFlag(args, "--phase");
      if (phase !== undefined) body.phase = phase;
      const budget = parseFlag(args, "--budget");
      if (budget !== undefined) body.tokenBudget = Number(budget);
      const spent = parseFlag(args, "--spent");
      if (spent !== undefined) body.tokensSpent = Number(spent);
      const resp = await axios.patch(
        `${base}/${encodeURIComponent(id)}`,
        body,
        {
          headers,
          timeout: 10_000,
        }
      );
      jlog(resp.data);
      return;
    }
    case "delete": {
      const id = args[1];
      if (!id) {
        console.error("delete requires <id>");
        process.exit(1);
      }
      const resp = await axios.delete(`${base}/${encodeURIComponent(id)}`, {
        headers,
        timeout: 10_000,
      });
      jlog(resp.data);
      return;
    }
    case "attach": {
      const id = args[1];
      const session = parseFlag(args, "--session");
      if (!id || !session) {
        console.error("attach requires <id> --session <sessionId>");
        process.exit(1);
      }
      const resp = await axios.post(
        `${base}/${encodeURIComponent(id)}/sessions`,
        { sessionId: session },
        { headers, timeout: 10_000 }
      );
      jlog(resp.data);
      return;
    }
    case "detach": {
      const id = args[1];
      const session = parseFlag(args, "--session");
      if (!id || !session) {
        console.error("detach requires <id> --session <sessionId>");
        process.exit(1);
      }
      const resp = await axios.delete(
        `${base}/${encodeURIComponent(id)}/sessions/${encodeURIComponent(session)}`,
        { headers, timeout: 10_000 }
      );
      jlog(resp.data);
      return;
    }
    case "reconcile": {
      const id = args[1];
      if (!id) {
        console.error("reconcile requires <id>");
        process.exit(1);
      }
      const resp = await axios.post(
        `${base}/${encodeURIComponent(id)}/reconcile`,
        {},
        { headers, timeout: 10_000 }
      );
      jlog(resp.data);
      return;
    }
    case "events": {
      const id = args[1];
      if (!id) {
        console.error("events requires <id>");
        process.exit(1);
      }
      const params: Record<string, string> = {};
      const limit = parseFlag(args, "--limit");
      if (limit !== undefined) params.limit = limit;
      const resp = await axios.get(`${base}/${encodeURIComponent(id)}/events`, {
        headers,
        timeout: 10_000,
        params,
      });
      jlog(resp.data);
      return;
    }
    default:
      printInitiativesHelp();
  }
}

function printInitiativesHelp(): void {
  console.log(`
${chalk.bold("hapi api initiatives")} - Initiative object (issue #2156)

${chalk.bold("Usage:")}
  hapi api initiatives create --scope "<scheme>owner/repo#N" [--phase <p>] [--budget <n>]
                                                       Create an initiative (scheme = epic:|milestone:|project:)
  hapi api initiatives get <id> [--limit <n>] [--stale-after-ms <n>]
                                                       One-call read: roster + budget + phase + events (+ staleness)
  hapi api initiatives list [--scope <s>] [--phase <p>]   List initiatives
  hapi api initiatives update <id> [--phase <p>] [--budget <n>] [--spent <n>]
                                                       Update phase and/or budget (each appends an event)
  hapi api initiatives delete <id>                     Delete an initiative (+ its roster + events)
  hapi api initiatives attach <id> --session <sessionId>  Attach a session to the roster
  hapi api initiatives detach <id> --session <sessionId>  Detach a session from the roster
  hapi api initiatives reconcile <id>                  Mark reconciled against GitHub label truth
  hapi api initiatives events <id> [--limit <n>]       Read the append-only event log (newest first)

${chalk.bold("Phase values:")} planning | researching | implementing | reviewing | closing | done

${chalk.bold("Notes:")}
  - The initiative is a CACHE over GitHub label truth — reconcile-on-read, GitHub wins on conflict
  - The event log is append-only: there is no update/delete of a recorded event
  - All commands output JSON to stdout
  - ${cliApiTokenSourcesNote()}
`);
}

function printHelp(): void {
  console.log(`
${chalk.bold("hapi api")} - Hapimatic REST API CLI

${chalk.bold("Usage:")}
  hapi api sessions <action>   Session management (list, spawn, send, etc.)
  hapi api session-metadata spawn-roster <verb>  PM spawn-roster CRUD + federation aggregate
  hapi api initiatives <action>   Initiative CRUD + roster/phase/events
  hapi api auth                Authenticate and print JWT token
  hapi api version             Show server version
  hapi api error-logs <flags>  Query server error_logs (debugging)
  hapi api call <METHOD> <path> [--query k=v]...  Invoke a catalogued REST capability (tier-gated)

${chalk.bold("Run")} ${chalk.cyan("hapi api sessions")} ${chalk.bold("for session subcommand details.")}
`);
}

/**
 * The `hapi api <resource> <action>` surface, as a data table (issue #3744,
 * Sub-Issue D / R2, Task 1). The audit's `cli` denominator reads this to enumerate
 * the api sub-command pairs, and `apiCommand.run` VALIDATES the resource against it
 * before dispatch, so the table cannot silently drift from the handler branches: a
 * resource with a handler branch but no table entry short-circuits to help (i.e.
 * breaks), forcing the two to stay in sync.
 *
 * `auth`/`version` are ACTIONLESS resources (they consume no `<action>` — `auth`
 * exchanges a JWT, `version` reads `/api/version`), recorded with an empty action
 * list so the denominator is honest (each is one `hapi api <resource>` pair, no
 * `<action>`). `error-logs` is likewise flag-driven, not action-positional.
 */
export const API_RESOURCE_ACTIONS: Record<string, readonly string[]> = {
  sessions: [
    "list",
    "spawn",
    "send",
    "messages",
    "capabilities",
    "wait-until",
    "delete",
    "branch",
    "abort",
    "archive",
    "bulk-abort",
    "bulk-archive",
    "bulk-delete",
  ],
  "session-metadata": ["spawn-roster"],
  "error-logs": [],
  initiatives: [
    "create",
    "get",
    "list",
    "update",
    "delete",
    "attach",
    "detach",
    "reconcile",
    "events",
    "help",
  ],
  auth: [],
  version: [],
  // #3751 (Sub-Issue K): `hapi api call <METHOD> <path>` — an ACTIONLESS resource
  // (like auth/version). METHOD/path are positional args, not an `<action>`, so the
  // reverse-drift enumerator (#3745 R8) counts one `hapi api call` pair with no
  // action — no phantom coverage unit (grammar note 3751-18).
  call: [],
};

export const apiCommand: CommandDefinition = {
  name: "api",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    const resource = commandArgs[0];

    // #3744 R2 / Task 1: dispatch reads the resource/action table. An unknown
    // resource falls through to help exactly as before (behavior-preserving — the
    // former fallthrough at the end of this chain), but routing through the table
    // here makes it the audited source of truth: adding a resource branch without a
    // table entry would break that branch, so the two cannot diverge.
    if (resource !== undefined && !(resource in API_RESOURCE_ACTIONS)) {
      printHelp();
      return;
    }

    if (resource === "sessions") {
      try {
        await handleSessions(commandArgs.slice(1));
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const body = error.response?.data;
          console.error(
            `Error: ${status ?? "network error"} — ${body?.error ?? error.message}`
          );
        } else {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        process.exit(1);
      }
      return;
    }

    if (resource === "session-metadata") {
      try {
        await handleSessionMetadata(commandArgs.slice(1));
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const body = error.response?.data;
          console.error(
            `Error: ${status ?? "network error"} — ${body?.error ?? error.message}`
          );
        } else {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        process.exit(1);
      }
      return;
    }

    if (resource === "error-logs") {
      try {
        await handleErrorLogs(commandArgs.slice(1));
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const body = error.response?.data;
          console.error(
            `Error: ${status ?? "network error"} — ${body?.error ?? error.message}`
          );
        } else {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        process.exit(1);
      }
      return;
    }

    if (resource === "call") {
      try {
        await handleApiCall(commandArgs.slice(1));
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const body = error.response?.data;
          console.error(
            `Error: ${status ?? "network error"} — ${body?.error ?? error.message}`
          );
        } else {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        process.exit(1);
      }
      return;
    }

    if (resource === "initiatives") {
      try {
        await handleInitiatives(commandArgs.slice(1));
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const body = error.response?.data;
          console.error(
            `Error: ${status ?? "network error"} — ${body?.error ?? error.message}`
          );
        } else {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        process.exit(1);
      }
      return;
    }

    if (resource === "auth") {
      try {
        const jwt = await authenticateCli();
        writeStdout(jwt);
      } catch (error) {
        if (axios.isAxiosError(error)) {
          console.error(
            `Auth failed: ${error.response?.status ?? "network error"} — ${error.response?.data?.error ?? error.message}`
          );
        } else {
          console.error(
            `Auth failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        process.exit(1);
      }
      return;
    }

    if (resource === "version") {
      try {
        const resp = await axios.get(`${configuration.serverUrl}/api/version`, {
          timeout: 5_000,
        });
        writeStdout(JSON.stringify(resp.data, null, 2));
      } catch (error) {
        if (axios.isAxiosError(error)) {
          console.error(
            `Error: ${error.response?.status ?? "network error"} — ${error.message}`
          );
        } else {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        process.exit(1);
      }
      return;
    }

    printHelp();
  },
};
