// SPDX-License-Identifier: AGPL-3.0-only
import axios from "axios";
import { configuration } from "@/configuration";
import { writeStdout } from "@/utils/stdout";
import { authenticateCli } from "./cliAuth";

/**
 * `hapi api call <METHOD> <path> [--json <body>] [--query k=v]... [--node <id>]`
 * (issue #3751,
 * epic #3740 Sub-Issue K / R2). A thin client over the server's tier-gated generic
 * REST invoker (`POST /api/capabilities/call`): the SERVER is the single
 * enforcement point (the tier gate, the resolution, the credential rule all live
 * there). This verb authenticates as the CALLER (a JWT minted from the cliApiToken,
 * exactly as `hapi api`'s other verbs do) and copies that identity through — it
 * NEVER resolves auth from the catalog entry (R2).
 *
 * `--node` is HELD (R6): a cross-node call needs a receiver identity design that is
 * not yet written, so it returns `{ok:false, code:"node_unsupported"}` rather than
 * silently executing locally.
 *
 * `--query k=v` (repeatable, #4011) builds the invoker's `query` object, which the
 * server appends to the dispatch URL only after gating the bare path — so a GET
 * capability's query parameters never go in `<path>` (a `?` there is refused).
 *
 * `hapi api call` is registered as an ACTIONLESS resource in `API_RESOURCE_ACTIONS`
 * (like `auth`/`version`), so `<METHOD> <path>` are positional args, not an
 * `<action>` — this keeps the `hapi api <resource> <action>` grammar (#3745 R8 /
 * grammar note 3751-18) with no phantom coverage unit.
 */

/** The parsed result of `hapi api call` args — pure, exported for unit tests. */
export type ResolvedApiCall =
  | { error: string }
  | {
      method: string;
      path: string;
      body?: unknown;
      query?: Record<string, string>;
      node?: string;
    };

/**
 * Parse `<METHOD> <path> [--json <body>] [--query k=v]... [--node <id>]` into a
 * request descriptor. Flags may interleave with the two positionals. No I/O.
 */
export function resolveApiCall(args: string[]): ResolvedApiCall {
  let jsonBody: string | undefined;
  let node: string | undefined;
  let query: Record<string, string> | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      jsonBody = args[++i];
    } else if (a === "--node") {
      node = args[++i];
    } else if (a === "--query") {
      const pair = args[++i];
      const eq = pair === undefined ? -1 : pair.indexOf("=");
      if (eq < 1) return { error: "--query must be key=value" };
      const key = pair.slice(0, eq);
      query ??= {};
      if (Object.hasOwn(query, key)) {
        return { error: `--query ${key} given more than once` };
      }
      query[key] = pair.slice(eq + 1);
    } else {
      positional.push(a);
    }
  }
  const method = positional[0];
  const path = positional[1];
  if (!method || !path) {
    return {
      error:
        "Usage: hapi api call <METHOD> <path> [--json <body>] [--query k=v]... [--node <id>]",
    };
  }
  let body: unknown;
  if (jsonBody !== undefined) {
    try {
      body = JSON.parse(jsonBody);
    } catch {
      return { error: "--json must be valid JSON" };
    }
  }
  return { method: method.toUpperCase(), path, body, query, node };
}

/** The `{ok:false, code:"node_unsupported"}` envelope for a HELD federation call
 *  (R6) — exported so the test asserts it without a network round-trip. */
export const NODE_UNSUPPORTED = {
  ok: false as const,
  error:
    "Cross-node capability calls are not yet supported (the federation receiver is held pending an identity design).",
  code: "node_unsupported" as const,
};

/** Execute `hapi api call`. Prints the `{ok, data|error, code}` envelope to stdout;
 *  sets a non-zero exit code on any `ok:false` / non-2xx outcome. */
export async function handleApiCall(args: string[]): Promise<void> {
  const resolved = resolveApiCall(args);
  if ("error" in resolved) {
    console.error(resolved.error);
    process.exit(1);
  }

  // R6: the federation leg is held pending an identity design — never a silent
  // local execution for a `--node` request.
  if (resolved.node) {
    writeStdout(JSON.stringify(NODE_UNSUPPORTED));
    process.exitCode = 1;
    return;
  }

  const jwt = await authenticateCli();
  const resp = await axios.post(
    `${configuration.serverUrl}/api/capabilities/call`,
    {
      method: resolved.method,
      path: resolved.path,
      body: resolved.body,
      query: resolved.query,
    },
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
      // Relay the server envelope verbatim for every status (the gate's 403 /
      // 400 / 409 are load-bearing) instead of throwing on non-2xx.
      validateStatus: () => true,
    }
  );
  writeStdout(
    typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data)
  );
  const okFlag =
    resp.data && typeof resp.data === "object"
      ? (resp.data as { ok?: unknown }).ok
      : undefined;
  if (resp.status >= 400 || okFlag === false) {
    process.exitCode = 1;
  }
}
