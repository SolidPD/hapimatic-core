// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hapi api sessions bulk-abort | bulk-archive | bulk-delete` (#3815): the
 * request runner behind the three bulk subcommands. Moved out of `api.ts`
 * unchanged by #6681 (that file sits at the 1,500-line lint cap), which added
 * bulk-delete's resend of `retry` ids.
 */
import axios from "axios";
import {
  BULK_DELETE_BUDGET_MS,
  BULK_SESSION_MAX_IDS,
  BulkSessionResultSchema,
  type BulkSessionResult,
  type BulkSessionResultItem,
} from "@hapi/protocol/bulkSessionResult";

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
export const BULK_SESSIONS_TIMEOUT_MS = 60_000;

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

/** One pass: every id once, in chunks of the server's cap. */
async function postInChunks(
  path: string,
  ids: readonly string[],
  post: (path: string, body: { ids: string[] }) => Promise<unknown>
): Promise<BulkSessionResultItem[]> {
  const results: BulkSessionResultItem[] = [];
  for (let i = 0; i < ids.length; i += BULK_SESSION_MAX_IDS) {
    const chunk = ids.slice(i, i + BULK_SESSION_MAX_IDS);
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

/**
 * POST `ids` to the subcommand's bulk route in chunks of the server's 100-id
 * cap and merge each chunk's per-session `results` in request order — the
 * same `BulkSessionResult` the web UI reports. A chunk whose request fails as a
 * whole yields one `{ id, ok: false, error }` per id and later chunks still
 * run. `post` is injected (cli/CLAUDE.md no-module-mock convention).
 *
 * #6681 (R13; PM ruling C6): for bulk-delete, the ids the hub answered
 * `retry` (never sent: their node was busy) are sent again, pass after pass,
 * while the previous pass deleted at least one session and
 * BULK_DELETE_BUDGET_MS has not passed since the first request. A pass that
 * deleted none ends the resend (the web's round loop waits and goes on; the
 * CLI does not). A `pending` id was sent and is never sent again. Each id's
 * last answer is the one printed.
 */
export async function runBulkSessionsRequest(
  action: BulkSessionSubcommand,
  ids: readonly string[],
  post: (path: string, body: { ids: string[] }) => Promise<unknown>,
  options?: { now?: () => number }
): Promise<BulkSessionResult> {
  const path = BULK_SESSION_SUBCOMMANDS[action];
  const now = options?.now ?? (() => performance.now());
  const unique = Array.from(new Set(ids));
  const started = now();
  const byId = new Map<string, BulkSessionResultItem>();
  for (let pass = unique; pass.length > 0; ) {
    const answers = await postInChunks(path, pass, post);
    for (const r of answers) byId.set(r.id, r);
    if (action !== "bulk-delete") break;
    const deletedSome = answers.some(r => r.ok);
    pass = answers.filter(r => r.retry === true).map(r => r.id);
    if (!deletedSome || now() - started >= BULK_DELETE_BUDGET_MS) break;
  }
  return unique.map(
    id => byId.get(id) ?? { id, ok: false, error: "No answer for this session" }
  );
}
