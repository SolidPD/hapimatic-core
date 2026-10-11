// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Harness capability manifest — the machine-readable description of ONE CLI
 * harness's capabilities across the axes the Harness Abstraction Layer (HAL)
 * cares about (epic #3117, Sub-Issue C keystone / issue #3118).
 *
 * This is the SINGLE SOURCE OF TRUTH consumed by three downstream surfaces: the
 * Extensions page install/uninstall (#3120), the Create page capability chips
 * (#3121), and the projection compiler — what to materialize vs degrade
 * (#3122). It replaces ad-hoc `agent === "claude"` conditionals with data.
 *
 * Kept zod-only (NO node/server/web imports) so it is importable by every
 * package — cli, server, AND the browser web bundle — mirroring the
 * `@hapi/protocol/ext` browser-safe contract. The stock-4 manifest DATA + the
 * registry live alongside this schema under `shared/src/harnessManifests/`
 * (expert ruling D1a / epic CG-1): the server consumer
 * (`server/src/federation/capabilityDetector.ts`) can import `@hapi/protocol`
 * but NOT `cli`, so a cli-placed registry would leave it no import path.
 *
 * Each capability AXIS is expressed as a TRI-STATE (`native` | `emulated` |
 * `absent`) plus axis-specific detail, so downstream consumers choose a
 * PROJECTION STRATEGY (materialize / emulate / degrade) instead of
 * boolean-gating. The object schemas are STRICT (`z.strictObject`) so a
 * mistyped axis or a stale field fails validation — this is our own internal
 * data, not upstream-originated, so the `.passthrough()` forgiveness that other
 * shared schemas use does not apply here.
 */
import { z } from "zod";
import type { AgentFlavor } from "./modes";

/**
 * The tri-state every capability axis resolves to. `native` = the CLI does it
 * itself; `emulated` = HAL can synthesize it (e.g. via instruction-file
 * injection or a shim); `absent` = unavailable, downstream must degrade.
 */
export const triStateSchema = z.enum(["native", "emulated", "absent"]);
export type TriState = z.infer<typeof triStateSchema>;

/**
 * Canonical stock-4 agent id. Kept in exact sync with `AgentFlavor`
 * (`shared/src/modes.ts`); the compile-time assertion below fails the build if
 * the two ever drift (OR4). A `z.enum` (not `z.custom`) gives real RUNTIME
 * validation of an unknown id — `z.custom<AgentFlavor>()` would accept any
 * string at runtime.
 */
export const agentFlavorSchema = z.enum([
  "claude",
  "codex",
  "gemini",
  "opencode",
]);

// Compile-time drift guard (OR4): `agentFlavorSchema`'s members MUST equal
// `AgentFlavor` exactly, in both directions. If a new `AgentFlavor` is added in
// modes.ts without updating this enum (or vice-versa), one of these conditional
// types collapses to `never` and the assignment fails typecheck.
type _AgentFlavorMatchesEnum = [AgentFlavor] extends [
  z.infer<typeof agentFlavorSchema>,
]
  ? [z.infer<typeof agentFlavorSchema>] extends [AgentFlavor]
    ? true
    : never
  : never;
const _agentFlavorDriftGuard: _AgentFlavorMatchesEnum = true;
void _agentFlavorDriftGuard;

/**
 * Skills axis: `native-dir` = discovered from a directory; `injected` =
 * delivered via instruction-file / prompt injection (no native discovery);
 * `none`.
 */
export const skillsAxisSchema = z.strictObject({
  mode: z.enum(["native-dir", "injected", "none"]),
  /** Where native-dir skills are discovered (e.g. `.claude/skills/`). */
  discoveryPath: z.string().optional(),
});

/**
 * Hooks axis: `native-taxonomy` = native lifecycle-event hooks (the Claude hook
 * taxonomy, now cloned by several CLIs); `plugin-shim` = hooks via a JS plugin
 * shim; `none`.
 */
export const hooksAxisSchema = z.strictObject({
  mode: z.enum(["native-taxonomy", "plugin-shim", "none"]),
  /** Dialect id of the hook config format (e.g. `claude-settings-json`). */
  dialectId: z.string().optional(),
});

/** MCP axis: which config format the CLI reads MCP servers from. */
export const mcpAxisSchema = z.strictObject({
  configFormatId: z.string(),
});

/**
 * Instruction-file axis. `semantics` distinguishes the two instruction-file
 * FAMILIES: the vendor-neutral `AGENTS.md` LF standard vs a vendor-specific
 * `CLAUDE.md`-style file (GEMINI.md behaves like the latter — a per-vendor
 * instruction file). A root `AGENTS.md` silently disables `CLAUDE.md`, so HAL
 * must compile per-CLI rather than write one root file (epic #3117 note).
 */
export const instructionFileAxisSchema = z.strictObject({
  name: z.string(),
  placement: z.string(),
  semantics: z.enum(["AGENTS.md", "CLAUDE.md"]),
});

/** ACP (Agent Client Protocol) axis — server and client support, each tri-state. */
export const acpAxisSchema = z.strictObject({
  server: triStateSchema,
  client: triStateSchema,
});

/** Headless (non-interactive) execution axis. */
export const headlessExecAxisSchema = z.strictObject({
  /** Subcommands / flags that run non-interactively (e.g. `print`, `exec`). */
  modes: z.array(z.string()),
  /** Output formats the headless mode can emit (e.g. `json`, `stream-json`). */
  outputFormats: z.array(z.string()),
});

/**
 * Session-persistence axis — whether the CLI survives inside a tmux window
 * (Hapimatic's durable-session mechanism).
 */
export const sessionPersistenceAxisSchema = z.strictObject({
  tmuxSafe: z.boolean(),
});

/**
 * Model-selection axis (issue #3346, epic #3345). Which model CATALOGS a harness
 * can select a model from, and whether a switch is live or needs a relaunch.
 * Consumed by #3348/#3349 (the model pickers).
 */
export const modelSelectionAxisSchema = z.strictObject({
  /**
   * Ruling D1(a): every catalog this flavor can select models from —
   * multi-valued because dual-source flavors exist (codex ChatGPT-native +
   * OpenRouter after #3348; opencode native + OpenRouter after #3349). EMPTY
   * ARRAY = no model selection at all (replaces the old single-enum "none").
   */
  catalogSources: z.array(
    z.strictObject({
      source: z.enum(["native-catalog", "openrouter-gateway"]),
      /**
       * WHICH catalog this source binds — the discriminator consumers need to
       * pick MODEL_MODES vs the gemini catalog vs the OpenRouter list (claude
       * and gemini are both "native-catalog"; without this id, formState cannot
       * select between them from the axis alone). Closed enum by design — the
       * sub that introduces a new catalog extends it (compile-time guard,
       * matching the file's strictness philosophy).
       */
      catalogId: z.enum([
        "claude-modes",
        "codex-native",
        "gemini-native",
        "opencode-native",
        "openrouter",
      ]),
    })
  ),
  /** Whether a model switch applies live (in-session) or needs a relaunch. */
  switchSemantics: z.enum(["live", "relaunch"]),
  /**
   * Reasoning-effort support (issue #3348). ABSENT = this flavor exposes NO
   * reasoning-effort selection (gemini, opencode). PRESENT = the accepted effort
   * `values` the picker offers for this flavor — the SUPERSET; per-model narrowing
   * (where a flavor has it, e.g. claude via the live catalog's per-model
   * `effortLevels`, codex via `codexModelCatalog`) happens downstream. Optional +
   * additive: #3346 deliberately deferred this field, so an un-updated manifest is
   * byte-identical (the axis alone reads absent → no effort row). The value sets
   * differ per flavor (claude = `EFFORT_LEVELS` low..max; codex = `low..ultra`,
   * codex's own vocabulary) — that is WHY it is a per-flavor `values[]`, not a
   * single shared enum.
   */
  reasoningEffort: z
    .strictObject({
      values: z.array(z.string().min(1)).min(1),
    })
    .optional(),
});

/**
 * Permission-modes axis (issue #3346). The harness's native permission/approval
 * modes, each tagged with WHERE it applies. Consumed by #3350 (the permission
 * picker).
 */
export const permissionModesAxisSchema = z.strictObject({
  /**
   * Per-MODE applicability (finding 3346-2; #3350 R4 reads per-mode): a single
   * flavor-level value cannot express claude's split (only the collapsed `yolo`
   * boolean travels on the spawn wire; acceptEdits/plan are in-session-only),
   * and codex switches modes in-session today.
   */
  modes: z.array(
    z.strictObject({
      id: z.string().min(1), // native mode id (e.g. codex: default/read-only/safe-yolo/yolo)
      applicability: z.enum(["spawn", "in-session", "both"]),
    })
  ),
});

/**
 * Usage-reporting axis (issue #3346). Whether the harness reports token usage,
 * and at what fidelity. Consumed by #3352 (usage ingestion) / #3353 (cost).
 */
export const usageReportingAxisSchema = z.strictObject({
  mode: z.enum(["native", "absent"]),
  /** Machine-branchable fields (finding 3346-4; #3352 R4 + #3353 honest-degrade branch on these). */
  granularity: z.enum(["per-turn", "session-total", "none"]),
  cacheSplit: z.boolean(), // cache-read/write token split reported?
  contextWindow: z.boolean(), // context-window size/usage reported?
  note: z.string().optional(), // prose nuance only — consumers never branch on it
});

/**
 * Auth-binding axis (issue #3346). The credential KINDS Hapimatic can bind for
 * this harness. Consumed by #3351 (auth-binding record) / #3353 (cost display).
 */
export const authBindingAxisSchema = z.strictObject({
  /**
   * Ruling D5: "inherited" = Hapimatic delivers NO credential for this harness;
   * it inherits whatever auth the host environment already holds. #3353
   * classifies "inherited" as no-discriminator (neutral "—", no EQ/mint claim).
   */
  kinds: z.array(
    z.enum(["subscription-account", "api-key", "gateway-key", "inherited"])
  ),
});

/**
 * Capability-injection axis (issue #3748, Sub H). HOW the Tier-0 capability
 * catalog is delivered into this harness's context:
 * - `"system-prompt"`: appended to the Claude system prompt (survives transcript
 *   trims) — Claude only;
 * - `"developer-instructions"`: Codex `developer_instructions`;
 * - `"first-turn-prompt"`: a leading text block on the FIRST agent turn
 *   (Gemini/opencode via ACP) — a USER-turn injection, NOT a system prompt: it
 *   lands in transcript/session history and does NOT survive a transcript trim;
 * - `"none"`: Tier-0 is not injected on this harness (a `waiver` is REQUIRED
 *   explaining why — e.g. no carrier).
 *
 * Under `--safe-mode` Claude's `buildSystemPrompt` is skipped on every path
 * (R4a), so a safe-mode Claude session carries NO Tier-0 regardless of this
 * axis; the `HAPI_CAPABILITY_TIER0=0` kill-switch likewise disables injection on
 * every harness (R8).
 */
export const capabilityInjectionAxisSchema = z
  .strictObject({
    mode: z.enum([
      "system-prompt",
      "developer-instructions",
      "first-turn-prompt",
      "none",
    ]),
    /** REQUIRED when `mode` is `"none"` — why Tier-0 is not delivered here. */
    waiver: z.string().optional(),
    /**
     * Per-axis verification stamp (R7). NOT `verifiedAgainst` — that is the
     * top-level manifest field (`:138`) and is carried by no other axis.
     */
    verifiedOn: z.string().optional(),
  })
  .refine(
    a => a.mode !== "none" || (a.waiver !== undefined && a.waiver.length > 0),
    {
      message: "capabilityInjection.mode 'none' requires a non-empty waiver",
      path: ["waiver"],
    }
  );

/**
 * Native-session-id axis (issue #3811). Declares, PER FLAVOR, the harness's own
 * native session identifier so `SessionIdDisplay` is harness-neutral instead of
 * Claude-hardcoded. `field` names the EXISTING `metadata` field that carries the
 * id (each flavor keeps its own: claude → `claudeSessionId`, codex →
 * `codexSessionId`, gemini/opencode/ACP tier-2 → the shared `acpSessionId`);
 * `label` is a SHORT human label for the native id ("Claude"); since #4479 the
 * web UI no longer reads it and labels every native id "CLI ID". `description`
 * is the long tooltip/doc text, still shown as the dialog's hover tooltip.
 *
 * OPTIONAL axis — an absent key means `absent` (see {@link
 * NATIVE_SESSION_ID_ABSENT} / {@link resolveNativeSessionIdAxis}); tier-2 catalog
 * recipes need no entry; every STOCK manifest declares it explicitly (enforced by
 * `manifests.test.ts`). This is the K5 optional-axis convention #3811 OWNS and
 * #3813's `hostJail` CONSUMES — both are optional with a defined default so the
 * strict-schema ripple across the tier-2 recipes and literal fixtures is avoided.
 */
export const nativeSessionIdAxisSchema = z
  .strictObject({
    mode: z.enum(["native", "absent"]),
    /** The `metadata` field carrying this flavor's native session id. */
    field: z
      .enum(["claudeSessionId", "codexSessionId", "acpSessionId"])
      .optional(),
    /** SHORT label the UI composes as `${label} ID` (e.g. "Claude", "Codex"). */
    label: z.string().optional(),
    /** Long tooltip / doc text (e.g. "Claude session ID (UUID from Claude Code)"). */
    description: z.string().optional(),
  })
  .refine(
    a =>
      a.mode !== "native" || (a.field !== undefined && a.label !== undefined),
    {
      message: "nativeSessionId.mode 'native' requires field + label",
      path: ["field"],
    }
  );

/** Parsed shape of the native-session-id axis. */
export type NativeSessionIdAxis = z.infer<typeof nativeSessionIdAxisSchema>;

/**
 * The default the {@link nativeSessionIdAxisSchema} resolves to when a manifest
 * omits the axis — an absent key means the harness has no UI-surfaced native
 * session id (tier-2 CLIs).
 */
export const NATIVE_SESSION_ID_ABSENT = { mode: "absent" } as const;

/**
 * Resolve a manifest's native-session-id axis, defaulting to {@link
 * NATIVE_SESSION_ID_ABSENT} when the OPTIONAL key is omitted. The single accessor
 * the web `SessionIdDisplay` path and `manifests.test.ts` read, so an absent axis
 * can never surface as `undefined` at a usage site.
 */
export function resolveNativeSessionIdAxis(
  manifest: HarnessManifest
): NativeSessionIdAxis {
  return manifest.nativeSessionId ?? NATIVE_SESSION_ID_ABSENT;
}

/**
 * Host-jail axis (issue #3813). Declares, PER FLAVOR, what Hapimatic's OmniBox
 * bwrap HOST jail (`HAPI_OMNIBOX_SANDBOX`, `cli/src/daemon/tmuxSpawnAdapter.ts`)
 * must do to run this harness's child successfully and safely INSIDE the jail:
 * - `reexposeHomeDirs` — home-relative dirs the jail RW-re-exposes over the
 *   `--tmpfs $HOME` mask (codex → `[".codex"]`). `~/.claude` is ALWAYS bound (it
 *   holds the absolute-path hooks/skills every session runs), so it need not be
 *   listed to be re-exposed — claude lists it only to declare the axis explicitly.
 * - `egressHosts` — the inference/auth hosts this harness ADDS to the NODE-WIDE
 *   egress allowlist BEYOND `DEFAULT_EGRESS_ALLOWLIST` (`sandbox/egressPolicy.ts`;
 *   the Anthropic hosts already live there, so claude adds none).
 * - `keepSecrets` — the provider secret(s) the child KEEPS when the per-flavor
 *   wrapper→child strip runs (`sandbox/secretEnvVars.buildHarnessChildEnv`): a
 *   codex child keeps `OPENAI_API_KEY`, a gemini child keeps
 *   `GEMINI_API_KEY`/`GOOGLE_API_KEY`; every child still loses the rest of
 *   `SECRET_ENV_VARS`.
 *
 * ⚠️ NAME-DISTINGUISHED from `sandboxing` (`:352`, the tri-state consumed by
 * `capabilityGate.ts`/`compiler.ts`/`agentPlugins.ts`): that axis describes the
 * harness's OWN sandbox CAPABILITY (does this CLI sandbox its own tool calls?).
 * `hostJail` is orthogonal — what Hapimatic's HOST jail must do FOR this harness.
 * Never fold one into the other.
 *
 * OPTIONAL axis — an absent key means `absent` (see {@link HOST_JAIL_ABSENT} /
 * {@link resolveHostJailAxis}); tier-2 catalog recipes need no entry; every STOCK
 * manifest declares it explicitly (enforced by `manifests.test.ts`). This is the
 * SAME K5 optional-axis convention {@link nativeSessionIdAxisSchema} (#3811) owns
 * and #3813's `hostJail` consumes — both optional with a defined default so the
 * strict-schema ripple across tier-2 recipes and literal fixtures is avoided.
 */
export const hostJailAxisSchema = z
  .strictObject({
    mode: z.enum(["native", "absent"]),
    /** Home-relative dirs to RW-re-expose in the jail (`~/.claude` is always bound). */
    reexposeHomeDirs: z.array(z.string()),
    /** Inference/auth hosts this harness ADDS to the node-wide egress allowlist. */
    egressHosts: z.array(z.string()),
    /** Provider secret(s) the child KEEPS through the per-flavor strip. */
    keepSecrets: z.array(z.string()),
  })
  .refine(
    a =>
      a.mode !== "absent" ||
      (a.reexposeHomeDirs.length === 0 &&
        a.egressHosts.length === 0 &&
        a.keepSecrets.length === 0),
    {
      message:
        "hostJail.mode 'absent' requires reexposeHomeDirs/egressHosts/keepSecrets all empty",
      path: ["mode"],
    }
  );

/** Parsed shape of the host-jail axis. */
export type HostJailAxis = z.infer<typeof hostJailAxisSchema>;

/**
 * The default {@link hostJailAxisSchema} resolves to when a manifest omits the
 * OPTIONAL axis — no host-jail needs (tier-2 CLIs, or a harness never jailed).
 * Typed as {@link HostJailAxis} (NOT `as const`): unlike {@link
 * NATIVE_SESSION_ID_ABSENT} — which has no array fields — an `as const` here
 * would infer `readonly []`, not assignable to the schema's mutable `string[]`.
 */
export const HOST_JAIL_ABSENT: HostJailAxis = {
  mode: "absent",
  reexposeHomeDirs: [],
  egressHosts: [],
  keepSecrets: [],
};

/**
 * Resolve a manifest's host-jail axis, defaulting to {@link HOST_JAIL_ABSENT}
 * when the OPTIONAL key is omitted. The single accessor the bwrap builder
 * (`tmuxSpawnAdapter.ts`), the egress-host aggregator (`harnessEgressHosts`), the
 * per-flavor strip helper (`buildHarnessChildEnv`) and `manifests.test.ts` read,
 * so an absent axis can never surface as `undefined` at a usage site.
 */
export function resolveHostJailAxis(manifest: HarnessManifest): HostJailAxis {
  return manifest.hostJail ?? HOST_JAIL_ABSENT;
}

/**
 * The full harness capability manifest for one CLI. STRICT: an unknown axis key
 * is rejected (the AC's "strict Zod schema"), so a mistyped or stale field
 * fails validation rather than silently passing.
 */
export const harnessManifestSchema = z.strictObject({
  /** Canonical agent id (stock-4). */
  agentId: agentFlavorSchema,
  /**
   * The CLI version range this manifest's axes were verified against (R3),
   * e.g. `"claude-code >=2.0.0 <3.0.0"`.
   */
  verifiedAgainst: z.string().min(1),
  skills: skillsAxisSchema,
  hooks: hooksAxisSchema,
  mcp: mcpAxisSchema,
  instructionFile: instructionFileAxisSchema,
  acp: acpAxisSchema,
  headlessExec: headlessExecAxisSchema,
  subagents: triStateSchema,
  sessionPersistence: sessionPersistenceAxisSchema,
  sessionRoles: triStateSchema,
  outputStyles: triStateSchema,
  sandboxing: triStateSchema,
  // Session-UX & telemetry parity axes (issue #3346, epic #3345). Five
  // downstream subs bind to these shapes (#3348–#3353) — do not re-flatten.
  modelSelection: modelSelectionAxisSchema,
  permissionModes: permissionModesAxisSchema,
  usageReporting: usageReportingAxisSchema,
  authBinding: authBindingAxisSchema,
  // Capability-injection axis (issue #3748, Sub H): HOW Tier-0 reaches this harness.
  capabilityInjection: capabilityInjectionAxisSchema,
  // Native-session-id axis (issue #3811): the harness's own native session id
  // (field + label + description) so SessionIdDisplay is harness-neutral. OPTIONAL
  // (an absent key means `absent`) — the K5 convention #3811 owns / #3813 consumes.
  nativeSessionId: nativeSessionIdAxisSchema.optional(),
  // Host-jail axis (issue #3813): what Hapimatic's OmniBox bwrap HOST jail must do
  // to run this harness's child (re-expose dirs, egress hosts, kept secrets).
  // OPTIONAL (an absent key means `absent`) — the SAME K5 convention nativeSessionId
  // uses. Name-distinguished from `sandboxing` above (the harness's OWN sandbox
  // capability); see {@link hostJailAxisSchema}.
  hostJail: hostJailAxisSchema.optional(),
});

/** Parsed shape of a harness capability manifest. */
export type HarnessManifest = z.infer<typeof harnessManifestSchema>;
