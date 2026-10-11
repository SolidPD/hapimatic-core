// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL hook-projection transpiler core (issue #3123, epic #3117 Sub-Issue H).
 *
 * Tier 1 of the enforcement ladder (native hook → message-layer #3124 →
 * deterministic script step → server-side gate). A canonical Claude-shape hook
 * config, authored ONCE (ruling D5), is transpiled here into each foreign CLI's
 * native hook dialect — a taxonomy-preserving REMAP + per-dialect registration
 * wrapper, NOT a semantic translation (KD2). The guard SCRIPTS stay CLI-neutral
 * (bash + gh + jq); only the registration wrapper differs per dialect (R4:
 * "one script, N registration wrappers").
 *
 * PURE (no I/O) so it is table-testable. The materializer stage (`index.ts`)
 * wires this into #3122's KD6 `ProjectionStage` seam and does the disk writes.
 *
 * Canonical source of truth for the hook shape: `cli/src/claude/utils/
 * generateHookSettings.ts` (the on-disk `.claude/settings.json` `hooks` block).
 * KD1: the canonical event enum is the FULL Claude taxonomy INCLUDING
 * `Notification` — a model that omits it cannot represent Hapimatic's own
 * #1653 frozen-session guard and would drop it at the type level (violating R3).
 */
import { createHash } from "node:crypto";
import type { HookCoverageRecord } from "../types";
import { emitCodexHooks, CODEX_SUPPORTED_EVENTS } from "./dialects/codex";
import { emitGeminiHooks, GEMINI_SUPPORTED_EVENTS } from "./dialects/gemini";
import {
  emitOpencodeShim,
  OPENCODE_SUPPORTED_EVENTS,
} from "./dialects/opencodeShim";

// The R7 coverage record lives in the core provenance types (`../types`) so the
// provenance schema stays in one place (#3130 unifies it). Re-exported here so
// dialect emitters + tests keep importing the hook types from one module.
export type { HookCoverageRecord } from "../types";

/**
 * The canonical hook event enum — the FULL Claude taxonomy (KD1). `Notification`
 * is load-bearing (the #1653 frozen-session guard) and MUST be representable.
 * `generateHookSettings.ts` registers `SessionStart` / `UserPromptSubmit` /
 * `Stop` / `Notification`; `PreToolUse` / `PostToolUse` complete the taxonomy the
 * foreign dialects clone.
 */
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "Notification",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * A single canonical hook, the FLATTENED form of one `.claude/settings.json`
 * hook entry (KD1). The on-disk nested shape `{ hooks: { <event>: [{ matcher,
 * hooks: [{ type, command, timeout }] }] } }` flattens to one `CanonicalHook`
 * per (event, matcher, command) tuple.
 */
export interface CanonicalHook {
  event: HookEvent;
  /** Tool matcher; `""` when the event has no matcher (KD6 normalization). */
  matcher: string;
  /** The CLI-neutral guard-script invocation. All dialects reference this SAME
   * command verbatim (R4) — the transpiler never rewrites it per dialect. */
  command: string;
  /** The on-disk hook type — only `"command"` exists in the reference shape. */
  type: "command";
  /** Optional timeout in ms (present in `.claude/settings.json`, e.g. 5000). */
  timeout?: number;
  /** Stable guard id from the canonical guard set (companion rp1-home epic);
   * the third component of the KD6 dedupKey. */
  canonicalGuardId: string;
}

/**
 * The dialect ids — MUST equal the #3118 manifest `hooks.dialectId` strings
 * (Task 1; the manifest is the vocabulary source). `claude-settings-json` is the
 * canon itself (identity passthrough); the other three are the projection
 * targets.
 */
export const HOOK_DIALECT_IDS = [
  "claude-settings-json",
  "codex-hooks-json",
  "gemini-hooks-json",
  "opencode-plugin-js",
] as const;
export type HookDialect = (typeof HOOK_DIALECT_IDS)[number];

/** One file to materialize into the per-session config home. */
export interface DialectFile {
  /** Config-home-relative path (e.g. `.codex/hooks.json`). */
  path: string;
  content: string;
}

/** The result of transpiling a canonical hook set into ONE dialect. */
export interface DialectOutput {
  dialect: HookDialect;
  /** `true` when the dialect registers hooks in the CLI's native taxonomy;
   * `false` for the OpenCode plugin-shim. */
  native: boolean;
  /** Registration wrapper file(s) to write into the config home. */
  files: DialectFile[];
  /** One coverage record per canonical hook (both projected and degraded). */
  coverage: HookCoverageRecord[];
}

/** The Claude-taxonomy nested `hooks` object shape (shared by the native
 * dialects — claude/codex/gemini all clone it). */
export interface ClaudeHookMatcherEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}
export type ClaudeHookTaxonomy = Record<string, ClaudeHookMatcherEntry[]>;

/**
 * KD6 dedup key — `sha256(event + "\n" + matcher + "\n" + canonicalGuardId)`,
 * lowercase hex. `matcher = ""` when absent (normalized by the caller). The one
 * normative implementation; #3124 reproduces it byte-for-byte.
 */
export function computeHookDedupKey(
  event: string,
  matcher: string,
  canonicalGuardId: string
): string {
  return createHash("sha256")
    .update(`${event}\n${matcher}\n${canonicalGuardId}`)
    .digest("hex");
}

/**
 * The base coverage fields every record shares — `{event, matcher, dedupKey}`
 * with the KD6 dedupKey computed once. Extracted so the three
 * record-construction sites (transpile's projected + degraded maps, and the
 * stage's `degradeAll`) keep the dedupKey formula single-sourced — a change to
 * the R7 record shape or the KD6 formula now touches ONE place, not three.
 */
export function baseCoverageRecord(
  hook: CanonicalHook
): Pick<HookCoverageRecord, "event" | "matcher" | "dedupKey"> {
  return {
    event: hook.event,
    matcher: hook.matcher,
    dedupKey: computeHookDedupKey(
      hook.event,
      hook.matcher,
      hook.canonicalGuardId
    ),
  };
}

/**
 * Build the nested Claude-taxonomy `hooks` object from a flat canonical set,
 * grouping by event then by matcher. Shared by the native dialects (claude
 * identity, codex, gemini), which all clone this shape.
 */
export function buildClaudeTaxonomy(
  hooks: CanonicalHook[]
): ClaudeHookTaxonomy {
  const taxonomy: ClaudeHookTaxonomy = {};
  for (const hook of hooks) {
    const entries = (taxonomy[hook.event] ??= []);
    let entry = entries.find(e => e.matcher === hook.matcher);
    if (!entry) {
      entry = { matcher: hook.matcher, hooks: [] };
      entries.push(entry);
    }
    const cmd: { type: "command"; command: string; timeout?: number } = {
      type: hook.type,
      command: hook.command,
    };
    if (hook.timeout !== undefined) {
      cmd.timeout = hook.timeout;
    }
    entry.hooks.push(cmd);
  }
  return taxonomy;
}

/**
 * The static per-dialect support baseline (the epic #3117 2026-08 survey). An
 * event outside a dialect's set cannot be registered in that CLI's taxonomy and
 * DEGRADES to the script-step tier (never silently dropped — R3). Refining this
 * against the installed CLI version (`manifest.verifiedAgainst`, OR2) is a
 * documented follow-up; the static baseline is honest to the survey and
 * exercises R3 per-event.
 */
const DIALECT_SUPPORTED_EVENTS: Record<HookDialect, ReadonlySet<HookEvent>> = {
  "claude-settings-json": new Set(HOOK_EVENTS),
  "codex-hooks-json": CODEX_SUPPORTED_EVENTS,
  "gemini-hooks-json": GEMINI_SUPPORTED_EVENTS,
  "opencode-plugin-js": OPENCODE_SUPPORTED_EVENTS,
};

/** Whether a dialect registers in the CLI's own taxonomy (`true`) or via a JS
 * plugin-shim (`false`, OpenCode only — KD4). */
const DIALECT_IS_NATIVE: Record<HookDialect, boolean> = {
  "claude-settings-json": true,
  "codex-hooks-json": true,
  "gemini-hooks-json": true,
  "opencode-plugin-js": false,
};

/**
 * Transpile a canonical hook set into ONE dialect (PURE). Partitions the hooks
 * into those the dialect supports (→ registration wrapper) and those it cannot
 * represent (→ degraded coverage record, never silent — R3). Every hook yields
 * exactly one coverage record carrying its KD6 dedupKey (R7).
 */
export function transpile(
  hooks: CanonicalHook[],
  dialect: HookDialect
): DialectOutput {
  const supported = DIALECT_SUPPORTED_EVENTS[dialect];
  const native = DIALECT_IS_NATIVE[dialect];

  const projectable = hooks.filter(h => supported.has(h.event));
  const unsupported = hooks.filter(h => !supported.has(h.event));

  const files =
    projectable.length > 0 ? emitDialectFiles(projectable, dialect) : [];

  const coverage: HookCoverageRecord[] = [
    ...projectable.map(h => ({ ...baseCoverageRecord(h), native })),
    ...unsupported.map(h => ({
      ...baseCoverageRecord(h),
      native: false,
      degraded: true,
      reason: `dialect "${dialect}" cannot represent event "${h.event}" (survey baseline) — degraded to the script-step tier`,
    })),
  ];

  return { dialect, native, files, coverage };
}

/** Dispatch to the per-dialect emitter. `projectable` is already filtered to the
 * events the dialect supports. */
function emitDialectFiles(
  projectable: CanonicalHook[],
  dialect: HookDialect
): DialectFile[] {
  switch (dialect) {
    case "claude-settings-json":
      // The canon itself — identity emit (the reference `.claude/settings.json`
      // nested shape). Useful as the round-trip anchor; production never
      // projects for a claude target (the spawn path gates `agent !== "claude"`).
      return [
        {
          path: ".claude/settings.json",
          content: `${JSON.stringify(
            { hooks: buildClaudeTaxonomy(projectable) },
            null,
            2
          )}\n`,
        },
      ];
    case "codex-hooks-json":
      return [emitCodexHooks(buildClaudeTaxonomy(projectable))];
    case "gemini-hooks-json":
      return [emitGeminiHooks(buildClaudeTaxonomy(projectable))];
    case "opencode-plugin-js":
      return [emitOpencodeShim(projectable)];
  }
}
