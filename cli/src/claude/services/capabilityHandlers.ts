// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Testable factories for the readonly control capabilities migrated through the
 * capability registry in issue #2421 (epic #2416, Sub-Issue E).
 *
 * Mirrors the `mcpToggleService` factory pattern (#1101): the launcher
 * registration stays a thin `registerHandler(name, factory(...), META)` call
 * while the handler logic — especially `get-context-usage`'s idle
 * `no_active_query` branch (expert-review ruling 1B-27) — is unit-testable in
 * isolation. `getQuery` and `poll` are injected so a test drives the idle /
 * active / unavailable paths without instantiating the launcher or a socket.
 *
 * Issue #6170: `get-context-usage` also takes `{ detail: "full" }`, which
 * returns Claude Code's full breakdown instead of the five-field default.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { Query } from "../sdk";
import { SdkRequestError } from "../sdk/types";
import { logger } from "@/ui/logger";
import type {
  ContextUsageDetailPayload,
  ContextUsagePayload,
} from "../sdk/types";
import { pollMcpStatus } from "@/daemon/mcpStatusPoller";
import type { McpStatusUpdate } from "@hapi/protocol";

/**
 * Response shape for `get-context-usage`. A discriminated union so a consumer
 * branches on `ok`. With no Claude process attached, or on a failed read, the
 * `code` is a CLI-side response code that
 * the #2419 invoke gate forwards verbatim inside `data` (capabilityPolicy
 * 1B-14) — it is NOT a transport error. With `{ detail: "full" }` the `usage`
 * carries the full breakdown (#6170); otherwise exactly the five fields.
 */
export type GetContextUsageResponse =
  | { ok: true; usage: ContextUsagePayload | ContextUsageDetailPayload }
  | {
      ok: false;
      code: "no_active_query" | "context_usage_error";
      error: string;
      /** #6170: the SDK error code behind a `context_usage_error` (`timeout`,
       *  `claude_exited`, …) when there is one. */
      cause?: string;
    };

/**
 * The directories file paths in a full reply are shortened against (#6170):
 * the session's working directory, the user's home, and the account-config
 * directory (machine-global by default, per-instance under
 * `HAPI_ACCOUNT_CONFIG_SHARED=0`; `<accountConfigsDir>/<accountUuid>/` is an
 * isolated account's Claude config dir).
 */
export interface ContextUsagePathRoots {
  cwd: string;
  home: string;
  accountConfigsDir: string;
}

export interface GetContextUsageHandlerOptions {
  /**
   * Callback (not a value) so the handler reads the LATEST `Query` at each
   * invocation. `currentQuery` is null at registration time, set when a query
   * starts and cleared when it ends — closing over a value would capture the
   * null. Same rationale as mcpToggleService's `getQuery`.
   */
  getQuery: () => Query | null;
  /**
   * Issue #6170: roots for {@link toDisplayPath}. Required, so no registration
   * can return Claude Code's absolute home paths by leaving it out.
   */
  pathRoots: ContextUsagePathRoots;
}

/** Is `path` inside `root` (or equal to it), compared on segment boundaries? */
function relativeInside(root: string, path: string): string | null {
  if (!root || !isAbsolute(root)) return null;
  const rel = relative(root, path);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return rel;
}

/**
 * A root as given plus its resolved form: Claude Code reports paths through
 * its resolved working directory, so a root reached through a symlink must
 * match both spellings.
 */
function rootSpellings(root: string): string[] {
  if (!root || !isAbsolute(root)) return [];
  try {
    const real = realpathSync(root);
    return real === root ? [root] : [root, real];
  } catch {
    return [root];
  }
}

type DisplayRule = {
  root: string;
  render: (rel: string) => string | null;
};

/** Claude Code's folder name for a project path: each non-alphanumeric → "-". */
function encodeProjectPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Replace each path segment that is Claude Code's folder name for a project
 * under home (`~/.claude/projects/-home-<user>-…/`, where auto memory lives)
 * with `<project>`, because that name spells out the home path and username.
 */
function hideEncodedProjects(
  shown: string,
  roots: ContextUsagePathRoots
): string {
  const homes = rootSpellings(roots.home).map(encodeProjectPath);
  if (homes.length === 0) return shown;
  return shown
    .split("/")
    .map(segment =>
      homes.some(home => segment === home || segment.startsWith(`${home}-`))
        ? "<project>"
        : segment
    )
    .join("/");
}

/**
 * Issue #6170 (R12): shorten an absolute path for the full context reply, so no
 * absolute home path leaves the CLI. Under `<accountConfigsDir>/<uuid>/` →
 * `<account>/…`; under the working directory → relative (`CLAUDE.md`); under
 * the home directory → `~/…`; anything else (a managed policy under `/etc`, a
 * relative path) unchanged. The deepest matching root wins, so a session whose
 * working directory is the home directory still shows an isolated account's
 * memory file as `<account>/CLAUDE.md`, never with its account id. A project
 * folder named after a path under home becomes `<project>`.
 */
export function toDisplayPath(
  path: string,
  roots: ContextUsagePathRoots
): string {
  if (!isAbsolute(path)) return path;
  const rules: DisplayRule[] = [
    ...rootSpellings(roots.accountConfigsDir).map(root => ({
      root,
      render: (rel: string) => {
        const parts = rel.split(sep);
        return parts.length >= 2 && parts[0]
          ? ["<account>", ...parts.slice(1)].join("/")
          : null;
      },
    })),
    ...rootSpellings(roots.cwd).map(root => ({
      root,
      render: (rel: string) => (rel === "" ? "." : rel),
    })),
    ...rootSpellings(roots.home).map(root => ({
      root,
      render: (rel: string) => (rel === "" ? "~" : `~/${rel}`),
    })),
  ];
  let best: { depth: number; shown: string } | null = null;
  for (const rule of rules) {
    const rel = relativeInside(rule.root, path);
    if (rel === null) continue;
    const shown = rule.render(rel);
    if (shown === null) continue;
    if (!best || rule.root.length > best.depth) {
      best = { depth: rule.root.length, shown };
    }
  }
  return hideEncodedProjects(best ? best.shown : path, roots);
}

/** Rewrite the `path` of each entry in `list` (when it is an array of objects). */
function shortenPaths(list: unknown, roots: ContextUsagePathRoots): unknown {
  if (!Array.isArray(list)) return list;
  return list.map(entry => {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { path?: unknown }).path === "string"
    ) {
      const e = entry as { path: string };
      return { ...e, path: toDisplayPath(e.path, roots) };
    }
    return entry;
  });
}

/**
 * Shorten every `path` field in a full reply: memory files, and agents and
 * skills when the Claude Code version includes their paths.
 */
function shortenDetailPaths(
  usage: ContextUsageDetailPayload,
  roots: ContextUsagePathRoots
): ContextUsageDetailPayload {
  const out: ContextUsageDetailPayload = { ...usage };
  if ("memoryFiles" in usage) {
    out.memoryFiles = shortenPaths(usage.memoryFiles, roots);
  }
  if ("agents" in usage) out.agents = shortenPaths(usage.agents, roots);
  const skills = usage.skills;
  if (
    typeof skills === "object" &&
    skills !== null &&
    "skillFrontmatter" in skills
  ) {
    out.skills = {
      ...skills,
      skillFrontmatter: shortenPaths(
        (skills as { skillFrontmatter: unknown }).skillFrontmatter,
        roots
      ),
    };
  }
  return out;
}

/** True only for an explicit `{ detail: "full" }` (params arrive unvalidated). */
function wantsFullDetail(params: unknown): boolean {
  return (
    typeof params === "object" &&
    params !== null &&
    (params as { detail?: unknown }).detail === "full"
  );
}

/**
 * `get-context-usage` (readonly) — the session's live context-window usage.
 * Wraps the already-built `Query.getContextUsage()` (issue #1469); with
 * `{ detail: "full" }` wraps `Query.getContextUsageDetail()` instead and
 * shortens the reply's file paths (#6170). No Claude process attached
 * (`getQuery()` → null: before the first message, or after it exited) →
 * CLI-shaped `no_active_query`; a session idle between turns still answers. A
 * throw from the SDK call (including the
 * full-detail timeout) → `context_usage_error` carrying the underlying message.
 */
export function createGetContextUsageHandler(
  opts: GetContextUsageHandlerOptions
): (params?: unknown) => Promise<GetContextUsageResponse> {
  return async (params?: unknown): Promise<GetContextUsageResponse> => {
    const query = opts.getQuery();
    if (!query) {
      return {
        ok: false,
        code: "no_active_query",
        error:
          "No active Claude query — context usage is unavailable while the session is idle.",
      };
    }
    const full = wantsFullDetail(params);
    try {
      if (full) {
        const detail = await query.getContextUsageDetail();
        return { ok: true, usage: shortenDetailPaths(detail, opts.pathRoots) };
      }
      const usage = await query.getContextUsage();
      return { ok: true, usage };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof SdkRequestError && err.code ? err.code : undefined;
      logger.debug(
        `[get-context-usage] ${full ? "full" : "summary"} read failed: ${error}${cause ? ` (${cause})` : ""}`
      );
      return {
        ok: false,
        code: "context_usage_error",
        error,
        ...(cause ? { cause } : {}),
      };
    }
  };
}

/**
 * Response shape for `mcp-status`.
 */
export type McpStatusResponse =
  | { ok: true; status: McpStatusUpdate }
  | { ok: false; code: "mcp_status_unavailable"; error: string };

export interface McpStatusHandlerOptions {
  /** The session's working directory — the cwd `claude mcp list` runs in. */
  sessionPath: string;
  /** Injectable for tests; defaults to the real `pollMcpStatus`. */
  poll?: (cwd?: string) => Promise<McpStatusUpdate | null>;
}

/**
 * `mcp-status` (readonly) — the session's live MCP server status, read from the
 * EXISTING live source (`pollMcpStatus` → `claude mcp list` in the session
 * cwd). No Query control_request bridge: no `mcp_status` subtype exists in
 * `sdk/types.ts` (expert-review ruling 1B-28).
 */
export function createMcpStatusHandler(
  opts: McpStatusHandlerOptions
): () => Promise<McpStatusResponse> {
  const poll = opts.poll ?? pollMcpStatus;
  return async (): Promise<McpStatusResponse> => {
    const status = await poll(opts.sessionPath);
    if (!status) {
      return {
        ok: false,
        code: "mcp_status_unavailable",
        error: "MCP status could not be read for this session.",
      };
    }
    return { ok: true, status };
  };
}
