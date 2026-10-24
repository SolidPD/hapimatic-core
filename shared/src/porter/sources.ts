// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — multi-source discovery table (epic #3445 Sub C,
 * issue #3448, K7/K10).
 *
 * The one-paste export probes the GLOBAL MCP config of every supported source —
 * Claude Code, Cursor, Claude Desktop, Codex (#5169) — and records what it found. This module
 * is the SINGLE table both emitters (`exportScript.ts` bash, its
 * `exportScriptPowerShell.ts` twin), the server grouping (`commitSelection.ts`),
 * and the web review panel (via `@hapi/protocol`) read from, so the source id
 * set, display labels, dedupe precedence, and the `sources[]` manifest record
 * shape cannot drift across those four surfaces [K7, 1B#31].
 *
 * NODE-FREE (R7): like every non-test module under `shared/src/porter`, this file
 * imports no `node:*` builtin — it holds constants + zod schemas. The candidate
 * config-file locations are held DIALECT-NEUTRAL ({@link SourceConfigPath}) and
 * each emitter renders its own shell dialect from them (the same neutral-source +
 * per-dialect-adapter split `exportShared.ts` uses for regexes). The
 * `manifest.test.ts` R7 guard fails the build if a `node:` import were added.
 */
import { z } from "zod";

/**
 * The configuration sources the one-paste export discovers, in DEDUPE PRECEDENCE
 * order (index 0 wins a name collision — see {@link SOURCE_PRECEDENCE}). Narrowed
 * `as const` so {@link PorterSourceId} is the literal union and the manifest
 * `source?` tag / `SourceRecordSchema.id` enum stay in lockstep.
 */
export const PORTER_SOURCE_IDS = [
  "claude-code",
  "cursor",
  "claude-desktop",
  // #5169 (D5): appended LAST, so no existing dedupe outcome changes.
  "codex",
] as const;

/** One discoverable configuration source (`"claude-code" | "cursor" | "claude-desktop" | "codex"`). */
export type PorterSourceId = (typeof PORTER_SOURCE_IDS)[number];

/** Human-facing label per source — the caption the review cards render. */
export const PORTER_SOURCE_LABELS: Record<PorterSourceId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
};

/**
 * Cross-source MCP-name dedupe precedence [D4(a)]. The export concatenates each
 * source's servers in THIS order and `unique_by(.name)` keeps the FIRST — so a
 * server named `github` present in both Claude Code and Cursor lands as the
 * Claude Code definition, and Cursor's copy is dropped and counted in
 * `cursor.counts.duplicates`. The lower-precedence definition is never offered.
 */
export const SOURCE_PRECEDENCE: readonly PorterSourceId[] = PORTER_SOURCE_IDS;

/**
 * The base directory a candidate config path resolves against. Rendered
 * per-dialect by each emitter: `home` → bash `$HOME` / PowerShell
 * `$env:USERPROFILE`; `appdata` → bash SKIP (no POSIX equivalent) / PowerShell
 * `$env:APPDATA`; `xdg-config` → bash `${XDG_CONFIG_HOME:-$HOME/.config}` /
 * PowerShell `$env:XDG_CONFIG_HOME` (else `$HOME/.config`).
 */
export type PorterPathBase = "home" | "appdata" | "xdg-config";

/** One candidate GLOBAL MCP config file, dialect-neutral (each emitter renders `base`). */
export interface SourceConfigPath {
  base: PorterPathBase;
  /** Forward-slash path segments under {@link base}. */
  segments: string;
}

/**
 * Candidate GLOBAL MCP config files for the NON-Claude-Code sources, probed by
 * FILE EXISTENCE in order (FIRST found wins), never `uname`-gated — so a Linux CI
 * can seed a macOS-style path to exercise the found branch [1B#38]. `claude-code`
 * is intentionally absent: its MCP definitions come from the host `~/.claude.json`
 * (each emitter's Step 5), and its `found` flag tracks the `~/.claude` config
 * root, not a file here [1B#34]. `codex` is absent for the same kind of reason
 * (#5169): its home is a folder (`$CODEX_HOME`, else `~/.codex`) that its own
 * block in each emitter probes, and its `config.toml` is read by a TOML subset
 * reader, not by the JSON projection a file here feeds (`codexSource.ts`).
 *
 * Desktop order — Windows `%APPDATA%\Claude` first, then the macOS
 * `~/Library/Application Support/Claude` location, then the Linux community XDG
 * path — so each OS's real location is probed before the fallbacks, while the two
 * emitters still converge on the SAME file for any given seed (bash skips the
 * `appdata` candidate; PowerShell skips it when `$env:APPDATA` is empty, i.e. on
 * Linux-pwsh) [1B#40].
 */
export const SOURCE_CONFIG_PATHS: Record<
  Exclude<PorterSourceId, "claude-code" | "codex">,
  readonly SourceConfigPath[]
> = {
  cursor: [{ base: "home", segments: ".cursor/mcp.json" }],
  "claude-desktop": [
    { base: "appdata", segments: "Claude/claude_desktop_config.json" },
    {
      base: "home",
      segments: "Library/Application Support/Claude/claude_desktop_config.json",
    },
    { base: "xdg-config", segments: "Claude/claude_desktop_config.json" },
  ],
};

/**
 * One source's export-time discovery record — the `sources[]` manifest element
 * [K10]. `found` distinguishes present (config root / file existed) from
 * found-but-empty; `counts.mcpServers` is the server count LANDED for that source
 * after cross-source dedupe, and `counts.duplicates` is the count DROPPED to a
 * higher-precedence source. Metadata ONLY — importable entries stay in the
 * top-level `mcpServers[]` with an optional `source` tag [D3(a)].
 */
export const SourceRecordSchema = z.object({
  id: z.enum(PORTER_SOURCE_IDS),
  found: z.boolean(),
  counts: z.object({
    mcpServers: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
  }),
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
