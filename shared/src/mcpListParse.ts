// SPDX-License-Identifier: AGPL-3.0-only
import type { McpServerStatus } from "./schemas";

/**
 * Single tolerant parser for `claude mcp list` output (hapimatic-private#2142).
 *
 * **Why this module exists.** The `claude mcp list` status line was parsed by
 * TWO hardcoded-glyph copies — `cli/src/daemon/mcpStatusPoller.ts` and
 * `server/src/utils/mcpPoller.ts` — that were already drifting (different poll
 * timeouts) and both baked the exact status glyph into the line regex
 * (`/…-\s+(check|cross|!)\s+…/`). Claude Code then changed its glyphs from the
 * LIGHT check/cross (U+2713 / U+2717) to the HEAVY variants (U+2714 / U+2718) —
 * so every connected and every failed line stopped matching and was SILENTLY
 * DROPPED, collapsing the selector to only the `!` needs-auth lines ("only 1–2
 * servers, stuck needs-auth" — the #2142 symptom).
 *
 * **The two structural fixes.**
 *  1. **Glyph-in-status-field, not glyph-in-regex.** The line pattern matches
 *     `name: url - <statusPortion>` and the status is classified from the
 *     LEADING glyph of `<statusPortion>`. A future glyph change degrades a
 *     server to `status:"unknown"` (visible, unclassified) instead of dropping
 *     it — the "1–2 servers" collapse becomes structurally impossible.
 *  2. **Never-drop.** Any non-empty, non-banner line yields a status entry;
 *     lines with no server shape are surfaced to the caller (`unparsedLines`)
 *     so the poll can log a drift signal instead of failing invisibly.
 *
 * Both the legacy LIGHT glyphs (regression fixtures) and the current HEAVY
 * glyphs are recognized, plus `⏸` (`pending_approval`, tolerating an optional
 * U+FE0F variation selector) for project-scoped servers awaiting approval.
 */

/** ANSI CSI escape sequences (ESC `[` … letter), stripped before matching —
 *  defensive: the CLI is usually plain when piped, but a future `--color`
 *  default must not silently break the parser. The `\x1b` prefix is required so
 *  legitimate bracketed text in a name/url is never stripped. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Unicode variation selector — `⏸` can arrive as `⏸` or `⏸️` (+U+FE0F). */
const VARIATION_SELECTOR = "️";

/**
 * Leading-glyph → status. Accepts BOTH light (legacy) and heavy (current)
 * check/cross variants so the parser is version-agnostic across Claude Code
 * releases. `!` = needs-auth (unchanged across versions); `⏸` = a
 * project-scoped server awaiting approval (Claude Code v2.1.154+).
 */
const GLYPH_STATUS: Record<string, McpServerStatus["status"]> = {
  "✓": "connected", // ✓ light check (legacy)
  "✔": "connected", // ✔ heavy check (v2.1.x — current)
  "✗": "failed", // ✗ light ballot X (legacy)
  "✘": "failed", // ✘ heavy ballot X (v2.1.x — current)
  "!": "needs_auth",
  "⏸": "pending_approval", // ⏸ pause
};

/**
 * Banner / non-server lines to skip (not servers, not drift). Matched
 * case-insensitively against the trimmed line. `Checking MCP server health…`
 * is the header; `No MCP servers` is the empty-config footer.
 */
const BANNER_PATTERNS = [/^checking\b/i, /^no mcp servers\b/i];

/** Structured server line: `name: url - <statusPortion>` (loose — the glyph is
 *  NOT in the regex, so a glyph change cannot break the match). */
const SERVER_LINE = /^(.+?):\s+(.+?)\s+-\s+(.+)$/;
/** Fallback: `name: <rest>` (a server line whose ` - ` status separator drifted). */
const NAME_ONLY_LINE = /^(.+?):\s+(.+)$/;

/** Result of {@link parseMcpList}: the parsed servers plus the raw lines that
 *  did not match a server shape (for drift-count logging by the caller). */
export interface McpListParseResult {
  servers: McpServerStatus[];
  /** Non-empty, non-banner lines that matched no server shape at all. */
  unparsedLines: string[];
}

/** Classify a `<statusPortion>` string into a status + human statusText.
 *  The leading glyph (tolerating a trailing U+FE0F) selects the status; an
 *  unrecognized glyph yields `"unknown"` with the full portion as statusText. */
function classifyStatusPortion(statusPortion: string): {
  status: McpServerStatus["status"];
  statusText: string;
} {
  const portion = statusPortion.trim();
  // Codepoint-safe first char (Array.from iterates by codepoint).
  const firstGlyph = Array.from(portion)[0] ?? "";
  const status = GLYPH_STATUS[firstGlyph];
  if (status) {
    // Drop the leading glyph and an optional variation selector, then trim.
    let rest = portion.slice(firstGlyph.length);
    if (rest.startsWith(VARIATION_SELECTOR)) rest = rest.slice(1);
    return { status, statusText: rest.trim() || portion };
  }
  return { status: "unknown", statusText: portion };
}

function isBanner(line: string): boolean {
  return BANNER_PATTERNS.some(p => p.test(line));
}

/**
 * Parse `claude mcp list` stdout into servers, never dropping a server line.
 *
 * - Empty and banner lines are skipped.
 * - `name: url - <status>` → classified by the leading status glyph.
 * - `name: <rest>` (drifted separator) → a `status:"unknown"` server so it is
 *   still visible.
 * - Anything else non-empty/non-banner → recorded in `unparsedLines` for the
 *   caller to log (a drift signal), not silently discarded.
 */
export function parseMcpList(stdout: string): McpListParseResult {
  const servers: McpServerStatus[] = [];
  const unparsedLines: string[] = [];

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(ANSI_PATTERN, "").trim();
    if (!line || isBanner(line)) continue;

    const m = line.match(SERVER_LINE);
    if (m) {
      const [, name, url, statusPortion] = m;
      const { status, statusText } = classifyStatusPortion(statusPortion);
      servers.push({
        name: name.trim(),
        url: url.trim(),
        status,
        statusText,
      });
      continue;
    }

    // No ` - <status>` separator, but still a `name: value` shape — a server
    // whose status column drifted. Surface it as unknown rather than drop it.
    const nameOnly = line.match(NAME_ONLY_LINE);
    if (nameOnly) {
      const [, name, rest] = nameOnly;
      servers.push({
        name: name.trim(),
        url: rest.trim(),
        status: "unknown",
        statusText: rest.trim(),
      });
      continue;
    }

    // Not a server shape at all — record for drift logging (do not fabricate a
    // server from a line with no name/value structure).
    unparsedLines.push(line);
  }

  return { servers, unparsedLines };
}

const HOSTED_PREFIX = "claude.ai ";

/**
 * Reclassify Anthropic-hosted connectors (the `claude.ai ` display-name prefix)
 * from `connected` to `hosted`. Pure; shared by both pollers (was duplicated).
 */
export function classifyHostedServers(
  servers: McpServerStatus[]
): McpServerStatus[] {
  return servers.map(s =>
    s.name.startsWith(HOSTED_PREFIX) && s.status === "connected"
      ? { ...s, status: "hosted" as const }
      : s
  );
}
