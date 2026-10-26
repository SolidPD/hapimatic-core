// SPDX-License-Identifier: AGPL-3.0-only
import { isQualifiedApiKeyRef } from "@hapi/protocol/apiKeyRef";
import type { AgentType, SessionMode, SessionType } from "./types";
import type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";
import {
  isYoloEquivalentMode,
  resolveModelSelectionForFlavor,
} from "@hapi/protocol/modes";
import type { ModelMode, PermissionMode } from "@hapi/protocol/modes";
import type { EffortLevel } from "@hapi/protocol";
import type { ExistingBranch } from "@hapi/protocol/gitBranches";

/**
 * Issue #1950 (A3) — the conditional field-state engine for the Create-Session form.
 *
 * `deriveFormState` is a PURE derivation (no React, no hooks) that computes, from
 * the current form selections, BOTH:
 *  - `fields`: per-field `{ visible, disabled, label }` — the single source the
 *    layout reads for its gray-out / relabel behavior (no ad-hoc per-component
 *    conditionals remain), and
 *  - `effective`: the agent-gated selection set the spawn payload is built from.
 *
 * 🔴 SEAM (#1949 A2 ⟷ #1950 A3): A2 owns the canonical {@link SpawnSelections}
 * type and {@link buildSpawnInput} (wire-format omission) in `spawnCommand.ts`.
 * A3 does NOT redefine them. A3 layers the **agent-gating** on top: `effective`
 * nulls the Claude-only fields for non-Claude agents, and the caller feeds those
 * gated values into the existing `spawnSelections` memo so the live preview (A2)
 * and the real spawn (`buildSpawnInput`) read one source and can never diverge.
 *
 * Division of labour (do not duplicate):
 *  - A2 `buildSpawnInput`: wire-format omission — `safeMode` when false,
 *    `launcher` when `=== globalDefaultLauncher`, `worktreeName` off-worktree,
 *    `accountUuid` on remote / no-accounts.
 *  - A3 `effective`: agent-gating — for `agent !== "claude"`, `safeMode → false`,
 *    `launcher → undefined`, `accountUuid → undefined`. Composing the two yields
 *    the correct omission through the UNMODIFIED `buildSpawnInput`.
 *
 * Claude-only field set is backend-evidenced (Tier-1, see directive):
 *  - **Launcher** is Claude-only (`HAPI_CLAUDE_LAUNCHER` only affects a Claude spawn).
 *  - **Safe Mode** is Claude-only (`--safe-mode` is a Claude Code flag).
 *  - **YOLO is NOT** Claude-only (`--yolo` is pushed for codex/gemini/claude alike).
 */

/** Per-field presentation state derived from the current selections. */
export type FieldState = {
  /** Whether the field renders at all (genuinely conditional render). */
  visible: boolean;
  /** Whether the field is grayed/disabled (busy-form OR agent-gated). */
  disabled: boolean;
  /** Field label — overridden from its default for relabeling (Account ↔ API Key). */
  label?: string;
  /**
   * Issue #4568: a short explanation shown under the control when a choice
   * elsewhere LOCKS this field (e.g. Launcher → SDK "Required for API billing").
   */
  note?: string;
};

/** Issue #4568: the note on a setting an API-key binding locks. */
export const API_BILLING_LOCK_NOTE = "Required for API billing";

/** The raw selections `deriveFormState` reads. Flat — no React types. */
export type FormStateInput = {
  agent: AgentType;
  sessionType: SessionType;
  /** True when the chosen spawn target is a remote node. */
  isRemoteTarget: boolean;
  /** Global busy signal (`spawnPending || schedulePending || isLoading`). */
  isFormDisabled: boolean;
  /** True when the selected directory already contains a git repo (`detectedRepo != null`). */
  directoryHasGitRepo: boolean;
  /**
   * Issue #2270 (F25): TRUE git-ness of the selected directory (`git rev-parse`),
   * distinct from `directoryHasGitRepo` (forge-origin identity). TRI-STATE:
   * `undefined` = unknown/loading ⇒ NO forcing; `false` = definitively non-git ⇒
   * default `worktree`→`simple` at the seam (Worktree stays selectable); `true` =
   * git ⇒ unchanged. A no-origin/`git init` repo is `directoryIsGitRepo: true` +
   * `directoryHasGitRepo: false`.
   */
  directoryIsGitRepo?: boolean;
  /**
   * Issue #2270 (F25): true once the user has explicitly picked a Git Type. When
   * true, the non-git default (`simple`) is NOT applied — an explicit `worktree`
   * choice is preserved (the daemon backstop catches a doomed override).
   */
  sessionTypeUserSelected: boolean;
  /**
   * Issue #3558: the clone-on-spawn repo ("owner/repo") picked in the GitHub
   * section, or null. A clone is a first-time full checkout, so a set value
   * forces the effective type to `simple` UNCONDITIONALLY (unlike F25, an
   * explicit Worktree pick does not override it) and disables the Worktree
   * option. Absent (the edit-params modal) ⇒ no clone forcing.
   */
  cloneRepo?: string | null;
  /** Selected spawn-time permission mode (#1951 A4); replaces the binary YOLO flag. */
  permissionMode: PermissionMode;
  safeMode: boolean;
  launcher: ClaudeRemoteLauncherKind;
  worktreeName: string;
  /**
   * hapimatic-private#4481: an EXISTING branch picked in the Branch control
   * (Worktree only — raw-state writers force Worktree when it is set). Absent /
   * null (the edit modal, every pre-#4481 path) ⇒ today's behavior exactly.
   */
  existingBranch?: ExistingBranch | null;
  accountUuid: string | null;
  /** Number of stored accounts — gates `accountUuid` inclusion. */
  accountsCount: number;
  /**
   * Issue #4568: the node-vault Anthropic API key picked as the session's
   * credential, or null/absent. Honored only for Claude — on a local target,
   * or on a remote one when it is a listed shared key (#5127); it replaces the
   * account binding and locks the launcher to SDK. Absent (the edit
   * modal, every pre-#4568 caller) ⇒ byte-identical derivation.
   */
  apiKeyId?: string | null;
  /**
   * Issue #5127 (D9): a remote target can bill an API key another node shares.
   * `remoteSharedKeysAvailable` — the target has ≥1 such key, so the selector
   * shows on a remote target.
   */
  remoteSharedKeysAvailable?: boolean;
  /** True when the selected target advertises `gateway:openrouter` (#1733). */
  agentSupportsOpenRouter: boolean;
  /** Selected OpenRouter model id (`""` = none); only meaningful for codex + openrouter. */
  selectedModel: string;
  /** Issue #2434: selected Claude model-mode pin; only meaningful for claude. */
  selectedModelMode: ModelMode;
  /** Issue #2456: selected reasoning-effort level (`""` = default); claude only. */
  selectedEffort: EffortLevel | "";
  /** Issue #2456: selected specific raw Claude model id (`""` = default/family);
   *  claude only. From the full-catalog Model dropdown. */
  selectedRawModel: string;
  /** Issue #3348: selected gemini native model id (`""` = Auto); gemini only. */
  selectedGeminiModel: string;
  /** Issue #3348: selected codex ChatGPT-token model id (`""` = Default); codex only. */
  selectedCodexModel: string;
  /** Issue #3348: selected codex reasoning-effort (`""` = default); codex only. */
  selectedCodexEffort: string;
  /** Issue #3349: selected opencode native provider — a #1955 vault provider
   *  string (e.g. "anthropic"); opencode native picker only. `""` = none. */
  selectedOpencodeProvider: string;
  /** Issue #3349: selected opencode native model id for the chosen provider;
   *  opencode native picker only. `""` = none. */
  selectedOpencodeModel: string;
  /**
   * Issue #2149 (edit-and-relaunch): drive the Edit-session-params modal instead
   * of the Create form. When true, the `mcpServers` field becomes visible and the
   * params that are not editable in a relaunch (working directory / worktree
   * branch — D4) are gated disabled. Absent/`false` ⇒ create-flow behavior is
   * byte-identical (append-only, R10 no-regression).
   */
  isEditMode?: boolean;
};

/**
 * The derived form state: per-field UI gating (`fields`) + the agent-gated
 * resolved selection set (`effective`) the spawn payload is assembled from.
 */
export type FormState = {
  fields: {
    /** Account ↔ API-Key relabel + disable for non-Claude (static placeholder, SEAM-2). */
    account: FieldState;
    /** Claude-only: disabled when `agent !== "claude"`. Issue #4568: also LOCKED
     *  (disabled, with {@link API_BILLING_LOCK_NOTE}) while an API key is picked. */
    launcher: FieldState;
    /**
     * Issue #4568: the per-session output style (Claude-only). Its own state — it
     * used to borrow `launcher.disabled`, which the API-billing lock now sets, and
     * API billing does not constrain the output style.
     */
    outputStyle: FieldState;
    /** Claude-only: disabled when `agent !== "claude"`. */
    safeMode: FieldState;
    /**
     * Spawn-time permission-mode dropdown (#1951 A4, replaces the YOLO toggle).
     * Disabled only when the form is busy — NOT agent-gated (the derived spawn
     * `yolo` applies to every agent).
     */
    permissionMode: FieldState;
    /** Visible only for `sessionType === "worktree"`. */
    worktreeBranch: FieldState;
    /**
     * Issue #3558: Git Type control affordance — `worktreeDisabled` is true
     * while a clone-on-spawn repo is selected (Worktree is not selectable).
     */
    gitType: { worktreeDisabled: boolean };
    /**
     * Forward-wired for A6/#1953: `disabled` when the selected directory already
     * has a git repo. No repo field renders yet (`visible: false`); A3 ships the
     * derivation + unit test only.
     */
    repo: FieldState;
    /**
     * OpenRouter model picker (#1733): `visible` only for a Codex agent on a
     * `gateway:openrouter`-capable target; `disabled` only when the form is busy.
     */
    model: FieldState;
    /**
     * Claude model-mode dropdown (#2434): `visible` only for a Claude agent;
     * `disabled` only when the form is busy. Mutually exclusive with `model`
     * above by construction (that one requires codex/opencode) — this pair IS
     * the flavor-conditional model-picker swap.
     */
    modelMode: FieldState;
    /** Issue #2456: reasoning-effort dropdown — claude only, same gate as modelMode. */
    effort: FieldState;
    /** Issue #2456: full-catalog Model dropdown ("More models") — claude only. */
    rawModel: FieldState;
    /**
     * Issue #3348: gemini native-catalog model picker — visible when the
     * flavor's `modelSelection` axis binds the `gemini-native` catalog (gemini).
     * Manifest-driven, NOT a `flavor === "gemini"` check.
     */
    geminiModel: FieldState;
    /**
     * Issue #3348: codex ChatGPT-token native model picker — visible when the
     * `codex-native` catalog binds (codex on a node WITHOUT OpenRouter gateway
     * auth; when the node HAS gateway auth the OpenRouter `model` picker wins by
     * the dual-source mutual exclusion). Manifest-driven.
     */
    codexModel: FieldState;
    /**
     * Issue #3348: codex reasoning-effort dropdown — visible with the codex
     * native picker when the axis declares `reasoningEffort`. Distinct from the
     * claude `effort` field (different vocabulary — codex adds `ultra`).
     */
    codexEffort: FieldState;
    /**
     * Issue #3349: opencode native provider/model picker — visible when the
     * `opencode-native` catalog binds (opencode on a node WITHOUT OpenRouter
     * gateway auth; when the node HAS gateway auth the OpenRouter `model` picker
     * wins by the dual-source mutual exclusion). Manifest-driven, NOT a
     * `flavor === "opencode"` check.
     */
    opencodeNativeModel: FieldState;
    /**
     * Issue #2149 (edit-and-relaunch): the MCP-server multi-select. The create
     * flow never modeled MCP, so this is `visible` ONLY in edit mode; `disabled`
     * only when the form is busy. Append-only — create-mode consumers ignore it.
     */
    mcpServers: FieldState;
  };
  /**
   * The agent-gated resolved selections. Fed into the `spawnSelections` memo so the
   * preview AND the real spawn (`buildSpawnInput`) read one source. The Claude-only
   * fields are nulled for non-Claude agents; everything else mirrors the raw input.
   */
  effective: {
    agent: AgentType;
    yolo: boolean;
    /** `false` when `agent !== "claude"`. */
    safeMode: boolean;
    /** `undefined` when `agent !== "claude"`. */
    launcher: ClaudeRemoteLauncherKind | undefined;
    sessionType: SessionType;
    /** `undefined` when `sessionType !== "worktree"` (mirrors `buildSpawnInput`'s gating),
     *  and when an existing branch is picked (#4481 — the new-branch name is moot). */
    worktreeName: string | undefined;
    /** hapimatic-private#4481: the existing branch — `undefined` unless the
     *  EFFECTIVE type is Worktree (a non-git / clone force drops it). */
    existingBranch: ExistingBranch | undefined;
    /** `undefined` when remote, no stored accounts, or `agent !== "claude"` —
     *  and (#4568) whenever an API key is the session's credential. */
    accountUuid: string | undefined;
    /** Issue #4568: the API key the session bills — Claude + local target + a
     *  picked key; `undefined` otherwise (byte-identical spawn). */
    apiKeyId: string | undefined;
    /**
     * OpenRouter model id (#1733) — set ONLY for a Codex agent on a
     * `gateway:openrouter`-capable target with a non-empty selection; `undefined`
     * otherwise so normal claude/codex spawns stay byte-identical.
     */
    model: string | undefined;
    /**
     * Issue #3349 (ruling D4(a)): native-vs-OpenRouter routing discriminator.
     * `"native"` set ONLY when the opencode native picker is active (the sole
     * opencode path when the node lacks OpenRouter gateway auth); `undefined`
     * otherwise so OpenRouter / claude / gemini / codex spawns stay byte-identical
     * (absent = today's model-presence-means-OpenRouter semantics, R6 skew-safe).
     */
    modelRouting: "native" | "openrouter" | undefined;
    /**
     * Claude model-mode pin (#2434) — set ONLY for a Claude agent with an
     * EXPLICIT non-default selection; `undefined` otherwise.
     *
     * Omitting `"default"` is load-bearing twice over: it keeps an unpinned
     * spawn byte-identical to pre-#2434 (no `modelMode` key on the wire), and
     * it avoids the server's flavor guard, which rejects EVERY mode — including
     * `"default"` — on a non-Claude spawn (`getModelModesForFlavor` returns []
     * for codex/gemini/opencode).
     */
    modelMode: ModelMode | undefined;
    /** Issue #2456: reasoning-effort pin — claude + explicit selection; else undefined. */
    effort: EffortLevel | undefined;
    /** Issue #2456: specific raw-model pin — claude + explicit selection; else undefined. */
    rawModel: string | undefined;
    /** Issue #3348: gemini native model — gemini + a non-Auto selection; else undefined. */
    geminiModel: string | undefined;
    /** Issue #3348: codex ChatGPT-token model — codex-native picker + non-Default; else undefined. */
    codexModel: string | undefined;
    /** Issue #3348: codex reasoning effort — codex-native picker + explicit selection; else undefined. */
    codexReasoningEffort: string | undefined;
  };
};

/**
 * Pure derivation of the Create-Session form state from the current selections.
 * No side effects, no React — consume via `useMemo` in `index.tsx`.
 */
export function deriveFormState(input: FormStateInput): FormState {
  const isClaude = input.agent === "claude";
  // #3808 Task 5: the agents that BIND a per-account provider record — Claude
  // (Anthropic), Codex (OpenAI), Gemini (Google). opencode uses OpenRouter/native
  // gateway KEYS (no per-account binding), so it keeps the "API Key" placeholder.
  // These agents can carry a pinned `accountUuid` and enable the account field.
  const agentBindsAccount =
    input.agent === "claude" ||
    input.agent === "codex" ||
    input.agent === "gemini";
  const busy = input.isFormDisabled;
  // Issue #2149: edit-and-relaunch mode gates the params that a relaunch cannot
  // change (cwd/worktree — D4) and surfaces the MCP multi-select.
  const isEditMode = input.isEditMode === true;

  // Issue #3348 (epic #3345, ruling D1(a)): the model pickers are MANIFEST-DRIVEN.
  // `resolveModelSelectionForFlavor` reads the flavor's `modelSelection` axis —
  // NO `flavor === "x"` conditional (AC R4). The mutual exclusion between the
  // pickers lives HERE (this ONE derivation) so the live preview, the spawn
  // payload, and the render can never disagree (R5).
  const modelSel = resolveModelSelectionForFlavor(input.agent);
  // The OpenRouter picker binds when the flavor declares the gateway source AND
  // the NODE advertises gateway auth (both required; gateway auth is a per-node
  // capability, not a per-flavor axis). REPLACES the pre-#3348
  // `(isCodex || isOpenCode) && agentSupportsOpenRouter` gate — same result today
  // (codex/opencode both declare openrouter-gateway) but now axis-driven.
  const showOpenRouterPicker =
    modelSel.hasOpenRouterSource && input.agentSupportsOpenRouter;
  // A flavor may declare BOTH sources (codex: OpenRouter + codex-native): the
  // gateway picker WINS when active, so the native picker binds only when the
  // OpenRouter picker is NOT showing (dual-source mutual exclusion).
  const nativeCatalogId = showOpenRouterPicker
    ? undefined
    : modelSel.nativeCatalogId;
  const showClaudePicker = nativeCatalogId === "claude-modes";
  const showGeminiPicker = nativeCatalogId === "gemini-native";
  const showCodexPicker = nativeCatalogId === "codex-native";
  // Codex reasoning-effort row: the codex-native picker is bound AND the axis
  // declares a reasoning-effort value set. (Claude's effort stays folded into its
  // own ModelEffortRow, gated by `showClaudePicker`.)
  const showCodexEffort =
    showCodexPicker && (modelSel.reasoningEffortValues?.length ?? 0) > 0;
  // #1733/#1975 alias kept for the existing OpenRouter field/effective sites below.
  const modelApplicable = showOpenRouterPicker;
  // #3349: opencode native provider/model picker — the `opencode-native` catalog
  // binds (only when the OpenRouter picker is NOT active — dual-source exclusion,
  // so opencode uses native only on a node WITHOUT OpenRouter gateway auth).
  const showOpencodePicker = nativeCatalogId === "opencode-native";
  // The combined `provider/model` the daemon parses (opencode's canonical model
  // format); undefined until BOTH the provider AND the model are chosen.
  const opencodeNativeModel =
    showOpencodePicker &&
    input.selectedOpencodeProvider &&
    input.selectedOpencodeModel
      ? `${input.selectedOpencodeProvider}/${input.selectedOpencodeModel}`
      : undefined;

  // Issue #2270 (F25): force worktree→simple at the derivation seam when the
  // directory is DEFINITIVELY non-git and the user has not explicitly chosen a
  // type. Unknown/loading (`directoryIsGitRepo === undefined`) never forces; an
  // explicit user choice is preserved (Task 2's daemon backstop catches a doomed
  // worktree-on-non-git override). The control/preview/payload all read this one
  // effective value, so they can never disagree.
  const forceSimpleForNonGit =
    input.directoryIsGitRepo === false && !input.sessionTypeUserSelected;
  // Issue #3558: a clone-on-spawn repo is a first-time full checkout, so a
  // worktree makes no sense (#1953 KEY DECISION #3). Unlike F25 this force is
  // unconditional. It backstops the raw-state guards in index.tsx so the
  // preview/payload can never say Worktree for a clone, even via a bookmark
  // restore — defense in depth, like the daemon's own clone force-simple.
  const forceSimpleForClone = Boolean(input.cloneRepo);
  const effectiveSessionType: SessionType =
    forceSimpleForNonGit || forceSimpleForClone ? "simple" : input.sessionType;
  // hapimatic-private#4481: honored only on an effective Worktree — any force to
  // Basic (non-git, clone) drops it, so Basic never carries a branch switch.
  const effectiveExistingBranch =
    effectiveSessionType === "worktree" && input.existingBranch
      ? input.existingBranch
      : undefined;

  // Issue #4568: an API key bound as the session's credential (Claude, local
  // target). It replaces the account binding and LOCKS the launcher to SDK — the
  // only launcher that bills a key (D-4568-2 A) — with the note shown under it.
  // #5127 (D9): a remote target binds a key shared from another node — any
  // picked QUALIFIED ref, listed or not: a ref that dropped out of the list (its
  // home went offline, the key was unticked) is still sent, so the target
  // refuses naming the home instead of the spawn billing its default account
  // (R8; the local SF-2 rule). A bare id never binds a remote session.
  const keyBound =
    isClaude &&
    Boolean(input.apiKeyId) &&
    (!input.isRemoteTarget || isQualifiedApiKeyRef(input.apiKeyId));

  return {
    fields: {
      // SEAM-2: relabel + disable for non-Claude is a STATIC placeholder — no real
      // stored-key wiring (that lands with Epic #1954 / B2-B3).
      account: {
        // #5127 (D9): a remote target shows the selector only for its shared
        // keys (remote accounts are #4425's; the node default is used).
        // (and while a key is picked, so the pick stays visible).
        visible:
          !input.isRemoteTarget ||
          input.remoteSharedKeysAvailable === true ||
          keyBound,
        // #3808 Task 5: enabled for every account-binding agent (claude/codex/gemini),
        // not just Claude; opencode (gateway keys) stays disabled + "API Key".
        disabled: busy || !agentBindsAccount,
        label: agentBindsAccount ? "Provider Account" : "API Key",
      },
      launcher: {
        visible: true,
        disabled: busy || !isClaude || keyBound,
        ...(keyBound ? { note: API_BILLING_LOCK_NOTE } : {}),
      },
      outputStyle: { visible: true, disabled: busy || !isClaude },
      safeMode: { visible: true, disabled: busy || !isClaude },
      // Permission mode is NOT agent-gated — the derived spawn `yolo` is pushed
      // for every agent (#1951 A4, mirroring the prior YOLO field's rule).
      permissionMode: { visible: true, disabled: busy },
      worktreeBranch: {
        // #2270 (F25): key on the EFFECTIVE type so the Branch Name field hides
        // when a non-git default silently downgrades the control to simple.
        // #4481: also hidden when an existing branch is picked (no new name).
        visible:
          effectiveSessionType === "worktree" && !effectiveExistingBranch,
        // #2149 (D4): working directory / worktree branch is NOT editable in a
        // relaunch (changing cwd invalidates `--resume`), so gate it in edit mode.
        disabled: busy || isEditMode,
      },
      // #3558: a clone-on-spawn repo makes Worktree unselectable.
      gitType: { worktreeDisabled: forceSimpleForClone },
      // Forward-wired for A6/#1953 — no field renders yet.
      repo: { visible: false, disabled: input.directoryHasGitRepo },
      // #1733/#3348 OpenRouter model picker — manifest-driven (openrouter-gateway
      // ∈ catalogSources AND the node advertises gateway auth).
      model: { visible: modelApplicable, disabled: busy },
      // #2434/#3348 Claude model-mode dropdown — gated by the claude-modes native
      // catalog (was `isClaude`; identical for claude, now axis-driven).
      modelMode: { visible: showClaudePicker, disabled: busy },
      // #2456/#3348 Effort + full-catalog Model dropdowns — claude-modes catalog.
      effort: { visible: showClaudePicker, disabled: busy },
      rawModel: { visible: showClaudePicker, disabled: busy },
      // #3348 gemini native model picker — the gemini-native catalog.
      geminiModel: { visible: showGeminiPicker, disabled: busy },
      // #3348 codex ChatGPT-token model picker + reasoning-effort — codex-native
      // catalog (only when the OpenRouter picker is NOT active — dual-source).
      codexModel: { visible: showCodexPicker, disabled: busy },
      codexEffort: { visible: showCodexEffort, disabled: busy },
      // #3349 opencode native provider/model picker — the opencode-native catalog
      // (only when the OpenRouter picker is NOT active — dual-source exclusion).
      opencodeNativeModel: { visible: showOpencodePicker, disabled: busy },
      // #2149 (edit-and-relaunch): MCP multi-select — visible only in edit mode
      // (the create flow never modeled MCP), disabled only when busy.
      mcpServers: { visible: isEditMode, disabled: busy },
    },
    effective: {
      agent: input.agent,
      // #1951 A4: collapse the selected permission mode to the existing spawn
      // `yolo` boolean (epic A1–A5 frontend-only — the wire still carries `yolo`).
      yolo: isYoloEquivalentMode(input.permissionMode),
      safeMode: isClaude ? input.safeMode : false,
      // #4568: a key-bound session's launcher is SDK, whatever was picked before.
      launcher: keyBound ? "sdk" : isClaude ? input.launcher : undefined,
      // #2270 (F25): the EFFECTIVE session type — the value the control renders,
      // the preview shows, and the spawn payload carries.
      sessionType: effectiveSessionType,
      worktreeName:
        effectiveSessionType === "worktree" && !effectiveExistingBranch
          ? input.worktreeName.trim() || undefined
          : undefined,
      existingBranch: effectiveExistingBranch,
      // #3808 Task 5: a codex/gemini spawn can now carry a pinned provider account
      // (un-nulled from the Claude-only gate). The pinned uuid comes from the
      // provider-scoped selector modal, so it is a record of the spawn's provider.
      accountUuid:
        !keyBound &&
        !input.isRemoteTarget &&
        agentBindsAccount &&
        input.accountsCount > 0 &&
        input.accountUuid
          ? input.accountUuid
          : undefined,
      apiKeyId: keyBound ? (input.apiKeyId ?? undefined) : undefined,
      // #1733/#3349: OpenRouter model id (codex/opencode gateway) OR — for the
      // opencode native picker — the combined `provider/model`. Mutually
      // exclusive (showOpencodePicker is true ONLY when the OpenRouter picker is
      // not). Omitted otherwise so claude/gemini/codex-native spawns stay
      // byte-identical.
      model: showOpencodePicker
        ? opencodeNativeModel
        : modelApplicable && input.selectedModel
          ? input.selectedModel
          : undefined,
      // #3349 (D4(a)): "native" when the opencode native picker is active (the
      // only opencode path when the node lacks OpenRouter gateway auth); omitted
      // otherwise so OpenRouter/claude/gemini/codex spawns are byte-identical and
      // an old peer degrades to model-presence-means-OpenRouter (R6).
      modelRouting: showOpencodePicker ? "native" : undefined,
      // #2434/#3348: Claude model-mode pin — claude-modes catalog + an EXPLICIT
      // non-default choice. "default" is the absence of a pin, so it is never
      // sent (see the type doc above for why omitting it is load-bearing).
      modelMode:
        showClaudePicker && input.selectedModelMode !== "default"
          ? input.selectedModelMode
          : undefined,
      // #2456/#3348: reasoning-effort + specific raw-model pins — claude-modes
      // catalog + an explicit selection; omitted otherwise (byte-identical).
      effort:
        showClaudePicker && input.selectedEffort
          ? input.selectedEffort
          : undefined,
      rawModel:
        showClaudePicker && input.selectedRawModel
          ? input.selectedRawModel
          : undefined,
      // #3348: gemini native model — the gemini picker + a non-Auto selection
      // (Auto = "" omits GEMINI_MODEL, so the gemini CLI picks its own default).
      geminiModel:
        showGeminiPicker && input.selectedGeminiModel
          ? input.selectedGeminiModel
          : undefined,
      // #3348: codex ChatGPT-token model — the codex-native picker + a non-Default
      // selection. Distinct from `model` (the OpenRouter gateway axis).
      codexModel:
        showCodexPicker && input.selectedCodexModel
          ? input.selectedCodexModel
          : undefined,
      // #3348: codex reasoning effort — the codex effort row + an explicit choice.
      codexReasoningEffort:
        showCodexEffort && input.selectedCodexEffort
          ? input.selectedCodexEffort
          : undefined,
    },
  };
}

/**
 * Issue #3558: the clone-on-spawn repo that LOCKS Git Type, or null. Only a
 * Standard session clones — the scheduled flow never sends the repo — so a repo
 * picked in Standard mode stops locking Git Type once the form is in Scheduled
 * mode. The ONE predicate behind the lock: the derivation input, the raw
 * guards, the forced Basic on a repo pick and the Worktree hint all read it.
 */
export function cloneLockFor(
  cloneRepo: string | null | undefined,
  sessionMode: SessionMode
): string | null {
  return sessionMode === "standard" && cloneRepo ? cloneRepo : null;
}

/**
 * Issue #3558: the RAW-state guard for a Git Type write while a clone-on-spawn
 * repo is selected — returns `simple` for a `worktree` request, else the value
 * unchanged. Applied on every raw write path (the control's onChange and the
 * bookmark restore setter) so raw == effective and the Git Type bookmark
 * indicator stays honest. `deriveFormState`'s clone force is the backstop.
 */
export function coerceGitTypeForClone(
  cloneRepo: string | null | undefined,
  value: SessionType
): SessionType {
  return cloneRepo && value === "worktree" ? "simple" : value;
}
