// SPDX-License-Identifier: AGPL-3.0-only
import type { SpawnInput } from "@/hooks/mutations/useSpawnSession";
import type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";
import type { ModelMode } from "@hapi/protocol/modes";
import { DEFAULT_OUTPUT_STYLE_DEFAULT } from "@hapi/protocol/schemas";
import type { EffortLevel } from "@hapi/protocol";
import type { ExistingBranch } from "@hapi/protocol/gitBranches";
import type { AgentType, SessionType } from "./types";

/**
 * Canonical spawn-target selection (local machine XOR remote node).
 * Mirrors the discriminated union the form derives from the machine/node selector.
 */
export type SpawnTargetSelection =
  | { kind: "local"; machineId: string }
  | { kind: "remote"; nodeId: string };

/**
 * The single, canonical set of spawn-relevant form selections.
 *
 * 🔴 SEAM (#1949 A2 ⟷ #1950 A3): this type + {@link buildSpawnInput} are the ONE
 * shared source of truth. A2 owns and exports them here; A3's `formState` memo
 * (#1950) MUST import them from this module and NOT redefine its own shape, so the
 * live command preview (A2) and the conditional field-state engine (A3) can never
 * derive divergent spawn semantics.
 *
 * Holds ONLY user selections. Runtime-only fields (`spawnCorrelationId`, `emoji`)
 * are merged at the spawn call site — they never live here and never surface in the
 * preview.
 */
export type SpawnSelections = {
  /** Selected target, or null when no machine/node is chosen yet. */
  target: SpawnTargetSelection | null;
  /** Raw directory text (trimmed inside {@link buildSpawnInput}). */
  directory: string;
  agent: AgentType;
  yolo: boolean;
  safeMode: boolean;
  /** Per-session launcher selection. */
  launcher: ClaudeRemoteLauncherKind;
  /** Resolved global default launcher — the payload omits `launcher` when equal to it. */
  globalDefaultLauncher: ClaudeRemoteLauncherKind;
  sessionType: SessionType;
  /** Raw branch text (trimmed inside {@link buildSpawnInput}; worktree only). */
  worktreeName: string;
  /**
   * hapimatic-private#4481: existing branch, ALREADY gated by the formState memo
   * (`effective.existingBranch`). Omitted when absent — byte-identical payload.
   */
  existingBranch?: ExistingBranch;
  /** Raw session-name text (trimmed inside {@link buildSpawnInput}). */
  name: string;
  accountUuid: string | null;
  /** True when ≥1 stored account exists — gates `accountUuid` inclusion (#1496 R7). */
  hasStoredAccounts: boolean;
  /**
   * Issue #4568: the node-vault Anthropic API key id the session bills to, ALREADY
   * gated by the formState memo (`effective.apiKeyId`: Claude + a local target +
   * a picked key). When set, the payload carries it INSTEAD of `accountUuid` and
   * pins `launcher: "sdk"` explicitly. Absent ⇒ byte-identical payload.
   */
  apiKeyId?: string;
  /**
   * Issue #1733 / #1950 A3: OpenRouter model id ("provider/model"), ALREADY
   * agent-gated by the formState memo (set only for codex + a gateway:openrouter
   * target + a non-empty selection; `undefined` otherwise). Threaded here — not
   * merged inline at the spawn site — so the live preview AND the real spawn read
   * it from ONE source and cannot diverge (the #1733-documented A3 follow-up).
   */
  model?: string;
  /**
   * Issue #3349 (ruling D4(a)): native-vs-OpenRouter routing discriminator,
   * ALREADY agent-gated by the formState memo (`"native"` only for the opencode
   * native picker; `undefined` otherwise). Threaded here — not merged at the
   * spawn site — so the live preview AND the real spawn read it from ONE source.
   * When `"native"`, `model` above carries the combined `provider/model`.
   */
  modelRouting?: "native" | "openrouter";
  /**
   * Issue #2434: Claude model-mode pin, ALREADY agent-gated by the formState
   * memo (set only for claude + an explicit non-default selection; `undefined`
   * otherwise). Threaded here — not merged inline at the spawn site — so the
   * live preview AND the real spawn read it from ONE source and cannot diverge
   * (the same A2 ⟷ A3 seam `model` uses).
   *
   * Distinct from `model` above: that is the OpenRouter GATEWAY axis
   * (codex/opencode), this is the Claude axis. Mutually exclusive in the UI.
   */
  modelMode?: ModelMode;
  /** Issue #2456: reasoning-effort pin (pre-gated: claude + explicit selection). */
  effort?: EffortLevel;
  /** Issue #2456: specific raw Claude model pin (pre-gated: claude + explicit). */
  rawModel?: string;
  /**
   * Issue #3348: gemini native model id, ALREADY agent-gated by the formState
   * memo (gemini + a non-Auto selection). {@link buildSpawnInput} bundles this
   * (and `codexModel`) into the single `nativeModelSelection` wire field.
   */
  geminiModel?: string;
  /** Issue #3348: codex ChatGPT-token model id (pre-gated: codex-native picker + non-Default). */
  codexModel?: string;
  /** Issue #3348: codex reasoning effort (pre-gated: codex effort row + explicit). */
  codexReasoningEffort?: string;
  /**
   * Issue #2626 (D): per-session output style — RAW (NOT pre-gated upstream,
   * unlike the model/effort fields). {@link buildSpawnInput} applies the gating
   * (claude-only + "default"/empty → omit) so the live preview AND the real
   * spawn read it from ONE source and cannot diverge.
   */
  outputStyle?: string;
  /**
   * Issue #1953 (A6): clone-on-spawn repo ("owner/repo"), or null when no repo
   * is selected. Set by GitHubAccountRepoSelector; the daemon clones it into
   * `directory` before launch. Threaded here (not merged at the spawn site) so
   * the live preview AND the real spawn read it from ONE source (#1949 R4).
   */
  cloneRepo: string | null;
};

/**
 * Build the EXACT {@link SpawnInput} payload the spawn request POSTs, from the
 * canonical {@link SpawnSelections}. Pure — no hooks, no side effects.
 *
 * Reproduces `handleCreateSession`'s field-omission rules byte-for-byte so the
 * preview and the real spawn cannot diverge (#1949 R4) AND older federation nodes
 * never receive unexpected fields:
 *  - `safeMode` omitted when false (#1633)
 *  - `launcher` omitted when equal to the resolved global default (#1660)
 *  - `worktreeName` only for `sessionType:"worktree"` and only when non-empty
 *  - `accountUuid` only for a local target with ≥1 stored account (#1496 R7)
 *  - `claimPort` always false for user-driven create (#1262/#1683)
 *
 * The runtime-only `spawnCorrelationId` and the cosmetic `emoji` are intentionally
 * NOT set here — the caller merges them at the spawn site.
 */
export function buildSpawnInput(sel: SpawnSelections): SpawnInput {
  const isRemote = sel.target?.kind === "remote";
  const directory = sel.directory.trim();
  const name = sel.name.trim();
  const branch = sel.worktreeName.trim();
  // #4568: a key binding is local-only (a node's keys never cross the federation)
  // and replaces the account binding — exactly one credential per session.
  const apiKeyId = !isRemote && sel.apiKeyId ? sel.apiKeyId : undefined;
  return {
    machineId: sel.target?.kind === "local" ? sel.target.machineId : undefined,
    nodeId: sel.target?.kind === "remote" ? sel.target.nodeId : undefined,
    directory,
    agent: sel.agent,
    yolo: sel.yolo,
    safeMode: sel.safeMode || undefined,
    // #4568: an API-key session runs on the SDK launcher — sent EXPLICITLY (not
    // omitted when SDK is the global default) so the request names the launcher
    // the key requires and the server can refuse anything else.
    launcher: apiKeyId
      ? "sdk"
      : sel.launcher !== sel.globalDefaultLauncher
        ? sel.launcher
        : undefined,
    claimPort: false,
    sessionType: sel.sessionType,
    worktreeName:
      sel.sessionType === "worktree" && !sel.existingBranch
        ? branch || undefined
        : undefined,
    // #4481: only on a Worktree spawn; omitted otherwise (byte-identical).
    existingBranch:
      sel.sessionType === "worktree" && sel.existingBranch
        ? sel.existingBranch
        : undefined,
    name: name || undefined,
    accountUuid:
      !apiKeyId && !isRemote && sel.hasStoredAccounts && sel.accountUuid
        ? sel.accountUuid
        : undefined,
    apiKeyId,
    // #1733/#1950 A3: model is pre-gated upstream (formState.effective.model);
    // omit when empty/undefined so non-openrouter spawns stay byte-identical.
    model: sel.model || undefined,
    // #3349 (D4(a)): routing discriminator — pre-gated upstream ("native" only for
    // the opencode native picker); omit otherwise so OpenRouter/claude/gemini/
    // codex spawns stay byte-identical (absent = model-presence semantics, R6).
    modelRouting: sel.modelRouting || undefined,
    // #2434: modelMode is pre-gated upstream (formState.effective.modelMode —
    // claude + explicit non-default only); omit otherwise so an unpinned spawn
    // stays byte-identical and the server's flavor guard is never tripped.
    modelMode: sel.modelMode || undefined,
    // #2456: reasoning-effort + specific raw-model pins — pre-gated upstream
    // (claude + explicit only); omit otherwise so an unpinned spawn is byte-identical.
    effort: sel.effort || undefined,
    rawModel: sel.rawModel || undefined,
    // #3348: bundle the non-claude native model selection into ONE wire field
    // (minimal #1262 threading). `modelId` = at most one of gemini/codex (they are
    // mutually exclusive upstream in deriveFormState); `reasoningEffort` = codex
    // effort. The daemon interprets `modelId` by AGENT (gemini → GEMINI_MODEL env;
    // codex → config.toml bake). Omitted entirely when neither is set, so a
    // claude / OpenRouter / opencode spawn stays byte-identical.
    nativeModelSelection:
      sel.geminiModel || sel.codexModel || sel.codexReasoningEffort
        ? {
            modelId: sel.geminiModel || sel.codexModel || undefined,
            reasoningEffort: sel.codexReasoningEffort || undefined,
          }
        : undefined,
    // #1953 A6: clone-on-spawn repo — omit when null/empty so non-repo spawns
    // stay byte-identical (R12). The web derives `directory` from the repo.
    cloneRepo: sel.cloneRepo || undefined,
    // #2626 (D): per-session output style. Gated HERE (not pre-gated upstream
    // like model/effort): claude-only + omit when "default"/empty so a
    // non-Claude or default spawn's --settings file stays byte-identical (R2).
    // A --settings scalar outputStyle wins over settings.local.json (Task 1 spike).
    outputStyle:
      sel.agent === "claude" &&
      sel.outputStyle &&
      sel.outputStyle !== DEFAULT_OUTPUT_STYLE_DEFAULT
        ? sel.outputStyle
        : undefined,
  };
}

/**
 * Display-only enrichment for the command preview: humanizes opaque IDs (account
 * UUID → email, machine/node ID → label). Changes only the RENDERED value of a
 * flag, never WHICH flags appear (presence is driven by the payload — R4).
 */
export type SpawnDisplayContext = {
  machineLabel?: string;
  nodeLabel?: string;
  accountEmail?: string;
  /** #4568: the bound key's label (else its masked form) — never the key. */
  apiKeyLabel?: string;
};

/** Quote a shell argument only when it contains characters that need it. */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./@:=-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Render the live terminal-command preview from the EXACT {@link SpawnInput}
 * payload that will be POSTed (#1949 R4 — structural no-divergence). Each flag's
 * PRESENCE tracks the payload (an omitted field produces no flag); opaque IDs are
 * humanized via `display`. Internal/runtime fields (`claimPort`,
 * `spawnCorrelationId`, `emoji`) are never rendered.
 *
 * PROPOSED surface format (#1949 researcher proposal — the V6 mockup is absent from
 * the repo; Matt confirms the exact wording at visual review): a `hapi spawn`
 * pseudo-command, one flag per line.
 */
export function assembleSpawnCommand(
  input: SpawnInput,
  display: SpawnDisplayContext,
  /**
   * Issue #2149: the session's current MCP-server set, for the Edit-modal "copy
   * launch params" button (R7). Display-only — the create-flow preview never
   * passes it, so the `--mcp` lines render ONLY when a non-empty set is supplied
   * (the Verify: "new lines appear only when present").
   */
  mcpServers?: readonly string[]
): string {
  // Incomplete selection → an explanatory placeholder, not a broken command.
  if ((!input.machineId && !input.nodeId) || !input.directory) {
    return "# select a machine and directory to preview the spawn command";
  }

  const target = input.nodeId
    ? (display.nodeLabel ?? input.nodeId)
    : (display.machineLabel ?? input.machineId);

  const lines: string[] = ["hapi spawn"];
  if (target) lines.push(`--on ${shellQuote(target)}`);
  lines.push(`--dir ${shellQuote(input.directory)}`);
  if (input.sessionType) lines.push(`--type ${input.sessionType}`);
  if (input.worktreeName)
    lines.push(`--branch ${shellQuote(input.worktreeName)}`);
  // #4481: worktree on an existing branch (`origin/<name>` for remote-only).
  if (input.existingBranch)
    lines.push(
      `--existing-branch ${shellQuote(
        input.existingBranch.remote
          ? `origin/${input.existingBranch.name}`
          : input.existingBranch.name
      )}`
    );
  if (input.agent) lines.push(`--agent ${input.agent}`);
  // #1733/#1950 A3: OpenRouter model routing (codex) — reflects the gated payload.
  if (input.model) lines.push(`--model ${shellQuote(input.model)}`);
  // #3349 (D4(a)): native-vs-OpenRouter routing — reflects the gated payload so
  // the preview shows an opencode native selection is routed to its provider.
  if (input.modelRouting) lines.push(`--model-routing ${input.modelRouting}`);
  // #2434: Claude model-mode pin — reflects the gated payload. Rendered next to
  // --model so the two axes read as the alternatives they are; only one can be
  // present for any given agent.
  if (input.modelMode) lines.push(`--model-mode ${input.modelMode}`);
  // #2456: reasoning-effort + specific raw-model pins — reflect the gated payload.
  if (input.rawModel) lines.push(`--model ${shellQuote(input.rawModel)}`);
  if (input.effort) lines.push(`--effort ${input.effort}`);
  // #3348: gemini / codex native model + codex reasoning effort (bundled wire
  // field). Only one flavor's axis is populated per spawn, so at most one --model
  // line renders. The daemon conveys these via GEMINI_MODEL (gemini) or a codex
  // config.toml bake — the preview shows the selection, not the mechanism.
  if (input.nativeModelSelection?.modelId)
    lines.push(`--model ${shellQuote(input.nativeModelSelection.modelId)}`);
  if (input.nativeModelSelection?.reasoningEffort)
    lines.push(
      `--reasoning-effort ${input.nativeModelSelection.reasoningEffort}`
    );
  // #1953 A6: clone-on-spawn repo — reflects the gated payload (R8).
  if (input.cloneRepo) lines.push(`--clone ${shellQuote(input.cloneRepo)}`);
  if (input.launcher) lines.push(`--launcher ${input.launcher}`);
  if (input.accountUuid) {
    lines.push(
      `--account ${shellQuote(display.accountEmail ?? input.accountUuid)}`
    );
  }
  // #4568: the API-key binding — named by label / mask, never the key.
  if (input.apiKeyId) {
    lines.push(
      `--api-key ${shellQuote(display.apiKeyLabel ?? input.apiKeyId)}`
    );
  }
  if (input.yolo) lines.push("--yolo");
  if (input.safeMode) lines.push("--safe-mode");
  // #2149: MCP set — one `--mcp` line per enabled server (copy-params only). The
  // create-flow preview passes no set, so these render only for the Edit modal.
  for (const server of mcpServers ?? []) {
    lines.push(`--mcp ${shellQuote(server)}`);
  }
  if (input.name) lines.push(`--name ${shellQuote(input.name)}`);

  // Continuation-style: first line bare, subsequent flags indented under a `\`.
  return lines.map((line, i) => (i === 0 ? line : `  ${line}`)).join(" \\\n");
}
