// SPDX-License-Identifier: AGPL-3.0-only
import { tryResolveHarnessManifest } from "./harnessManifests";

export const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export const CODEX_PERMISSION_MODES = [
  "default",
  "read-only",
  "safe-yolo",
  "yolo",
] as const;
export type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number];

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "read-only",
  "safe-yolo",
  "yolo",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const MODEL_MODES = [
  "default",
  "sonnet",
  "opus",
  "fable",
  "haiku",
] as const;
export type ModelMode = (typeof MODEL_MODES)[number];

/**
 * Resolve the raw `--model` value for an explicit model-mode selection.
 *
 * Fable maps to the `fable[1m]` ALIAS (a raw model string, NOT a bare
 * `"fable"`): bare `fable` resolves to claude-fable-5 with only a 200k
 * context window, while the explicit `[1m]` suffix selects the 1M-context
 * beta (verified against the live binary — issue #1633). The alias (vs a
 * hardcoded `claude-fable-5[1m]`) lets Claude Code track the current Fable
 * id itself, mirroring #1506's `opus[1m]`-over-concrete-id rationale.
 * Sonnet/Opus keep their bare aliases — their 1M entitlement handling lives
 * in the #1506 entitled-pin path, not here.
 */
export function resolveRawModelForMode(mode: ModelMode): string | undefined {
  switch (mode) {
    case "default":
      return undefined;
    case "fable":
      return "fable[1m]";
    default:
      return mode;
  }
}

/**
 * Derive the display model-mode from a raw spawn/--model value — the inverse
 * of `resolveRawModelForMode` for explicit selections. Raw Fable values
 * ("fable" / "fable[1m]") MUST derive to "fable": falling through to
 * "default" would let the #1506 entitled-pin block clobber an explicit Fable
 * selection with opus[1m]. The entitled "opus[1m]" pin intentionally derives
 * to "default" here — its display mode arrives separately via
 * syncSessionModes (issue #1633).
 */
export function deriveModelModeFromRaw(model: string | undefined): ModelMode {
  if (model === "sonnet" || model === "opus" || model === "haiku") {
    return model;
  }
  if (model === "fable" || model === "fable[1m]") {
    return "fable";
  }
  return "default";
}

export type AgentFlavor = "claude" | "codex" | "gemini" | "opencode";

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: "default",
  acceptEdits: "accept",
  plan: "plan",
  bypassPermissions: "YOLO",
  "read-only": "read-only",
  "safe-yolo": "safe-YOLO",
  yolo: "YOLO",
};

export type PermissionModeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

export const PERMISSION_MODE_TONES: Record<PermissionMode, PermissionModeTone> =
  {
    default: "neutral",
    acceptEdits: "success",
    plan: "info",
    bypassPermissions: "warning",
    "read-only": "info",
    "safe-yolo": "warning",
    yolo: "warning",
  };

export type PermissionModeOption = {
  mode: PermissionMode;
  label: string;
  tone: PermissionModeTone;
};

export const MODEL_MODE_LABELS: Record<ModelMode, string> = {
  default: "Default",
  sonnet: "Sonnet",
  opus: "Opus",
  fable: "Fable",
  haiku: "Haiku",
};

/**
 * Drop a model id's context-tier suffix: "claude-opus-5-5[1m]" →
 * "claude-opus-5-5". The "[" only ever appears as that suffix (the CLI strips it
 * from resolvedModel the same way, cli/src/claude/claudeRemote.ts). A raw spawn
 * pin (rawModel) keeps it, while catalog ids never carry it.
 */
export function stripModelTierSuffix(modelId: string): string {
  const bracket = modelId.indexOf("[");
  return bracket >= 0 ? modelId.slice(0, bracket) : modelId;
}

/**
 * Convert a raw model ID (e.g., "claude-opus-4-6") to a human-friendly name
 * (e.g., "Opus 4.6"). A context-tier suffix is dropped ("claude-opus-5-5[1m]"
 * → "Opus 5.5") and a bare alias maps to its mode label ("opus[1m]" → "Opus"),
 * so a spawn-time pin never surfaces as its technical string. Returns the ID
 * (suffix dropped) if the pattern doesn't match.
 */
export function formatModelName(modelId: string): string {
  const id = stripModelTierSuffix(modelId);

  if (id !== "default" && (MODEL_MODES as readonly string[]).includes(id)) {
    return MODEL_MODE_LABELS[id as ModelMode];
  }

  // Pattern: claude-{family}-{major}[-{minor}][-{date}]
  // Examples: claude-opus-4-6, claude-sonnet-4-5-20250929, claude-opus-4-20250514
  const match = id.match(/^claude-(\w+)-(\d+)(?:-(\d+))?(?:-(\d{8,}))?$/);
  if (!match) return id;

  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const major = match[2];
  const minor = match[3];
  const date = match[4];

  // If there's a "minor" that's actually a date (8+ digits), ignore it
  if (minor && minor.length >= 8) {
    return `${family} ${major}`;
  }
  // If minor is present and not a date, include it
  if (minor && !date) {
    // Could be "claude-opus-4-6" (minor=6) or "claude-opus-4-6-20250514" (minor=6, date present)
    return `${family} ${major}.${minor}`;
  }
  if (minor && date) {
    return `${family} ${major}.${minor}`;
  }
  return `${family} ${major}`;
}

export function getPermissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_LABELS[mode];
}

export function getPermissionModeTone(
  mode: PermissionMode
): PermissionModeTone {
  return PERMISSION_MODE_TONES[mode];
}

export function getPermissionModesForFlavor(
  flavor?: string | null
): readonly PermissionMode[] {
  if (flavor === "codex") {
    return CODEX_PERMISSION_MODES;
  }
  if (flavor === "gemini" || flavor === "opencode") {
    return [];
  }
  return CLAUDE_PERMISSION_MODES;
}

export function getPermissionModeOptionsForFlavor(
  flavor?: string | null
): PermissionModeOption[] {
  return getPermissionModesForFlavor(flavor).map(mode => ({
    mode,
    label: getPermissionModeLabel(mode),
    tone: getPermissionModeTone(mode),
  }));
}

export function isPermissionModeAllowedForFlavor(
  mode: PermissionMode,
  flavor?: string | null
): boolean {
  return getPermissionModesForFlavor(flavor).includes(mode);
}

/**
 * Narrow an arbitrary string (e.g. a manifest `permissionModes.modes[].id`) to a
 * canonical {@link PermissionMode}. Issue #3350: the manifest axis carries NATIVE
 * approval-mode ids (gemini's `auto_edit` / `plan`), and only the subset that is
 * a real `PermissionMode` can reach the spawn-wire `yolo` collapse or the picker's
 * value slot — a native-only id (`auto_edit`) has no `PermissionMode` and is
 * dropped from the honest spawn picker.
 */
export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Narrow an unknown value to a {@link ClaudePermissionMode} (#6218). The node's
 * default spawn permission mode is stored in Claude-tier vocabulary, and the
 * daemon's `--hapi-permission-mode` seed for a Claude session must be one, so
 * the CLI seed parser and the web preference hook share this one guard.
 */
export function isClaudePermissionMode(
  value: unknown
): value is ClaudePermissionMode {
  return (
    typeof value === "string" &&
    (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

/**
 * The model modes a flavor exposes (issue #3348 — manifest-delegated).
 *
 * 🔴 INVARIANT (blast-radius guard, ruling 1B): only the claude-modes native
 * catalog IS MODEL_MODES; every other flavor MUST keep returning `[]`. MODEL_MODES
 * is the CLAUDE-ONLY mode system (sonnet/opus/fable/haiku) — the gemini/codex model
 * axes are NOT "model modes". Four consumers gate on the empty array:
 * `ComposerModelEffortPicker.tsx:96`, `FullscreenPromptEditorModal.tsx`,
 * `ModelModePicker.tsx`, and the server guards `sessions.ts` / `machines.ts`.
 * Returning non-empty for a non-claude flavor would offer Sonnet/Opus/Fable on
 * codex/gemini and break both server guards.
 *
 * Delegates to the manifest instead of a hardcoded `flavor === "codex"|...`
 * conditional: the flavor's `modelSelection.catalogSources` carries the
 * `claude-modes` native catalog iff it drives MODEL_MODES. An unknown flavor (or
 * null) has no manifest → falls back to MODEL_MODES, preserving the pre-#3348
 * behavior where a null/unknown flavor returned the full claude set.
 */
export function getModelModesForFlavor(
  flavor?: string | null
): readonly ModelMode[] {
  const manifest = tryResolveHarnessManifest(flavor ?? "claude");
  if (!manifest) {
    return MODEL_MODES;
  }
  const hasClaudeModes = manifest.modelSelection.catalogSources.some(
    source => source.catalogId === "claude-modes"
  );
  return hasClaudeModes ? MODEL_MODES : [];
}

/**
 * The model-selection facts `deriveFormState`, the Create pickers, and the server
 * spawn guard read from a flavor's manifest axis (#3348). PURE + browser-safe (a
 * Record lookup over the static manifests). Distilled from the flavor's
 * `modelSelection` axis so no consumer re-parses `catalogSources` or writes a
 * `flavor === "x"` conditional (AC R4):
 *  - `nativeCatalogId`: the flavor's native-catalog discriminator
 *    (`claude-modes` | `gemini-native` | `codex-native` | `opencode-native`), or
 *    undefined when the flavor has no native catalog.
 *  - `hasOpenRouterSource`: whether the flavor can route via the OpenRouter gateway
 *    (the picker also requires the NODE to advertise gateway auth — a separate,
 *    per-node capability, NOT a per-flavor axis).
 *  - `reasoningEffortValues`: the accepted reasoning-effort values, or undefined
 *    when the flavor exposes no reasoning-effort selection.
 * An unknown flavor → all-empty (no pickers → the read-only provider chip).
 */
export type ModelSelectionFacts = {
  nativeCatalogId?: string;
  hasOpenRouterSource: boolean;
  reasoningEffortValues?: readonly string[];
};

export function resolveModelSelectionForFlavor(
  flavor?: string | null
): ModelSelectionFacts {
  const manifest = tryResolveHarnessManifest(flavor ?? "claude");
  if (!manifest) {
    return { hasOpenRouterSource: false };
  }
  const sources = manifest.modelSelection.catalogSources;
  const native = sources.find(source => source.source === "native-catalog");
  return {
    nativeCatalogId: native?.catalogId,
    hasOpenRouterSource: sources.some(
      source => source.source === "openrouter-gateway"
    ),
    reasoningEffortValues: manifest.modelSelection.reasoningEffort?.values,
  };
}

export function isModelModeAllowedForFlavor(
  mode: ModelMode,
  flavor?: string | null
): boolean {
  return getModelModesForFlavor(flavor).includes(mode);
}

/**
 * Issue #1951 (A4) — spawn-time permission posture helpers.
 *
 * The Create-Session form replaces the binary YOLO toggle with a per-flavor
 * permission-mode dropdown. `isYoloEquivalentMode` is the single canonical
 * collapse of a mode to the spawn `yolo` boolean (keeps A2's preview⟷spawn
 * single-source intact). Issue #6218: the spawn wire now ALSO carries the
 * selected `permissionMode`, which seeds the CLI's starting mode
 * (`--hapi-permission-mode`), so a non-YOLO pick such as Claude `acceptEdits`
 * really starts in that mode instead of collapsing to `default`.
 */

/** Modes that map to the spawn `yolo: true` boolean (full bypass / full yolo). */
const YOLO_EQUIVALENT_MODES: readonly PermissionMode[] = [
  "bypassPermissions",
  "yolo",
];

/**
 * True when the permission mode is a full-YOLO posture (`--yolo` /
 * `--dangerously-skip-permissions`). Codex `safe-yolo` and the gated modes
 * (default/acceptEdits/plan/read-only) are NOT yolo-equivalent — they collapse
 * to `yolo: false` at the spawn wire (the safe default; mapping safe-yolo to
 * true would upgrade it to full YOLO, an unintended permission level).
 */
export function isYoloEquivalentMode(mode: PermissionMode): boolean {
  return YOLO_EQUIVALENT_MODES.includes(mode);
}

/**
 * Per-flavor permission-mode options for the spawn-time dropdown ("honest
 * pickers only", operator ruling 2026-08-27 / issue #3350).
 *
 * For a flavor WITH in-session modes (claude, codex) this is identical to
 * {@link getPermissionModeOptionsForFlavor} — its full vocabulary is honest
 * because those modes remain switchable in-session after spawn (#1951 A4).
 *
 * For a flavor WITHOUT in-session modes (gemini, opencode) the spawn wire carries
 * only the `yolo` boolean, so the ONLY honest choices are the DISTINCT wire
 * postures the flavor's manifest `permissionModes` axis declares as spawn-set:
 * the gated default (`yolo:false`) and full-YOLO (`yolo:true`). We read the
 * manifest, filter to spawn-applicable modes whose id is a canonical
 * {@link PermissionMode}, and DEDUPE by yolo-equivalence — yielding at most a
 * two-option `{default, YOLO}` pair (or a single grayed default if the manifest
 * declares no spawn YOLO mode). This replaces the old hardcoded synthetic
 * `["default","yolo"]` literal (#3350 Task 2):
 *   - gemini: verified two-option pair — `--yolo` produces an observable
 *     `session/request_permission` difference under Hapimatic's ACP driver
 *     (default gates edits; `--yolo` auto-approves — #3350 Task 1). Its native
 *     `auto_edit`/`plan` modes collapse to the default wire posture and are NOT
 *     in-session switchable, so they are dropped (offering them would be a lie).
 *   - opencode: two-option pair sourced from its real allow/ask posture — the
 *     `yolo` bool reaches `buildOpenCodeConfigContent` (all-`allow` vs all-`ask`),
 *     a difference proven at spawn (`opencodeConfig.ts` + its tests).
 * The collapse itself is the single canonical {@link isYoloEquivalentMode} — no
 * new yolo-equivalent id is introduced (both flavors reuse the registered `yolo`),
 * so the anti-silent-upgrade invariant holds (#3350 R5).
 */
export function getSpawnPermissionModeOptionsForFlavor(
  flavor?: string | null
): PermissionModeOption[] {
  const inSessionOptions = getPermissionModeOptionsForFlavor(flavor);
  if (inSessionOptions.length > 0) return inSessionOptions;

  const manifest = tryResolveHarnessManifest(flavor ?? "");
  const spawnable = (manifest?.permissionModes.modes ?? []).filter(
    m => m.applicability === "spawn" || m.applicability === "both"
  );
  const seenWirePosture = new Set<boolean>();
  const options: PermissionModeOption[] = [];
  for (const mode of spawnable) {
    if (!isPermissionMode(mode.id)) continue;
    const wireYolo = isYoloEquivalentMode(mode.id);
    if (seenWirePosture.has(wireYolo)) continue;
    seenWirePosture.add(wireYolo);
    options.push({
      mode: mode.id,
      label: getPermissionModeLabel(mode.id),
      tone: getPermissionModeTone(mode.id),
    });
  }
  return options;
}

/**
 * Resolve a saved default permission mode against a target flavor (#1951 R4).
 * When the saved mode is valid for the flavor's spawn options, it is used as-is.
 * Otherwise the flavor's yolo-equivalent is chosen when the saved mode was
 * yolo-equivalent (preserving "default to YOLO" intent across flavors), else the
 * flavor's first option (its `default`).
 *
 * Issue #3350: this now resolves against the manifest-`permissionModes`-axis-sourced
 * options for gemini/opencode (the empty-in-session-set flavors), coherently —
 * a persisted `yolo` stays valid (both keep a YOLO option); any other persisted
 * mode falls back to the flavor's `default` (its first option).
 */
export function resolveSpawnPermissionMode(
  saved: PermissionMode,
  flavor?: string | null
): PermissionMode {
  const options = getSpawnPermissionModeOptionsForFlavor(flavor).map(
    o => o.mode
  );
  if (options.includes(saved)) return saved;
  if (isYoloEquivalentMode(saved)) {
    const yoloOption = options.find(isYoloEquivalentMode);
    if (yoloOption) return yoloOption;
  }
  return options[0] ?? "default";
}

/**
 * Issue #6218 — the default spawn permission posture: one step below YOLO for
 * each harness (operator direction 2026-11-03). Claude starts in accept
 * (auto-approves edits, prompts for shell), Codex in safe-YOLO; Gemini and
 * OpenCode offer only default and YOLO at spawn, so their default is `default`.
 * This is the ONE definition web, server and daemon read, so their defaults can
 * never drift (web CLAUDE.md "Frontend/Backend Preference Sync").
 */
export const SPAWN_PERMISSION_DEFAULTS: Readonly<
  Record<AgentFlavor, PermissionMode>
> = {
  claude: "acceptEdits",
  codex: "safe-yolo",
  gemini: "default",
  opencode: "default",
};

/**
 * The stored default-spawn-permission-mode preference's default value: Claude's
 * one-step-below-YOLO mode. The preference is a Claude-vocabulary mode (the
 * Settings radio offers the Claude modes) that
 * {@link resolveDefaultSpawnPermissionMode} maps onto each harness.
 */
export const DEFAULT_SPAWN_PERMISSION_MODE: ClaudePermissionMode =
  "acceptEdits";

/** The one-step-below-YOLO mode for a flavor; an unknown flavor gets Claude's. */
export function getDefaultSpawnPermissionMode(
  flavor?: string | null
): PermissionMode {
  return flavor &&
    Object.prototype.hasOwnProperty.call(SPAWN_PERMISSION_DEFAULTS, flavor)
    ? SPAWN_PERMISSION_DEFAULTS[flavor as AgentFlavor]
    : SPAWN_PERMISSION_DEFAULTS.claude;
}

/** True for a non-`default` one-step-below-YOLO mode of any flavor. */
function isOneBelowYoloMode(mode: PermissionMode): boolean {
  return (
    mode !== "default" &&
    Object.values(SPAWN_PERMISSION_DEFAULTS).includes(mode)
  );
}

/**
 * Resolve the SYSTEM-DEFAULT spawn permission mode (the node preference, or the
 * Create page's saved default) for a target flavor (#6218). A YOLO-equivalent
 * default maps to the flavor's YOLO option; a one-step-below-YOLO default (Claude
 * `acceptEdits`, Codex `safe-yolo`) maps to the flavor's own one-step-below-YOLO
 * mode; anything else resolves as {@link resolveSpawnPermissionMode} does.
 *
 * Only the system default takes this tier mapping. An explicit pick or a
 * Create-page bookmark keeps {@link resolveSpawnPermissionMode}'s mapping, so a
 * user's explicit Claude `acceptEdits` is never widened to Codex `safe-yolo`.
 */
export function resolveDefaultSpawnPermissionMode(
  pref: PermissionMode,
  flavor?: string | null
): PermissionMode {
  if (isYoloEquivalentMode(pref)) {
    return resolveSpawnPermissionMode(pref, flavor);
  }
  if (isOneBelowYoloMode(pref)) {
    return getDefaultSpawnPermissionMode(flavor);
  }
  return resolveSpawnPermissionMode(pref, flavor);
}

/** The resolved permission posture of one spawn request (#6218). */
export type SpawnPosture =
  | {
      ok: true;
      /** The spawn-wire `yolo` boolean. */
      yolo: boolean;
      /** The starting mode; absent for a legacy explicit `yolo` request. */
      permissionMode?: PermissionMode;
    }
  | { ok: false; error: string };

/**
 * Resolve a spawn request's permission posture (#6218), at the server spawn
 * choke point and in the daemon:
 * - `permissionMode` given → it must be one of the flavor's spawn options;
 *   `yolo` follows from it, and a contradicting explicit `yolo` is an error.
 * - `permissionMode` absent, `yolo: true` → YOLO, as before.
 * - `permissionMode` absent, `yolo: false` → not YOLO with NO starting-mode seed,
 *   byte-identical to before: the session starts at its saved posture, else
 *   `default` (a reconnect relies on this).
 * - both absent → the default, `fallbackMode` (the node preference) or else
 *   {@link DEFAULT_SPAWN_PERMISSION_MODE}, resolved for the flavor. An omitted
 *   posture is never YOLO unless the default itself is YOLO.
 */
export function resolveSpawnPosture(input: {
  yolo?: boolean;
  permissionMode?: PermissionMode;
  flavor?: string | null;
  fallbackMode?: PermissionMode;
}): SpawnPosture {
  const { yolo, permissionMode, flavor } = input;
  if (permissionMode !== undefined) {
    const options = getSpawnPermissionModeOptionsForFlavor(flavor).map(
      o => o.mode
    );
    if (!options.includes(permissionMode)) {
      return {
        ok: false,
        error: `Permission mode "${permissionMode}" is not available for a "${flavor ?? "claude"}" session (choose one of: ${options.join(", ")})`,
      };
    }
    const modeIsYolo = isYoloEquivalentMode(permissionMode);
    if (yolo !== undefined && yolo !== modeIsYolo) {
      return {
        ok: false,
        error: `yolo: ${yolo} conflicts with permissionMode "${permissionMode}"`,
      };
    }
    return { ok: true, yolo: modeIsYolo, permissionMode };
  }
  if (yolo !== undefined) {
    return { ok: true, yolo };
  }
  const mode = resolveDefaultSpawnPermissionMode(
    input.fallbackMode ?? DEFAULT_SPAWN_PERMISSION_MODE,
    flavor
  );
  return { ok: true, yolo: isYoloEquivalentMode(mode), permissionMode: mode };
}

/**
 * Issue #6218 (absorbs #5353 R1-R2): the `yolo` a respawn derives from a
 * session's saved posture (`metadata.permissionMode`). A saved bypass mode
 * respawns in YOLO and any other saved mode does not; the CLI then restores the
 * saved mode. An absent or invalid posture keeps the legacy always-bypass
 * respawn, so a session recorded before the spawn-time stamp behaves as before.
 */
export function respawnYoloFromPosture(saved: unknown): boolean {
  if (typeof saved === "string" && isPermissionMode(saved)) {
    return isYoloEquivalentMode(saved);
  }
  return true;
}

/**
 * Issue #6218 — the posture a NEW session inherits from the session it
 * continues (a branch, a context-watermark successor). `yolo` follows
 * {@link respawnYoloFromPosture}; because the new session has no saved posture
 * of its own, a saved non-bypass mode is also sent as its starting-mode seed
 * when the target harness can spawn in that mode (otherwise it starts at
 * `default`, still not YOLO).
 */
export function inheritSpawnPosture(
  saved: unknown,
  flavor?: string | null
): { yolo: boolean; permissionMode?: PermissionMode } {
  const yolo = respawnYoloFromPosture(saved);
  if (yolo || typeof saved !== "string" || !isPermissionMode(saved)) {
    return { yolo };
  }
  const seeded = resolveSpawnPosture({ permissionMode: saved, flavor });
  return seeded.ok && seeded.permissionMode
    ? { yolo: false, permissionMode: seeded.permissionMode }
    : { yolo: false };
}

/** Issue #6218 (ruling D5-a): how much a permission mode lets a session do unasked. */
export type SpawnPermissionRank = 0 | 1 | 2;

/**
 * Issue #6218 (ruling D5-a) — the rank of a permission mode, for the agent
 * spawn floor: 0 for the prompting modes (`default`, `plan`, `read-only`), 1 for
 * the one-step-below-YOLO modes (`acceptEdits`, `safe-yolo`), 2 for YOLO.
 */
export function spawnPermissionRank(mode: PermissionMode): SpawnPermissionRank {
  if (isYoloEquivalentMode(mode)) return 2;
  return mode === "acceptEdits" || mode === "safe-yolo" ? 1 : 0;
}

/**
 * Issue #6218 (ruling D5-a) — the rank of a resolved spawn posture: 2 whenever
 * `yolo` is true, else its mode's rank, else 0 for a bare `yolo: false` (which
 * starts at `default` or the saved posture). `yolo: true` wins over the mode so
 * an inconsistent pair ranks fail-closed; `resolveSpawnPosture` never returns
 * one.
 */
export function spawnPostureRank(posture: {
  yolo: boolean;
  permissionMode?: PermissionMode;
}): SpawnPermissionRank {
  if (posture.yolo) return 2;
  return posture.permissionMode !== undefined
    ? spawnPermissionRank(posture.permissionMode)
    : 0;
}

/**
 * Issue #6218 (ruling D5-a) — clamp a mode down to `maxRank` for a harness: the
 * mode itself when it is within the rank, else the flavor's highest-ranked
 * spawn option at or below it, preferring the flavor's default spawn mode and
 * then `default` within that rank (never `plan` or `read-only` unless the
 * harness offers nothing else).
 */
export function clampSpawnPermissionMode(
  mode: PermissionMode,
  maxRank: SpawnPermissionRank,
  flavor?: string | null
): PermissionMode {
  if (spawnPermissionRank(mode) <= maxRank) return mode;
  const candidates = getSpawnPermissionModeOptionsForFlavor(flavor)
    .map(o => o.mode)
    .filter(m => spawnPermissionRank(m) <= maxRank);
  if (candidates.length === 0) return "default";
  const top = Math.max(...candidates.map(spawnPermissionRank));
  const tier = candidates.filter(m => spawnPermissionRank(m) === top);
  const flavorDefault = getDefaultSpawnPermissionMode(flavor);
  if (tier.includes(flavorDefault)) return flavorDefault;
  if (tier.includes("default")) return "default";
  return tier[0] ?? "default";
}
