// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Core shared-protocol schema barrel; grew past the
   1500-line ceiling when #2623 (epic #2622 Sub-Issue A) added the chat-detail /
   output-style preference schemas, and siblings B/C/D add more. Same convention
   as `web/src/api/client.ts`. Decomposition (extract preference schemas into a
   dedicated `shared/src/preferences.ts`) is a candidate follow-up. */
import { z } from "zod";
import {
  CLAUDE_PERMISSION_MODES,
  MODEL_MODES,
  PERMISSION_MODES,
} from "./modes";
import { EFFORT_LEVELS } from "./effort";
import { ClaudeRemoteLauncherKindSchema } from "./launcherResolver";
import { FileClaimSyncSnapshotSchema } from "./fileClaims";
import { hookCoverageRecordSchema } from "./messageHookConfig";
import { SPEND_LIMIT_VARIANTS } from "./apiErrorClasses";
import { AccountMonogramSchema } from "./accountMonogram";

export const PermissionModeSchema = z.enum(PERMISSION_MODES);
/** Issue #2346: the Claude-only permission-mode subset (no codex modes). The
 * set-permission-mode route validates against THIS (not the wide PermissionMode
 * enum) because set_permission_mode is a Claude control that bypasses runClaude's
 * resolvePermissionMode flavor check — so the boundary must reject codex modes. */
export const ClaudePermissionModeSchema = z.enum(CLAUDE_PERMISSION_MODES);
export const ModelModeSchema = z.enum(MODEL_MODES);
/** Issue #2456: reasoning-effort level for a Claude session (`--effort`). */
export const EffortLevelSchema = z.enum(EFFORT_LEVELS);

/**
 * Issue #3348: the bundled non-claude native model selection carried on the
 * SPAWN wire. `modelId` is the gemini model id (→ `GEMINI_MODEL` env) OR the codex
 * ChatGPT-token model id (→ config.toml bake) — interpreted by AGENT at the
 * daemon; `reasoningEffort` is codex's config.toml `model_reasoning_effort`. ONE
 * field threaded through every spawn hop (minimal #1262 surface). Permissive
 * bounded strings (like `rawModel`): the web UI is the axis-constrained source of
 * truth (the picker only offers manifest-declared values), and gemini/codex reject
 * an invalid value at spawn. Shared so the local `spawnBodySchema` (machines.ts)
 * and the federation spawn mirror (federation.ts) validate identically. Omitted
 * for claude / OpenRouter / opencode → those spawns stay byte-identical.
 */
export const NativeModelSelectionSchema = z.object({
  modelId: z.string().min(1).max(200).optional(),
  reasoningEffort: z.string().min(1).max(32).optional(),
});
export type NativeModelSelection = z.infer<typeof NativeModelSelectionSchema>;

/**
 * Issue #3349 (epic #3345, ruling D4(a)): the explicit native-vs-OpenRouter model
 * ROUTING discriminator carried on the SPAWN wire. Today `options.model` presence
 * MEANS OpenRouter (sessionSpawner.ts model-presence comment) — the wire cannot
 * otherwise express that an opencode `provider/model` selection is a NATIVE
 * provider rather than an OpenRouter-gateway model. This closed enum makes the
 * routing EXPLICIT so the daemon never has to re-derive it from string shape:
 * - `"native"`  → the selected `model` is a native `provider/model`; resolve the
 *   provider's key from the #1955 apiKeys vault and emit a native provider block.
 * - `"openrouter"` → route through the OpenRouter gateway (the existing branch).
 *
 * OPTIONAL + additive by design (R6 / #1262 skew-safety): an OLD peer that drops
 * the unknown field, OR a legacy client that never sends it, degrades SAFELY to
 * today's model-presence-means-OpenRouter semantics (absent + model ⇒ OpenRouter).
 * The web client emits `"native"` ONLY for the opencode native picker and OMITS
 * the field for OpenRouter, so an OpenRouter spawn stays byte-identical (R5) — the
 * same "emit only the non-default" discipline `modelMode` uses. Shared so the
 * local `spawnBodySchema` (machines.ts) and the federation spawn mirror
 * (federation.ts) validate identically.
 */
export const MODEL_ROUTINGS = ["native", "openrouter"] as const;
export const ModelRoutingSchema = z.enum(MODEL_ROUTINGS);
export type ModelRouting = z.infer<typeof ModelRoutingSchema>;

/**
 * Issue #3083: shared partial live-plane config for the four §4.2 routes
 * (permission-mode / model / effort / raw-model). The client route,
 * `SessionService.applySessionConfig`, and the `/federation/sessions/:id/apply-config`
 * receiver all share it — mirrors how `RelaunchRequestSchema` is shared. `rawModel`
 * carries `.max(200)` to match the hub route's `rawModelSchema` so the receiver never
 * accepts a body the hub rejects. Reuses the enum schemas above (not redeclared).
 */
export const ApplySessionConfigSchema = z
  .object({
    permissionMode: PermissionModeSchema.optional(),
    modelMode: ModelModeSchema.optional(),
    effort: EffortLevelSchema.optional(),
    rawModel: z.string().min(1).max(200).optional(),
  })
  .refine(v => Object.values(v).some(x => x !== undefined), {
    message: "At least one config field required",
  });
export type ApplySessionConfig = z.infer<typeof ApplySessionConfigSchema>;

/**
 * Issue #2155: the session's ROLE, selected at spawn and FROZEN for the
 * session's lifetime (mirrors launcherKind's spawn-frozen semantics). Drives
 * role-scoped `@`-include profile selection — a role resolves to a settings
 * file whose `claudeMdExcludes` trims the instruction stack that role never
 * uses (worker/pm/researcher/closer). `interactive` is intentionally NOT a
 * profile key: an interactive (user-opened) session loads the FULL stack, so
 * it resolves to no profile (fail-open). An absent or unrecognized role also
 * loads the full stack — completeness over a starved context (R3).
 */
export const SESSION_ROLES = [
  "pm",
  "worker",
  "researcher",
  "closer",
  "interactive",
] as const;
export const SessionRoleSchema = z.enum(SESSION_ROLES);
export type SessionRole = z.infer<typeof SessionRoleSchema>;

const MetadataSummarySchema = z.object({
  text: z.string(),
  updatedAt: z.number(),
});

export const WorktreeMetadataSchema = z
  .object({
    basePath: z.string(),
    branch: z.string(),
    name: z.string(),
    worktreePath: z.string().optional(),
    createdAt: z.number().optional(),
  })
  .passthrough();

export type WorktreeMetadata = z.infer<typeof WorktreeMetadataSchema>;

/**
 * Claude account info extracted from ~/.claude/.credentials.json and ~/.claude.json
 * Used to display the user's plan (Pro, Max 5X, Max 20X) and email per session
 */
export const ClaudeAccountInfoSchema = z
  .object({
    /** The subscription type: "pro" or "max" */
    subscriptionType: z.string().optional(),
    /** The rate limit tier: e.g. "default_claude_pro", "default_claude_max_5x", "default_claude_max_20x" */
    rateLimitTier: z.string().optional(),
    /** Display label computed from subscription + tier */
    planLabel: z.string().optional(),
    /** Email address from OAuth account (stored in ~/.claude.json) */
    email: z.string().optional(),
  })
  .passthrough();

export type ClaudeAccountInfo = z.infer<typeof ClaudeAccountInfoSchema>;

/**
 * Auth-binding record (issue #3351, epic #3345 Sub-Issue F). WHICH auth identity
 * a session is bound to at spawn — the per-flavor sibling of {@link
 * ClaudeAccountInfoSchema}. Populated for ALL flavors on BOTH spawn paths.
 *
 * 🔴 `kind` is the SAME 4-value enum as the #3346 capability-manifest
 * `authBindingAxisSchema` (`harnessManifest.ts`) — FROZEN in lockstep across
 * #3346 (the axis), this field (#3351), and #3353's real-vs-EQ cost mapping
 * (`subscription-account` → EQUIVALENT/blue "EQ.", `api-key`/`gateway-key` →
 * REAL/mint, `inherited` → neutral "—"). GAP-2 discipline: a fifth value
 * ripples through all three, so never add one here alone.
 *
 * 🔴 `displayIdentity` is an account EMAIL (subscription kinds), a #1955 vault
 * key LABEL / provider display name / masked-last-4 (key kinds), or the literal
 * `"Host default"` (inherited) — **NEVER a raw secret** (R4). The daemon
 * COMPUTES this and delivers it via the `HAPI_AUTH_BINDING` env carrier; the CLI
 * child STAMPS it in `buildSessionMetadata`, mirroring `HAPI_ACCOUNT_UUID` /
 * `nativeModel`. A mid-session account switch rewrites it server-side alongside
 * `claudeAccount` (freshness — R6).
 *
 * `providerId` is the credential's provider/gateway id, coordinated with #3806's
 * `ProviderIdSchema` where it maps (`anthropic` / `openai` / `google`) plus
 * `openrouter` for the gateway-key cases. Optional.
 *
 * Plain `z.object` (NOT `.passthrough()`): a stray field is STRIPPED on parse,
 * so a secret smuggled into an unexpected key cannot ride through the sub-object
 * (defence-in-depth atop the enclosing `.passthrough()` MetadataSchema). The
 * authoritative R4 control is the cli-side sentinel suite over the binding
 * computation — a schema test cannot prove secret-ABSENCE.
 */
export const AuthBindingSchema = z.object({
  kind: z.enum(["subscription-account", "api-key", "gateway-key", "inherited"]),
  /** Email / vault-key LABEL / provider name / masked-last-4 / "Host default" —
   *  NEVER a raw secret. */
  displayIdentity: z.string(),
  /** Provider / gateway id: `anthropic` | `openai` | `google` | `openrouter`. */
  providerId: z.string().optional(),
});

export type AuthBinding = z.infer<typeof AuthBindingSchema>;

/**
 * Git repo identity resolved at session creation time.
 * Used for grouping sessions by repo and displaying repo info in project headers.
 */
export const RepoIdentitySchema = z
  .object({
    /** Full owner/repo identifier for grouping (e.g., "MattStarfield/rp1-home") */
    name: z.string(),
    /** Web URL for the repo (e.g., "https://github.com/MattStarfield/rp1-home") */
    url: z.string().optional(),
  })
  .passthrough();

export type RepoIdentity = z.infer<typeof RepoIdentitySchema>;

// ── Per-session token + iteration ceiling with hard abort (#1905) ──

/**
 * PARTIAL body accepted by the per-session override
 * `PUT /sessions/:id/ceiling-override`; the global `PUT /preferences/ceiling-guard`
 * takes {@link CeilingGuardPreferencePatchSchema} (this plus `roleOverrides`). Unlike
 * {@link CeilingGuardConfigSchema}, NO field carries a default here (the #2268
 * z.infer trap) — so a `{enabled}`-only PUT does not fabricate the other fields
 * and a `{}` body does not clobber stored values. The server MERGES this partial
 * over the stored/global config: an omitted key means "unchanged". Mirrors
 * {@link AutoRecoverPreferencePatchSchema}. Declared before
 * {@link CeilingGuardConfigSchema}, whose role profiles derive from it (#5254).
 */
export const CeilingGuardConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  uncachedTokenCeiling: z.number().int().positive().nullable().optional(),
  iterationCeiling: z.number().int().positive().nullable().optional(),
  costUsdCeiling: z.number().positive().nullable().optional(),
  hardStop: z.boolean().optional(),
  /** #5254 R1 rate ceilings (optional additions; older bodies are unchanged). */
  turnsPerHourCeiling: z.number().int().positive().nullable().optional(),
  uncachedTokensPerHourCeiling: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional(),
});

export type CeilingGuardConfigPatch = z.infer<
  typeof CeilingGuardConfigPatchSchema
>;

/**
 * #5254: one `roleOverrides` profile — the ceiling fields of the patch, minus
 * `enabled` (the guard reads only the global `enabled`, so a per-role one would
 * be accepted and silently ignored). `.strict()` so an unknown key is rejected
 * by the PUT rather than stored and dropped.
 */
export const CeilingGuardRoleProfileSchema = CeilingGuardConfigPatchSchema.omit(
  {
    enabled: true,
  }
).strict();

/**
 * Runaway-session guard config (issues #1905, #5254). A server-side,
 * launcher-agnostic set of ceilings: cumulative UNCACHED token spend
 * (`total_tok_in + total_tok_out`, cache-read/write EXCLUDED — they are not
 * spend-equivalent), cumulative turn count and cost, plus (#5254) turns and
 * uncached tokens over the trailing 60 minutes. A breach hard-stops the session
 * at the next turn boundary and surfaces an out-of-band notice ONLY when no
 * operator message arrived in that window; otherwise it is recorded as
 * suppressed. `roleOverrides` overlays a per-`sessionRole` profile.
 *
 * Defaults are DELIBERATELY GENEROUS (R5 — a false-positive hard stop of a
 * legitimate long session is the harm this guard exists to prevent). They were
 * set from the P99/max of real prod telemetry (`v_session_totals`, 1,980 real
 * sessions, 2026-09-20): turn_count max 1,974 / p99 221; uncached max ≈ 11.5M /
 * p99-sum ≈ 2.23M. The chosen ceilings clear the observed MAX with margin, so no
 * historical legitimate session would have tripped, while a true (unbounded)
 * runaway still crosses them (ships effectively log-only until tuned — K2/OR-2).
 * These figures calibrate the cumulative defaults; the rate defaults are
 * documented on their own fields (ms1 ledger, 2026-10-22).
 *
 * `.default(...)` is CORRECT here (a DEDICATED preference object, like
 * {@link AutoRecoverPreferenceSchema}) so `parse({})` yields the effective
 * defaults — the #2268 `.optional()` rule is for the PARTIAL PUT body only, which
 * is {@link CeilingGuardConfigPatchSchema} above.
 *
 * A `null` ceiling = "that dimension disabled". `enabled:false` (or the
 * `HAPI_CEILING_GUARD_ENABLED` env kill-switch) disables the whole guard;
 * `hardStop:false` = notify-only (surface the breach but do NOT archive).
 */
export const CeilingGuardConfigSchema = z.object({
  enabled: z.boolean().default(true),
  uncachedTokenCeiling: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(25_000_000),
  iterationCeiling: z.number().int().positive().nullable().default(3000),
  costUsdCeiling: z.number().positive().nullable().default(null),
  hardStop: z.boolean().default(true),
  /** #5254 R1: turns started in the trailing 60 minutes. Calibrated from the
   *  ms1 ledger (2026-10-22, 344 sessions: max 75/h, p99 27/h) — 1.6× the max. */
  turnsPerHourCeiling: z.number().int().positive().nullable().default(120),
  /** #5254 R1: uncached (`tok_in + tok_out`) tokens in the trailing 60 minutes,
   *  background-agent usage included. ms1 max 663,630/h — 3× margin. */
  uncachedTokensPerHourCeiling: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(2_000_000),
  /** #5254 R3: per-`metadata.sessionRole` overlay, applied between the global
   *  config and a session's own `ceilingOverride`. The default lifts the
   *  cumulative ceilings for PM sessions (long engagements) while keeping the
   *  rate ceilings, so a runaway PM is still caught. `partialRecord` because a
   *  zod 4 enum-keyed `record` requires every role key. */
  roleOverrides: z
    .partialRecord(SessionRoleSchema, CeilingGuardRoleProfileSchema)
    .default({
      pm: {
        iterationCeiling: null,
        uncachedTokenCeiling: null,
        costUsdCeiling: null,
      },
    }),
});

export type CeilingGuardConfig = z.infer<typeof CeilingGuardConfigSchema>;

/**
 * #5254: the GLOBAL `PUT /preferences/ceiling-guard` body — the per-session
 * patch plus `roleOverrides`. Kept separate so the per-session override route
 * (which uses {@link CeilingGuardConfigPatchSchema}) never accepts
 * `roleOverrides`. A supplied `roleOverrides` REPLACES the stored map wholesale.
 */
export const CeilingGuardPreferencePatchSchema =
  CeilingGuardConfigPatchSchema.extend({
    roleOverrides: z
      .partialRecord(SessionRoleSchema, CeilingGuardRoleProfileSchema)
      .optional(),
  });

export type CeilingGuardPreferencePatch = z.infer<
  typeof CeilingGuardPreferencePatchSchema
>;

export const MetadataSchema = z
  .object({
    /**
     * Absolute filesystem path of the session's working directory. Two-layer
     * validation (issue #1098): this schema enforces SHAPE (non-empty,
     * absolute, no traversal `..`, no NUL bytes); the CONTENT blacklist
     * (`isSafeMachinePath` — rejects `/etc`, `/root`, `~/.ssh`, etc.) is
     * applied later when the path is used as a `~/.claude.json` project
     * key in `applyDisabledServerToggle`.
     */
    path: z
      .string()
      .min(1, "path must not be empty")
      .refine(
        p => p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p),
        "path must be absolute"
      )
      .refine(
        p => !p.split(/[\\/]+/).includes(".."),
        "path must not contain traversal segments"
      )
      .refine(p => !p.includes("\u0000"), "path must not contain NUL bytes"),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    summary: MetadataSummarySchema.optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(),
    codexSessionId: z.string().optional(),
    // #3811: the ACP session id (gemini/opencode + any ACP-driven tier-2 CLI),
    // written once by the generic ACP runner. The harness-neutral
    // `nativeSessionId` manifest descriptor names this field per flavor — there
    // is no universal `nativeSessionId` metadata field (each flavor keeps its own).
    acpSessionId: z.string().optional(),
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    homeDir: z.string().optional(),
    happyHomeDir: z.string().optional(),
    happyLibDir: z.string().optional(),
    happyToolsDir: z.string().optional(),
    startedFromDaemon: z.boolean().optional(),
    hostPid: z.number().optional(),
    startedBy: z.enum(["daemon", "terminal"]).optional(),
    /**
     * Session lifecycle state (free-form to stay forgiving of forked-upstream
     * data). Canonical value space (issue #1565):
     *   "spawning" (server-set placeholder before the child reports in) →
     *   "running"  (set by the CLI child via sessionFactory once alive — the
     *               AC's "ready" state) | "failed" (server-set on a background
     *               spawn failure after the early ack); "archived" on archive.
     * Surfaced to clients via the toSessionSummary projection (sessionSummary.ts).
     */
    lifecycleState: z.string().optional(),
    lifecycleStateSince: z.number().optional(),
    archivedBy: z.string().optional(),
    archiveReason: z.string().optional(),
    flavor: z.string().nullish(),
    worktree: WorktreeMetadataSchema.optional(),
    /** The session tag used to register with the server. Used by daemon for correlation. */
    hapiSessionTag: z.string().optional(),
    /** Claude account info (plan type, tier) from credentials file */
    claudeAccount: ClaudeAccountInfoSchema.optional(),
    /** Origin of this session: "scheduler" (includes heartbeat mode) | "heartbeat" (legacy, maps to scheduled badge) | undefined (user-created) */
    source: z.enum(["scheduler", "heartbeat"]).optional(),
    /** Schedule kind for scheduler-created sessions */
    scheduleKind: z.enum(["at", "cron", "every"]).optional(),
    /** Schedule ID for deep-linking back to the spawning schedule */
    scheduleId: z.string().optional(),
    /** Git repo identity resolved at session creation (grouping + display) */
    repoIdentity: RepoIdentitySchema.optional(),
    /** Federation: nodeId of the peer that spawned this session (dual-node visibility) */
    originatingNodeId: z.string().optional(),
    /** Multi-account (epic #1446): the account this session is bound to. Absent → host-credential fallback. Stamped by issue-worker (Sub-Issue D) from HAPI_ACCOUNT_UUID; the value is set by a future spawn-wiring sub-issue. */
    accountUuid: z.string().optional(),
    /**
     * Issue #1613: the Claude remote launcher kind (`sdk`/`pty`/`tmux`)
     * resolved at spawn and FROZEN for the session's lifetime. Lets the web
     * UI show the viewed session's actual launcher instead of the global
     * default (which can drift afterward via `hapi launcher set`). Optional:
     * legacy/in-flight sessions and non-Claude flavors won't have it.
     */
    launcherKind: ClaudeRemoteLauncherKindSchema.optional(),
    /** Issue #1633: session launched with --safe-mode (CLAUDE.md, skills,
     *  hooks, MCP customizations disabled). Read by server-side respawn paths
     *  (model switch, account switch) so the flag survives a restart. */
    safeMode: z.boolean().optional(),
    /** Issue #2155: the role-scoped `@`-include profile this session was
     *  spawned with (pm/worker/researcher/closer/interactive). Resolved at
     *  spawn and stamped here so server-side respawn paths (model switch,
     *  account switch) re-spawn with the SAME role — otherwise a respawned
     *  session silently reverts to the full stack (OR-4). Optional:
     *  legacy/in-flight sessions and interactive sessions won't have it. */
    sessionRole: SessionRoleSchema.optional(),
    /** Issue #2434: the session's EFFECTIVE Claude model pin — set at spawn
     *  from the spawn-time selection AND overwritten by every mid-session
     *  model change ("last manual selection wins"). Read by the server-side
     *  respawn paths (model switch, account switch, reconnect) so the pin
     *  survives a restart.
     *
     *  This is the DURABLE complement to the top-level `Session.modelMode`,
     *  which is EPHEMERAL: `sessionCache` hydrates that field from the
     *  in-memory session (`existing?.modelMode`), never from the stored row,
     *  so before #2434 there was nothing for a respawn to re-source — the
     *  mechanism behind #2092.
     *
     *  `"default"` is never stored here (it is the absence of a pin): a revert
     *  to default CLEARS the field, keeping the #1506 entitled-pin resolution
     *  untouched. Optional: legacy sessions and default-mode sessions won't
     *  have it. */
    modelMode: ModelModeSchema.optional(),
    /** Issue #2456: the session's reasoning-effort pin (`--effort <level>`).
     *  Durable complement to the ephemeral `Session.effort` runtime field —
     *  read by the server-side respawn paths (model switch, account switch,
     *  reconnect) so the effort survives a restart. Absence = no effort pin
     *  (binary default). Optional: legacy/default-effort sessions won't have it. */
    effort: EffortLevelSchema.optional(),
    /** Issue #2456: a specific pinned Claude model id (e.g. "claude-opus-4-6")
     *  selected via "More models". Distinct from `modelMode` (family quick-pick)
     *  — this is the raw `--model <id>` axis. Its display `modelMode` stays
     *  "default", so respawn paths must preserve `rawModel` explicitly (else the
     *  #1506 entitled pin clobbers it). Optional: absent unless a specific
     *  version was pinned. */
    rawModel: z.string().optional(),
    /** Round 11 (epic #3285, 2026-09-07): the session's saved permission
     *  posture — the durable complement to the ephemeral `Session.permissionMode`
     *  runtime field. Written by the CLI on a live mode change and by the server
     *  when a DISCONNECTED session's configuration is saved; `reconnectSession`
     *  derives the respawn's `--yolo` from it (absent → the pre-existing
     *  bypass-on-reconnect behavior). Optional: legacy sessions won't have it. */
    permissionMode: PermissionModeSchema.optional(),
    /** Round 11 (epic #3285): MCP desired-state changes SAVED while the session
     *  was disconnected (server name → enabled). Replayed through the MCP batch
     *  coordinator the moment the session is active again. Absent = nothing
     *  staged. */
    stagedMcpDesired: z.record(z.string(), z.boolean()).optional(),
    /** Issue #2626: the session's per-session output-style name, stamped at
     *  spawn (CLI-side in runClaude, same atomic write as launcherKind/model
     *  pins) so the server-side respawn paths (model switch, account switch,
     *  reconnect) re-apply the SAME style — otherwise a respawn silently
     *  reverts to the machine default. Optional: legacy/default-style sessions
     *  won't have it. */
    outputStyle: z.string().optional(),
    /** Issue #3348: the non-claude native model SELECTED at spawn (a gemini model
     *  id or a codex ChatGPT-token model id), recorded SERVER-SIDE from the spawn
     *  body so the in-session UI can DISPLAY the active model for a flavor whose
     *  CLI does not report `resolvedModel` to Hapimatic. DISPLAY-ONLY: a codex
     *  model change recreates the session (ruling D2(a)), so this is never mutated
     *  in place. Absent for claude (uses `modelMode`/`rawModel`) / OpenRouter /
     *  opencode. */
    nativeModel: z.string().optional(),
    /** Issue #3351 (epic #3345 Sub-Issue F): WHICH auth identity this session is
     *  bound to at spawn — subscription-account vs api-key vs gateway-key vs
     *  inherited, plus a label-only display identity (NEVER a secret — R4).
     *  Computed by the daemon per flavor, delivered via the `HAPI_AUTH_BINDING`
     *  env carrier, stamped CLI-side in `buildSessionMetadata` (mirrors
     *  `claudeAccount`/`nativeModel`); a mid-session account switch rewrites it
     *  server-side (R6). Consumed by #3353's real-vs-EQ cost display and the
     *  SessionHeader auth-binding badge. Optional: legacy/in-flight sessions
     *  won't have it. See {@link AuthBindingSchema}. */
    authBinding: AuthBindingSchema.optional(),
    /** Issue #4568: the node-vault id of the Anthropic API key a Claude session
     *  bills to (an API-key session binds NO subscription account). The key itself
     *  is in no metadata or environment: the launcher checks the binding by this id
     *  at every launch, and Claude Code reads the key through `hapi api-key-helper`.
     *  Stamped CLI-side from `HAPI_API_KEY_ID`; every respawn path threads it back
     *  (`buildRespawnBase`). Absent ⇒ a subscription (or host-credential) session. */
    apiKeyId: z.string().optional(),
    /** Issue #4568: the bound key's masked form ({@link maskApiKey}) recorded at
     *  spawn. A launch refuses when the vault entry's mask no longer matches, so a
     *  key replaced under the same id is refused when its last four characters
     *  differ (a replacement ending in the same four is not detected). Display-safe. */
    apiKeyMasked: z.string().optional(),
    /** Issue #3124: per-hook native-coverage records for the message-layer hook
     *  stage (epic #3117 Sub I). Stamped by the CLI at spawn/registration from
     *  #3123's hook-projection provenance (frozen-at-spawn, mirroring
     *  `launcherKind`/`modelMode`). The server-side stage reads these to decide
     *  whether a `no-native-equivalent` message hook is already covered natively
     *  (R5 dedup — no double-fire). Absent → the stage falls back to
     *  manifest-derived coverage. The EMIT side (writing these at projection +
     *  reporting them at registration) is #3123's D4(a) task; this field is the
     *  server-readable carrier. Optional: legacy/pre-#3123 sessions won't have it. */
    hookCoverage: z.array(hookCoverageRecordSchema).optional(),
    /** Issue #1905: per-session runaway-guard ceiling override. When present it
     *  takes precedence over the global {@link CeilingGuardConfigSchema} for this
     *  session (merged field-by-field over the global config in
     *  `SyncEngine.checkSessionCeilings`). A partial config (any subset of the
     *  ceiling fields); cleared by writing `undefined`. Absent → the global
     *  config applies. Round-trips through the CLI via the `.passthrough()`
     *  metadata blob. */
    ceilingOverride: CeilingGuardConfigPatchSchema.optional(),
  })
  .passthrough();

export type Metadata = z.infer<typeof MetadataSchema>;

export const AgentStateRequestSchema = z
  .object({
    tool: z.string(),
    arguments: z.unknown(),
    createdAt: z.number().nullish(),
  })
  .passthrough();

export type AgentStateRequest = z.infer<typeof AgentStateRequestSchema>;

export const AgentStateCompletedRequestSchema = z
  .object({
    tool: z.string(),
    arguments: z.unknown(),
    createdAt: z.number().nullish(),
    completedAt: z.number().nullish(),
    status: z.enum(["canceled", "denied", "approved"]),
    reason: z.string().optional(),
    mode: z.string().optional(),
    decision: z
      .enum(["approved", "approved_for_session", "denied", "abort"])
      .optional(),
    allowTools: z.array(z.string()).optional(),
    answers: z.record(z.string(), z.array(z.string())).optional(),
  })
  .passthrough();

export type AgentStateCompletedRequest = z.infer<
  typeof AgentStateCompletedRequestSchema
>;

export const AgentStateSchema = z
  .object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), AgentStateRequestSchema).nullish(),
    completedRequests: z
      .record(z.string(), AgentStateCompletedRequestSchema)
      .nullish(),
  })
  .passthrough();

export type AgentState = z.infer<typeof AgentStateSchema>;

export const TodoItemSchema = z
  .object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed"]),
    priority: z.enum(["high", "medium", "low"]),
    id: z.string(),
  })
  .passthrough();

export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodosSchema = z.array(TodoItemSchema);

export const DecryptedMessageSchema = z
  .object({
    id: z.string(),
    seq: z.number().nullable(),
    localId: z.string().nullable(),
    content: z.unknown(),
    createdAt: z.number(),
  })
  .passthrough();

export type DecryptedMessage = z.infer<typeof DecryptedMessageSchema>;

export const LinkedIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  repo: z.string(),
  state: z.enum(["open", "closed"]).optional(),
});

export type LinkedIssue = z.infer<typeof LinkedIssueSchema>;

export const UiCollapseStateSchema = z.object({
  promptCollapsed: z.boolean().optional(),
  notesCollapsed: z.boolean().optional(),
  tokenUsageCollapsed: z.boolean().optional(),
  detailsCollapsed: z.boolean().optional(),
  /** The Background Agents breakout INSIDE the Context widget (2026-10-05).
   *  Rides this per-session record so it syncs across devices and federation
   *  nodes like the four section keys above. Absent = expanded. */
  backgroundAgentsCollapsed: z.boolean().optional(),
});

export type UiCollapseState = z.infer<typeof UiCollapseStateSchema>;

// Issue #3286 (View Picker · epic #3028 Sub A): the four selectable session
// views. claude-pty is intentionally EXCLUDED (D5(a) — it stays a secondary
// affordance, not a tab). DEFAULT_SESSION_VIEW is the shared source of truth
// consumed on BOTH sides (server field default + the web no-flash localStorage
// default), per the Frontend/Backend Preference Sync rule in web/CLAUDE.md.
export const SESSION_VIEWS = ["chat", "terminal", "desktop", "files"] as const;
export type SessionView = (typeof SESSION_VIEWS)[number];
export const DEFAULT_SESSION_VIEW: SessionView = "chat";
export const SessionViewSchema = z.enum(SESSION_VIEWS);

// Issue #4383: background-Agent visibility. The CLI's BackgroundAgentTracker
// derives this from the launcher stream + the session's subagents/ disk and
// rides it on the keepAlive runtime (the `rateLimited` always-present contract).
// `.passthrough()` so #4388's optional nested `shells` object travels unchanged
// without a schema bump here.
export const BackgroundAgentEntrySchema = z
  .object({
    id: z.string(),
    toolUseId: z.string().optional(),
    agentType: z.string(),
    description: z.string(),
    status: z.enum(["running", "done", "error"]),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    notifications: z.number(),
    /** Issue #4385: the agent file's usage so far, deduped by API message id,
     *  refreshed by the tracker's 30 s reconcile. A live estimate — once the
     *  agent has a stored `backgroundAgentUsage` row, that row is
     *  authoritative. Absent before the first reconcile and from an older CLI. */
    tokens: z
      .object({
        in: z.number(),
        out: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
      })
      .optional(),
    // #4388 (R2, nested tree): set by the tracker's reconcile for a depth-≥2
    // background agent. `parentAgentId` is the `id` of the agent whose file
    // launched this one (its `Agent` tool_use carries this agent's `toolUseId`);
    // `depth` mirrors the meta's `spawnDepth` (1 = top-level). Both absent for a
    // top-level / live-stream agent (rendered flat).
    parentAgentId: z.string().optional(),
    depth: z.number().optional(),
  })
  .passthrough();

export type BackgroundAgentEntry = z.infer<typeof BackgroundAgentEntrySchema>;

// #4388 (R3): background Bash shell counts. Nested inside the snapshot's
// `shells?` (decision D-4388-D1 = A) so no new field crosses the keepalive train;
// the agents-only `total` above stays agents-only (DD5).
export const BackgroundShellCountsSchema = z.object({
  running: z.number(),
  done: z.number(),
  error: z.number(),
  total: z.number(),
});
export type BackgroundShellCounts = z.infer<typeof BackgroundShellCountsSchema>;

export const BackgroundAgentsSnapshotSchema = z
  .object({
    running: z.number(),
    done: z.number(),
    error: z.number(),
    total: z.number(),
    agents: z.array(BackgroundAgentEntrySchema),
    // #4388 (R3): background Bash shell counts, present only when shells exist.
    shells: BackgroundShellCountsSchema.optional(),
  })
  .passthrough();

export type BackgroundAgentsSnapshot = z.infer<
  typeof BackgroundAgentsSnapshotSchema
>;

export const SessionSchema = z
  .object({
    id: z.string(),
    /** The session tag (hapiSessionId) - used to correlate with daemon local store */
    tag: z.string().nullable().optional(),
    namespace: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    metadata: MetadataSchema.nullable(),
    metadataVersion: z.number(),
    agentState: AgentStateSchema.nullable(),
    agentStateVersion: z.number(),
    thinking: z.boolean(),
    thinkingAt: z.number(),
    /** Server-tracked: timestamp when current thinking segment began */
    thinkingStartedAt: z.number().optional(),
    /** Server-tracked: total accumulated thinking time in ms */
    serverAccumulatedMs: z.number().optional(),
    /**
     * Issue #1653: under the tmux/pty launchers a permission (or other
     * TUI-blocking) prompt renders ONLY in the terminal — invisible to the web
     * chat, which otherwise shows perpetual "thinking" (the frozen-session
     * signature). `null` = no pending prompt; `{ message, since }` = blocked.
     * Ephemeral (no DB persistence — same as `thinking`). `.optional()` so
     * old CLI/server binaries on a mixed-version federation mesh do not fail
     * validation (Fallback Preservation Rule).
     */
    blockedOnTuiPrompt: z
      .object({ message: z.string(), since: z.number() })
      .nullable()
      .optional(),
    /**
     * Issue #1647: a 429 session-limit (subscription quota exhausted) aborts the
     * turn but under the tmux/pty launchers fires NO Stop hook, so the web shows
     * "thinking" forever. This surfaces the rate-limited state so the web can
     * render a "rate-limited — resets {time}" chip and drop the thinking dot.
     * `null` = not rate-limited; `{ resetText, resetAt, since }` = rate-limited.
     * Ephemeral (no DB persistence — same as `thinking` / `blockedOnTuiPrompt`).
     * `.optional()` so mixed-version federation peers do not fail validation.
     */
    rateLimited: z
      .object({
        resetText: z.string(),
        resetAt: z.number().nullable(),
        since: z.number(),
      })
      .nullable()
      .optional(),
    /**
     * Issue #4383: the full background-Agent snapshot (counts + the bounded
     * per-agent list the modal reads). Ephemeral (no DB persistence — same as
     * `rateLimited` / `blockedOnTuiPrompt`). `.optional()` (K11 contract, Task 3):
     * the server normalises a null-on-the-wire to an ABSENT value, and an old CLI
     * omits it — both absent, which is correct (it tracks nothing). Mixed-version
     * federation peers never fail validation (Fallback Preservation Rule).
     */
    backgroundAgents: BackgroundAgentsSnapshotSchema.nullable().optional(),
    todos: TodosSchema.optional(),
    permissionMode: PermissionModeSchema.optional(),
    modelMode: ModelModeSchema.optional(),
    resolvedModel: z.string().optional(),
    /** Issue #2456: live reasoning-effort level, fed from the keepAlive tick
     *  (mirrors modelMode/resolvedModel). Drives the in-session effort tag. */
    effort: EffortLevelSchema.optional(),
    /** Issue #2456: live pinned raw Claude model id (e.g. "claude-opus-4-6"),
     *  fed from the keepAlive tick so the in-session picker shows the exact
     *  pinned version selected via "More models". */
    rawModel: z.string().optional(),
    // Issue #1469: first-order context window + live usage, sourced per turn
    // from Claude Code's get_context_usage. contextWindowTokens replaces the
    // deleted web-side [1m]-suffix heuristic (the actual 200k-vs-1M fix).
    contextWindowTokens: z.number().optional(),
    contextUsedTokens: z.number().optional(),
    contextPercentage: z.number().optional(),
    /**
     * Opaque notes payload: a JSON-serialized `NotesContent` envelope
     * (`{ text, attachments }`, issue #1075) OR a legacy plain string. The
     * server round-trips it verbatim — decode with `parseNotes()` from
     * `@hapi/protocol` on read.
     */
    notes: z.string().optional(),
    promptDraft: z.string().nullable().optional(),
    emoji: z.string().optional(),
    timerData: z.string().optional(),
    linkedIssue: LinkedIssueSchema.nullable().optional(),
    needsReviewOverride: z.enum(["read", "unread"]).nullable().optional(),
    /** Per-session override for auto-recovery from Anthropic API errors.
     *  null = follow global preference; true = force on; false = force off. */
    autoRecoverFromApiError: z.boolean().nullable().optional(),
    uiCollapseState: UiCollapseStateSchema.nullable().optional(),
    /**
     * Issue #3286 (View Picker): the server-persisted selected view for this
     * session, synced cross-device via SSE. TOP-LEVEL on the detail Session
     * (mirrors `notes`); null/absent = follow DEFAULT_SESSION_VIEW. claude-pty is
     * NOT a persisted view (D5(a)).
     */
    persistedView: SessionViewSchema.nullable().optional(),
    /** Federation: originating node ID (present when served via federation fallback) */
    nodeId: z.string().optional(),
    /** Federation: originating node display label */
    nodeLabel: z.string().optional(),
    /** Federation: URL of the originating node */
    nodeUrl: z.string().optional(),
    /** Federation: current status of the originating node */
    nodeStatus: z.enum(["online", "degraded", "offline"]).optional(),
    /** Branching: parent session ID (this session was forked from) */
    parentSessionId: z.string().nullable().optional(),
    /**
     * Relationship to the parent session (issue #2479):
     * "branch" = forked via branchSession(); "spawn" = a PM-spawned managed peer.
     * Optional (not .default) so the z.infer field stays optional; nullable so a
     * DB null round-trips. Styling keys off this, NEVER isSpawnedSession.
     */
    parentRelationship: z.enum(["branch", "spawn"]).nullable().optional(),
    /** Branching: user-provided label for this branch */
    branchLabel: z.string().nullable().optional(),
    /** Branching: timestamp when this branch was created */
    branchCreatedAt: z.number().nullable().optional(),
  })
  .passthrough();

export type Session = z.infer<typeof SessionSchema>;

const SessionEventBaseSchema = z.object({
  namespace: z.string().optional(),
});

const SessionChangedSchema = SessionEventBaseSchema.extend({
  sessionId: z.string(),
});

const MachineChangedSchema = SessionEventBaseSchema.extend({
  machineId: z.string(),
});

// ── MCP server health status ─────────────────────────────────────────

export const McpServerStatusSchema = z.object({
  name: z.string(),
  url: z.string(),
  // #2142: `unknown` (an mcp-list line the parser could not classify — e.g. a
  // future glyph/format change) and `pending_approval` (`⏸` project-scoped
  // server) extend the union. `.catch("unknown")` makes ingest TOLERANT of
  // version skew: a status value an older peer does not recognize degrades to
  // "unknown" instead of 400-rejecting the ENTIRE update (POST /cli/mcp-status
  // — routes/cli.ts). Forward deploy order stays server-before-daemon.
  status: z
    .enum([
      "connected",
      "failed",
      "needs_auth",
      "hosted",
      "unknown",
      "pending_approval",
    ])
    .catch("unknown"),
  statusText: z.string().optional(),
});

export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

export const McpStatusUpdateSchema = z.object({
  servers: z.array(McpServerStatusSchema),
  checkedAt: z.string(),
  machineId: z.string().optional(),
  projectDir: z.string().optional(),
  disabledServers: z.array(z.string()).optional(),
});

export type McpStatusUpdate = z.infer<typeof McpStatusUpdateSchema>;

// ── MCP Batch Coordinator (issue #989 follow-up) ─────────────────────
// Server-side worker reconciles desired vs current MCP state. Survives
// client backgrounding (which would suspend a client-side for-loop on iOS).

/** Per-server outcome of a batch toggle attempt.
 *
 * Three cases:
 *  - `{ ok: true }` — the server reached its desired state.
 *  - `{ ok: false }` (transient) — last attempt failed, but the worker may
 *    retry on the next iteration (failure count is still under
 *    MAX_FAILURES_PER_SERVER).
 *  - `{ ok: false, abandoned: true }` — the worker has given up on this
 *    server after MAX_FAILURES_PER_SERVER consecutive failures and will
 *    NOT retry until the user re-issues `setDesired` for it. The UI must
 *    surface this distinctly so the user knows manual retry is required;
 *    a transient-looking error message will not.
 *
 * The `abandoned: true` case must come BEFORE the generic transient
 * failure case in the union so Zod's discriminated parsing prefers the
 * specific shape over the open one.
 */
export const McpBatchOutcomeSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      abandoned: z.literal(true),
      error: z.string(),
      code: z.literal("max_retries_exceeded"),
      attempts: z.number().int().positive(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string(),
      code: z.string(),
    })
    .passthrough(),
]);
export type McpBatchOutcome = z.infer<typeof McpBatchOutcomeSchema>;

/**
 * Snapshot of the per-session MCP batch state.
 *
 * Desired state is declarative: the worker computes pending = (desired ≠ current)
 * on every iteration. Submitting a counter-batch (e.g. user enables all, then
 * mid-batch disables all) updates `desired`; the worker naturally drops items
 * whose new desired matches their current state — no double-toggling.
 */
export const McpBatchSnapshotSchema = z.object({
  sessionId: z.string(),
  /** Desired enabled/disabled per server name. true = enabled, false = disabled. */
  desired: z.record(z.string(), z.boolean()),
  /** Names that have been processed (success or failure) since startedAt. */
  done: z.record(z.string(), McpBatchOutcomeSchema),
  /** Names still waiting (current ≠ desired, not yet attempted in this iteration). */
  pending: z.array(z.string()),
  /** The server name currently being toggled, if any. */
  processing: z.string().nullable(),
  /** Total touched in this batch (done + pending + processing). */
  total: z.number().int().nonnegative(),
  /** Count of names still to process (pending + processing). */
  remaining: z.number().int().nonnegative(),
  /** Timestamp (ms) of the most recent setMcpDesired that triggered or extended the batch. */
  startedAt: z.number(),
  /** True iff the worker loop is alive. */
  isActive: z.boolean(),
});
export type McpBatchSnapshot = z.infer<typeof McpBatchSnapshotSchema>;

export const SyncEventSchema = z.discriminatedUnion("type", [
  SessionChangedSchema.extend({
    type: z.literal("session-added"),
    data: z.unknown().optional(),
  }),
  SessionChangedSchema.extend({
    type: z.literal("session-updated"),
    data: z.unknown().optional(),
  }),
  SessionEventBaseSchema.extend({
    type: z.literal("session-removed"),
    sessionId: z.string(),
  }),
  SessionChangedSchema.extend({
    type: z.literal("message-received"),
    message: DecryptedMessageSchema,
  }),
  MachineChangedSchema.extend({
    type: z.literal("machine-updated"),
    data: z.unknown().optional(),
  }),
  SessionEventBaseSchema.extend({
    type: z.literal("connection-changed"),
    data: z
      .object({
        status: z.string(),
      })
      .optional(),
  }),
  // Issue #1119: Server-authoritative midnight reset.
  // Emitted per-session AFTER all DB writes complete in performMidnightReset.
  // Clients invalidate timelog query caches and re-render at 0:00.
  // Carries sessionId from SessionChangedSchema so the federation event
  // bridge's `interestingSessions` filter applies cleanly per audience.
  SessionChangedSchema.extend({
    type: z.literal("timer-reset"),
    data: z
      .object({
        resetEpoch: z.number(),
        resetDate: z.string(),
        namespace: z.string(),
      })
      .passthrough()
      .optional(),
  }),
  SessionEventBaseSchema.extend({
    type: z.literal("mcp-status-updated"),
    data: McpStatusUpdateSchema.optional(),
  }),
  // Issue #1078: Tool error visibility (real-time toast surface)
  SessionChangedSchema.extend({
    type: z.literal("tool-error"),
    data: z.object({
      toolName: z.string(),
      toolUseId: z.string(),
      errorContent: z.string().max(2000),
    }),
  }),
  // Issue #1348: UserPromptSubmit hook block visibility (real-time toast surface).
  // Sibling of "tool-error" — different routing (system message vs
  // tool_result.is_error). Distinct event type so future hook-event types
  // (Stop, TaskCompleted) can extend the same family without retrofitting.
  SessionChangedSchema.extend({
    type: z.literal("prompt-blocked"),
    data: z.object({
      hookEvent: z.literal("UserPromptSubmit"),
      blockedReason: z.string().max(2000),
      originalPrompt: z.string().max(500).optional(),
      // #3579: OPTIONAL catalogue title + ISO instant for the gate-denial toast.
      // Optional so the second producer (routes/cli.ts) keeps compiling; the
      // client formats `at` to locale (R6) and falls back to blockedReason.
      title: z.string().max(200).optional(),
      at: z.string().max(40).optional(),
    }),
  }),
  // Issue #989 follow-up: MCP batch coordinator progress
  SessionChangedSchema.extend({
    type: z.literal("mcp-batch-progress"),
    data: McpBatchSnapshotSchema,
  }),
  // Issue #933: Federation spawn failure notification. Issue #2150 (K-4497-1):
  // the hub stamps the CALLER's `namespace` (read from the placeholder it
  // registered when it proxied the spawn) — without it `SSEManager.shouldSend`
  // drops the event for every browser — plus the peer's refusal `code` and the
  // hub-canonical `nodeLabel` so the toast names the node. All additive.
  z.object({
    type: z.literal("federation-spawn-failed"),
    nodeId: z.string(),
    directory: z.string(),
    spawnCorrelationId: z.string().nullable().optional(),
    error: z.string(),
    code: z.string().optional(),
    nodeLabel: z.string().optional(),
    namespace: z.string().optional(),
  }),
  // Issue #2150 (K-4497-1 §2): a federation spawn this hub proxied succeeded.
  // Broadcast AFTER the hub's targeted poll of that node settles, so a consumer
  // that enqueues a prompt or PUTs a parent finds the session in the hub cache.
  // Sent only when the hub holds the spawn's placeholder (it carries the
  // caller's namespace); never host-global.
  z.object({
    type: z.literal("federation-spawn-succeeded"),
    nodeId: z.string(),
    directory: z.string(),
    spawnCorrelationId: z.string(),
    sessionId: z.string(),
    nodeLabel: z.string().optional(),
    namespace: z.string().optional(),
  }),
  // Issue #1449: manual-login account auto-capture (live dropdown update).
  // Plain non-session SyncEvent (mirrors federation-spawn-failed shape) — the
  // capture is machine/account-scoped, not session-scoped. Carries REDACTED
  // identity ONLY; NEVER any token value (R5/R10). namespace omitted ->
  // resolveNamespace broadcasts to all clients of the originating machine.
  z.object({
    type: z.literal("account-captured"),
    accountUuid: z.string(),
    emailAddress: z.string(),
    organizationName: z.string().optional(),
    isNewAccount: z.boolean(),
    namespace: z.string().optional(),
  }),
  // Issue #1456: mid-session account switch completed. Plain session-scoped
  // SyncEvent — resolveNamespace() routes by the top-level sessionId. Carries
  // the NEW account's REDACTED identity (email) ONLY; NEVER a token value. H's
  // modal (#1454) consumes this to dismiss the "Switching account…" overlay.
  z.object({
    type: z.literal("account-switched"),
    sessionId: z.string(),
    accountUuid: z.string(),
    accountEmail: z.string().optional(),
    namespace: z.string().optional(),
  }),
  // Issue #1507: a token-refresh restart could not proceed because the bound
  // account became `unrefreshable` (its refresh token was revoked). Session-
  // scoped — resolveNamespace() routes by the top-level sessionId. Carries the
  // accountUuid (REDACTED — never a token) so the client can surface an
  // actionable "re-login required" state instead of an opaque auth failure.
  z.object({
    type: z.literal("account-unrefreshable"),
    sessionId: z.string(),
    accountUuid: z.string(),
    namespace: z.string().optional(),
    // Issue #4461 (R7): the node whose store refused. The hub's event bridge stamps
    // a peer's event with that peer's node; `GET /api/events` stamps this node's own
    // events on egress. Optional + additive — an older emitter still validates.
    nodeId: z.string().optional(),
    nodeLabel: z.string().optional(),
  }),
  // Issue #1532: a token-refresh restart failed BOTH the respawn and the
  // same-account rollback. The session is disconnected but RECONNECTABLE (the
  // tmux window + session record survive — NOT data loss). Distinct from
  // account-unrefreshable (which means "re-login required" — the refresh token
  // was revoked): here the account is healthy, so the session just needs a
  // reconnect. Session-scoped — resolveNamespace() routes by the top-level
  // sessionId. Carries accountUuid (REDACTED — never a token) + a short error
  // string for diagnostics so the client can surface an actionable "reconnect
  // required" state instead of a silently-dead session.
  z.object({
    type: z.literal("session-restart-failed"),
    sessionId: z.string(),
    accountUuid: z.string(),
    error: z.string(),
    namespace: z.string().optional(),
  }),
  // Issue #1325: server-backed message queue change notification.
  // Payload intentionally carries no body — clients refetch via the queue query
  // to keep SSE bounded and avoid partial-update race conditions.
  //
  // Issue #3235: `reason` classifies WHICH mutation emitted the event so the
  // server-side QueueDrainObserver can level-trigger a drain ONLY on a genuine
  // user `enqueue` (never on a `pop` echo, a `#1362` `requeue`, or an
  // `edit`/`remove`). Optional + additive — old emitters/clients that omit it
  // still validate, and a consumer treats an absent reason as "not an enqueue".
  SessionChangedSchema.extend({
    type: z.literal("queue-changed"),
    reason: z.enum(["enqueue", "requeue", "pop", "remove", "edit"]).optional(),
  }),
  // Issue #1565: LOCAL-path background spawn failure. The local spawn route has
  // no originating hub to notify (unlike the federation path's
  // federation-spawn-failed via /federation/spawn-status), so the server emits
  // this directly when a backgrounded engine.spawnSession(...) rejects after the
  // early {type:"accepted"} ack — R2 (no masking). Keyed by sessionId (the
  // pre-generated hapiSessionId the placeholder reconciles on). Distinct event
  // (sibling of federation-spawn-failed) so each path keeps its own surface.
  z.object({
    type: z.literal("spawn-failed"),
    sessionId: z.string(),
    directory: z.string(),
    error: z.string(),
    // Issue #3515: the pre-daemon refusal code (account_unrefreshable /
    // account_token_expired / at_capacity) when present, so the web create page
    // can render code-specific copy on the optimistic-spawn return-to-Create.
    // Additive + optional — old emitters/clients that omit it still validate.
    code: z.string().optional(),
    namespace: z.string().optional(),
  }),
  // Issue #2002: a session was switched/restarted (account-switch or token-refresh
  // restart) while a rate-limit (429 session-limit) was active. The ephemeral
  // `rateLimited` chip is cleared on the archive+respawn (sessionCache handleSessionEnd
  // + the CLI teardown clear), so WITHOUT this the rate-limit that coincided with the
  // switch would present as a silent stall. Session-scoped — resolveNamespace() routes
  // by the top-level sessionId. Carries the reset info ONLY (never a token) so the
  // client can surface "rate-limited during the switch — resets {resetText}" instead of
  // an unexplained quiet session. One-time informational — NOT a persisted chip (a
  // switchAccount to a DIFFERENT, non-limited account must not re-show a stale chip).
  z.object({
    type: z.literal("rate-limited-during-switch"),
    sessionId: z.string(),
    resetText: z.string().optional(),
    resetAt: z.number().nullable().optional(),
    namespace: z.string().optional(),
  }),
  // Issue #1233 (part of Epic #1231): API error visibility (overloaded_error
  // toast). Uses SessionChangedSchema.extend so the top-level sessionId feeds
  // the federation event bridge's `interestingSessions` filter (like tool-error).
  // Payload is NESTED (locked contract LC-1): { type, sessionId, namespace,
  // data: { phase, errorType, ... } } — #1234 (Sub-Issue C) reads event.data.*.
  // `errorType` is a string (not enum) intentionally — Anthropic may add new
  // error types, and the listener handles unknowns gracefully. `.passthrough()`
  // tolerates optional/added fields without a Zod parse failure.
  SessionChangedSchema.extend({
    type: z.literal("api-error"),
    data: z
      .object({
        phase: z.enum(["retrying", "exhausted", "recovered", "give-up"]),
        errorType: z.string(),
        retryAttempt: z.number().int().nonnegative().optional(),
        maxRetries: z.number().int().nonnegative().optional(),
        requestId: z.string().optional(),
        // #4936: set only for the terminal `spend_limit_error` class — which
        // spend limit stopped the request, and when the API says access resumes.
        limitVariant: z.enum(SPEND_LIMIT_VARIANTS).optional(),
        resumesAt: z.number().optional(),
      })
      .passthrough(),
  }),
  // Issue #2453 (Task 7/14, R6): a session reconnected and the server
  // auto-resumed the loop-cron loops it had auto-paused on disconnect. Drives
  // the "N scheduled jobs resuming — paused on disconnect <ts>" toast.
  // `count` is how many loops resumed; `pausedAtMs` is when they were paused
  // (the disconnect time). Session-scoped — resolveNamespace() routes by the
  // top-level sessionId.
  z.object({
    type: z.literal("loops-resuming"),
    sessionId: z.string(),
    count: z.number().int().nonnegative(),
    pausedAtMs: z.number(),
    namespace: z.string().optional(),
  }),
  // Issue #2301 (Task 5, R4): a reconnect or account-switch spawn hit the
  // concurrency cap and is now polling for a free slot (bounded by the shared
  // 30-60s deadline). Drives the advisory "waiting for a free slot…" toast so a
  // capacity-throttled reconnect/switch reads as in-progress rather than a silent
  // stall. Emitted once when the wait begins — by both #2301's post-kill/reconnect
  // spawnWithRetry AND #2299's PRE-kill waitForCapacityBeforeKill (the shared emit).
  // `context` distinguishes the two flows for copy; `elapsedMs`/`deadlineMs` are
  // advisory progress hints. Session-scoped — resolveNamespace() routes by the
  // top-level sessionId. Carries NO account/token value.
  z.object({
    type: z.literal("waiting-for-slot"),
    sessionId: z.string(),
    context: z.enum(["account-switch", "reconnect"]).optional(),
    elapsedMs: z.number().optional(),
    deadlineMs: z.number().optional(),
    namespace: z.string().optional(),
  }),
  // Issue #1969 (File Conflict Monitor Sub D): federation-wide claim sync. A node
  // publishes its full live-claim snapshot on any local claim mutation; the SSE
  // event bridge forwards it to every peer (shouldForwardBridgeEvent returns true
  // for non-session events), where each peer's NodeRegistry merges it into its
  // per-node FileClaimSync replica. NON-session (no top-level `sessionId` — it
  // must reach ALL peers, never be namespace/interest-filtered on the bridge).
  // 🔴 `namespace` is DECLARED (exactly like account-captured above) so the direct
  // property accesses on the union — `event.namespace` at syncEngine.ts and
  // sseManager.ts — typecheck across every member; but it is NEVER populated at
  // emit. Consequence: the federation bridge forwards it unconditionally, while
  // LOCAL web clients do NOT receive it (SSEManager.shouldSend drops namespace-
  // less events except its two exempted types) — browser delivery is #1971's
  // concern (expert-review ruling D1, 2026-07-15), not this issue's. Each claim's
  // own sessionId lives nested inside snapshot.claims[].
  z.object({
    type: z.literal("file-claim-delta"),
    snapshot: FileClaimSyncSnapshotSchema,
    namespace: z.string().optional(),
  }),
  // Issue #3018: chat-section preference changed (host-global, payload-free
  // invalidation). Emitted after a successful GLOBAL chat-sections write so every
  // already-open browser refetches the authoritative effective preference and
  // re-renders — cross-tab and cross-device (federation peers) — without a
  // remount. It intentionally carries NO preference value: consumers GET the
  // current effective state, so a stale event payload can never regress the
  // displayed matrix under concurrent write/fan-out completion ordering. Like
  // file-claim-delta / account-captured, `namespace` is DECLARED (never populated
  // at emit) so the direct `event.namespace` accesses on the union (sseManager.ts,
  // syncEngine.ts) typecheck across every member. A host-global write reaches
  // every namespace via the explicit `SSEManager.shouldSend()` exemption and
  // federation peers via the SyncEngine/EventPublisher bridge; an `inherit:false`
  // node-local override uses a direct `SSEManager.broadcast()` (node-only) and
  // never this publisher-backed path.
  z.object({
    type: z.literal("chat-sections-changed"),
    namespace: z.string().optional(),
  }),
  // Issue #3446 (Sub A, K5): a source machine uploaded its config archive to a
  // porter one-liner's single-use upload leg and a plan was staged. Wakes the
  // waiting export page (waiting → received) so it fetches the plan from the
  // status endpoint and hydrates the import review UI. NAMESPACE-SCOPED, and
  // `namespace` is REQUIRED + populated at emit (captured at mint) — UNLIKE the
  // declare-only namespace on file-claim-delta / chat-sections-changed above —
  // so `SSEManager.shouldSend()` delivers it to the minting operator's browser
  // (a namespace-less porter event would be silently dropped for every client).
  // `token` lets the page match the event to its pending mint; `stagingHandle`
  // is advisory (the page reads the plan from the status endpoint, not here).
  z.object({
    type: z.literal("porter-token-received"),
    namespace: z.string(),
    token: z.string(),
    stagingHandle: z.string(),
  }),
  // Issue #2700 (epic #2698, L0): a scheduled task was created, deleted, or
  // executed. Payload-light invalidation — the web client refetches the schedules
  // (and sessions) queries so an orphaned scheduler-spawned session re-homes into
  // the main list live. NAMESPACE-SCOPED via SessionEventBaseSchema: the event
  // carries no sessionId/machineId, so EventPublisher cannot resolve a namespace
  // and the emitter MUST set `namespace: task.namespace` explicitly — a
  // namespace-less event is dropped for every browser by SSEManager.shouldSend().
  // Deliberately NOT in HOST_GLOBAL_EVENT_TYPES (that would broadcast one
  // namespace's schedule activity to every namespace).
  SessionEventBaseSchema.extend({
    type: z.literal("schedule-changed"),
    // REQUIRED here (optional on the base): a namespace-less schedule-changed is
    // silently undeliverable, so make that a compile-time error for every emitter.
    namespace: z.string().min(1),
    scheduleId: z.string(),
    changeKind: z.enum(["created", "deleted", "executed"]),
  }),
]);

export type SyncEvent = z.infer<typeof SyncEventSchema>;

// ── 5-Layer Temporal Model schemas ───────────────────────────────────

/** Operating schedule: weekly work-hours pattern */
export const OperatingScheduleSchema = z
  .object({
    everyNWeeks: z.number().int().min(1).default(1),
    activeDays: z.array(z.number().int().min(0).max(6)), // 0=Sun, 6=Sat
    clockIn: z.string().optional(), // "HH:MM" format
    clockOut: z.string().optional(), // "HH:MM" format
  })
  .passthrough();

export type OperatingSchedule = z.infer<typeof OperatingScheduleSchema>;

/** Exclusion entry: blackout date (holiday, PTO) */
export const ExclusionEntrySchema = z
  .object({
    label: z.string(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    annualRepeat: z.boolean(),
    year: z.number().int().optional(),
  })
  .passthrough();

export type ExclusionEntry = z.infer<typeof ExclusionEntrySchema>;

/** Rotation config for heartbeat session rotation */
export const RotationConfigSchema = z
  .object({
    mode: z.enum(["count", "time"]),
    count: z.number().int().optional(),
    day: z.number().int().optional(),
    hour: z.number().int().optional(),
  })
  .passthrough();

export type RotationConfig = z.infer<typeof RotationConfigSchema>;

/** DST adjustment mode */
export const DstAdjustmentSchema = z.enum(["none", "skip", "double"]);
export type DstAdjustment = z.infer<typeof DstAdjustmentSchema>;

// ── Search/Filter/Sort bar preferences ───────────────────────────────

export const SearchFilterPreferencesSchema = z.object({
  searchText: z.string().default(""),
  filters: z
    .object({
      status: z.enum(["all", "active", "inactive"]).default("all"),
      type: z.enum(["all", "standard", "scheduler"]).default("all"),
      project: z.enum(["all", "repo", "directory"]).default("all"),
      node: z.string().default("all"), // "all" | <nodeId>
      // #3810 (epic #3345 Sub-Issue T): sessions-list filters by harness
      // (session `metadata.flavor`) and by bound account. Free-form ids with an
      // "all" default — the `node` key precedent. A stored blob without these
      // parses via the field defaults (no migration, no route change).
      harness: z.string().default("all"), // "all" | <flavor>
      account: z.string().default("all"), // "all" | <email> | "unassigned"
      // #3810 Phase B (Task 5): filter by the session's auth-binding provider id
      // (anthropic | openai | google | openrouter). Free-form, "all" default.
      provider: z.string().default("all"), // "all" | <providerId>
      review: z.enum(["all", "needsReview", "read"]).default("all"),
      linkedIssue: z.enum(["all", "hasIssue", "noIssue"]).default("all"),
    })
    .default({
      status: "all",
      type: "all",
      project: "all",
      node: "all",
      harness: "all",
      account: "all",
      provider: "all",
      review: "all",
      linkedIssue: "all",
    }),
  sort: z.enum(["updated", "created", "name", "timeLogged"]).default("updated"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
});

export type SearchFilterPreferences = z.infer<
  typeof SearchFilterPreferencesSchema
>;

// ── OpenRouter model catalog + favorites (#1975) ─────────────────────

/**
 * A trimmed OpenRouter model-catalog entry. The full catalog (hundreds of
 * models) is fetched from `https://openrouter.ai/api/v1/models` and trimmed
 * server-side to just what the Create-Session picker needs. `.passthrough()`
 * so an upstream field addition never breaks parsing. Issue #1975.
 */
export const OpenRouterModelSchema = z
  .object({
    id: z.string(),
    name: z.string().default(""),
    contextLength: z.number().nullable().optional(),
    promptPrice: z.string().nullable().optional(),
    completionPrice: z.string().nullable().optional(),
  })
  .passthrough();
export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

/**
 * Node-local set of favorited OpenRouter model ids, pinned to the top of the
 * Create-Session model picker (#1975). Stored in settings.json alongside the
 * other preferences; synced across all clients hitting this node.
 */
export const OpenRouterFavoritesSchema = z.object({
  models: z.array(z.string()).default([]),
});
export type OpenRouterFavorites = z.infer<typeof OpenRouterFavoritesSchema>;

/**
 * Node-local configurable default model (#2456, R5). Chooses what a
 * `modelMode:"default"` Claude session actually RESOLVES to — the value is
 * BEHAVIORAL at spawn (server threads it into the spawn path) and drives the
 * `Default (X)` resolution indicator. Stored in settings.json alongside the
 * other preferences (dynamic key — no `Settings` interface change), following
 * the #1975 OpenRouter-favorites pattern.
 *
 * `model` is a Claude model alias ("opus"/"sonnet"/"fable"/"haiku") or a raw
 * model id ("claude-opus-4-6"). `.optional()` (NOT `.default(x)`) per memory
 * `reference_zod_default_vs_optional_infer` — an additive field with a
 * `.default` makes the inferred field REQUIRED and breaks existing literals;
 * the wrapper object may `.default({})`.
 */
export const DefaultModelPreferenceSchema = z
  .object({
    model: z.string().optional(),
  })
  .default({});
export type DefaultModelPreference = z.infer<
  typeof DefaultModelPreferenceSchema
>;

// ── Auto-recover from Anthropic API errors (epic #1231 sub-issue E) ──

/**
 * Server mirror of the user's "Auto-recover from API errors" preference.
 * Source of truth for the UI is localStorage (managed by useAdminPreferences
 * per issue #1040). This mirror is consumed by server-side `autoRecoveryService`
 * (epic #1231 sub-issue C / issue #1234) which has no access to browser state.
 *
 * Default `enabled: true` — auto-recover is opt-out (on by default). This shared
 * constant is the SINGLE source for the default on BOTH sides: the server schema
 * default (below) and the web localStorage default (`useAdminPreferences.ts`)
 * consume it, so a frontend/backend divergence becomes a build/test failure
 * rather than a silent runtime drift (#2486). The prior `false` default
 * (#1234's conservative first-deploy posture) silently disarmed recovery
 * fleet-wide while the UI showed ON; the 2026-07-31 hotfix set both instances
 * to `{"enabled": true}` and this is the durable alignment.
 */
export const AUTO_RECOVER_DEFAULT_ENABLED = true;

export const AutoRecoverPreferenceSchema = z.object({
  enabled: z.boolean().default(AUTO_RECOVER_DEFAULT_ENABLED),
  /**
   * Per-class recovery opt-outs / force-enables (#2487 Sub-Issue D). Keyed by
   * the CANONICAL error-type class (see `@hapi/protocol/apiErrorClasses`):
   *   - `false` = opt this class OUT of recovery (an ABSOLUTE veto, even over a
   *     per-session `autoRecoverFromApiError === true`).
   *   - `true`  = recover this class. For a recover-by-default class this is the
   *     default; for a notify-only-by-default class (auth / invalid-request /
   *     billing) this FORCE-ENABLES recovery.
   * An ABSENT class key means "use the class default" — NOT "cleared". Clearing
   * a class requires sending an explicit boolean; omission never clears it (the
   * server-side merge in `PUT /preferences/auto-recover` enforces this). The
   * field is `.optional()` (never `.default()`) so a partial `{enabled}`-only
   * body type-checks without fabricating a map — the #2268 z.infer trap.
   */
  classOverrides: z.record(z.string(), z.boolean()).optional(),
});

export type AutoRecoverPreference = z.infer<typeof AutoRecoverPreferenceSchema>;

/**
 * PARTIAL body accepted by `PUT /preferences/auto-recover` (#2487 D, ruling
 * D1). Unlike {@link AutoRecoverPreferenceSchema}, `enabled` has NO default
 * here — so a `{classOverrides}`-only body does NOT fabricate `enabled = true`
 * and reset the master toggle (R7 reverse). The server MERGES this partial over
 * the stored value: an omitted key means "unchanged", never "cleared".
 */
export const AutoRecoverPreferencePatchSchema = z.object({
  enabled: z.boolean().optional(),
  classOverrides: z.record(z.string(), z.boolean()).optional(),
});

export type AutoRecoverPreferencePatch = z.infer<
  typeof AutoRecoverPreferencePatchSchema
>;

// ── Auto-switch a rate-limited session to a healthy account (#3618) ──

/**
 * Server mirror of the user's "Auto-switch account on rate limit" preference
 * (#3618). Consumed by the server-side `AutoSwitchOnRateLimitService`, which —
 * on the `session.rateLimited.since` null→set rising edge of a session-limit 429
 * — migrates the LIVE session to the lowest-utilization healthy account via
 * `syncEngine.switchAccount` before the SDK child dies.
 *
 * Default `enabled: false` — auto-switch is OPT-IN (OFF by default), because it
 * actively kills and respawns a running session under a different account. The
 * shared constant is the SINGLE source of the default on BOTH sides: the server
 * schema default (below) and the web localStorage cache default
 * (`useAdminPreferences.ts`), so a frontend/backend divergence becomes a
 * build/test failure rather than a silent runtime drift (the #2486 discipline,
 * applied here from day one). The default flips to `true` only after the manual
 * incident replay in the #3618 verification checklist passes (a named follow-up).
 */
export const AUTO_SWITCH_ON_RATE_LIMIT_DEFAULT_ENABLED = false;

export const AutoSwitchOnRateLimitPreferenceSchema = z.object({
  enabled: z.boolean().default(AUTO_SWITCH_ON_RATE_LIMIT_DEFAULT_ENABLED),
});

export type AutoSwitchOnRateLimitPreference = z.infer<
  typeof AutoSwitchOnRateLimitPreferenceSchema
>;

/**
 * PARTIAL body accepted by `PUT /preferences/auto-switch-on-rate-limit`. Unlike
 * {@link AutoSwitchOnRateLimitPreferenceSchema}, `enabled` has NO default here,
 * so a `{}` body does not fabricate `enabled: false` and clobber a stored `true`
 * — the server merges this partial over the stored value (omitted key means
 * "unchanged"). Mirrors {@link AutoRecoverPreferencePatchSchema}.
 */
export const AutoSwitchOnRateLimitPreferencePatchSchema = z.object({
  enabled: z.boolean().optional(),
});

export type AutoSwitchOnRateLimitPreferencePatch = z.infer<
  typeof AutoSwitchOnRateLimitPreferencePatchSchema
>;

// ── Auto-select the optimal account for un-pinned spawns (#3611, epic #3609 Sub-Issue B) ──

/**
 * Server mirror of the user's "Auto-select the most-underutilized account"
 * preference (#3611). The SAME toggle already governs the web create-page
 * pre-selection (#2042, browser-local); this mirror additionally lets the
 * DAEMON's un-pinned spawn resolver (`cli/src/accounts/selectHealthyAccount.ts`)
 * bind the lowest served-score healthy account for an un-pinned CLI/scheduler
 * spawn that never passes through the web create page.
 *
 * Default `enabled: false` — OPT-IN (OFF by default): with it off, an un-pinned
 * spawn binds exactly the account it binds today (#3023's host-default-first
 * decision, byte-identical — R3). The shared constant is the SINGLE source of the
 * default on BOTH sides — the server schema default (below) and the web
 * localStorage cache default (`useAdminPreferences.ts`) — so a frontend/backend
 * divergence becomes a build/test failure rather than a silent runtime drift (the
 * #2486 discipline). The daemon resolver fails CLOSED to `false`: if the boolean
 * never reaches the daemon (unwired reader / rolling deploy), no pick occurs.
 */
export const AUTO_SELECT_OPTIMAL_ACCOUNT_DEFAULT_ENABLED = false;

export const AutoSelectOptimalAccountPreferenceSchema = z.object({
  enabled: z.boolean().default(AUTO_SELECT_OPTIMAL_ACCOUNT_DEFAULT_ENABLED),
});

export type AutoSelectOptimalAccountPreference = z.infer<
  typeof AutoSelectOptimalAccountPreferenceSchema
>;

/**
 * PARTIAL body accepted by `PUT /preferences/auto-select-optimal-account`. Unlike
 * {@link AutoSelectOptimalAccountPreferenceSchema}, `enabled` has NO default here,
 * so a `{}` body does not fabricate `enabled: false` and clobber a stored `true` —
 * the server merges this partial over the stored value (omitted key means
 * "unchanged"). Mirrors {@link AutoSwitchOnRateLimitPreferencePatchSchema}.
 */
export const AutoSelectOptimalAccountPreferencePatchSchema = z.object({
  enabled: z.boolean().optional(),
});

export type AutoSelectOptimalAccountPreferencePatch = z.infer<
  typeof AutoSelectOptimalAccountPreferencePatchSchema
>;

// ── Chat detail level + default output style (#2623, epic #2622 Sub-Issue A) ──
// Two NEW server-persisted prefs (B #2624 globalizes, C #2625/D #2626 consume).
// `.default(CONSTANT)` on these DEDICATED preference objects (like
// `AutoRecoverPreferenceSchema`) so `parse({})` yields the GET route's effective
// default; the shared constant is the single default consumed by BOTH the server
// schema and the web localStorage cache. #2268's `.optional()` rule is for
// additive fields on BROADER wire schemas, not dedicated pref objects.
// [expert-review 2026-08-05: Key Decision 1 / 2623-4]
export const CHAT_DETAIL_LEVELS = ["full", "compact", "output-only"] as const;
export type ChatDetailLevel = (typeof CHAT_DETAIL_LEVELS)[number];
export const CHAT_DETAIL_LEVEL_DEFAULT: ChatDetailLevel = "full";

export const ChatDetailLevelSchema = z.object({
  level: z.enum(CHAT_DETAIL_LEVELS).default(CHAT_DETAIL_LEVEL_DEFAULT),
});

export type ChatDetailLevelPreference = z.infer<typeof ChatDetailLevelSchema>;

// ── Per-category chat sections preference (#2988, epic #2987 Sub-Issue S1) ──
// Supersedes the 3-position `chatDetailLevel` enum with a per-category matrix
// (toolRuns + reasoning), each category carrying its own visibility + default
// collapse state. Same 2623-4 "dedicated pref object" idiom, but each category
// carries a COMPLETE object-level `.default(...)` (not a partial `{}`) so
// `parse({})` yields the full effective default regardless of zod's
// short-circuit `.default()` semantics. The single exported default constant is
// consumed by BOTH the server schema and the web localStorage cache — a
// divergence fails typecheck/tests (web/CLAUDE.md "Frontend/Backend Preference
// Sync"). S1 lands the model + migration; S2 owns the rendering redesign.
export const CHAT_SECTION_DEFAULT_STATES = ["expanded", "collapsed"] as const;
export type ChatSectionDefaultState =
  (typeof CHAT_SECTION_DEFAULT_STATES)[number];

// Reasoning collapsed-preview line count. 3 (epic #2987 coordination ruling d2)
// so a collapsed reasoning section stays informative on first paint — never 0.
export const CHAT_SECTIONS_REASONING_PREVIEW_LINES_DEFAULT = 3;

// Narration collapsed-preview line count (#3154). Mirrors the reasoning constant
// above so a collapsed narration section stays informative on first paint —
// never 0. Kept as its own constant (not aliased to the reasoning one) so the two
// categories can diverge later without a hidden coupling.
export const CHAT_SECTIONS_NARRATION_PREVIEW_LINES_DEFAULT = 3;

// #3879: promote a SUBSTANTIAL mid-turn interstitial narration block to a visible
// response instead of collapsing it. Unit is NON-EMPTY trimmed `\n`-split lines
// (the same unit the collapsed preview counts, `countNarrationLines` in
// web/src/chat/presentation.ts) — NOT raw `\n` (double-counts preserveBlankLines
// paragraph breaks) and NOT chars (~22% of real interstitials exceed 600 chars, so
// a char threshold over-promotes). `0` = never promote (today's behaviour). The
// default of 10 is evidence-determined: measured over 139 real interstitial blocks
// in three rp1 Claude Code transcripts, ≥12 non-empty lines fires on only 1–2.5%,
// so 10 promotes just the "substantial" top few percent while short interstitials
// still collapse (R5).
export const CHAT_SECTIONS_NARRATION_PROMOTE_THRESHOLD_DEFAULT = 10;
// Clamp bound the settings input mirrors (Task 4). Applied clamp-on-read via a
// transform, NOT a hard `.max()` — see the #3003 F5 note on the field below.
export const CHAT_SECTIONS_NARRATION_PROMOTE_THRESHOLD_MAX = 100;

export const ChatSectionsPreferenceSchema = z.object({
  toolRuns: z
    .object({
      visible: z.boolean().default(true),
      defaultState: z.enum(CHAT_SECTION_DEFAULT_STATES).default("expanded"),
    })
    .default({ visible: true, defaultState: "expanded" }),
  reasoning: z
    .object({
      visible: z.boolean().default(true),
      defaultState: z.enum(CHAT_SECTION_DEFAULT_STATES).default("expanded"),
      previewLines: z
        .number()
        .int()
        .min(0)
        // #3003 F5: clamp-on-read to ≤100 via a transform, NOT a hard `.max(100)`.
        // A hard `.max()` makes a stored value >100 FAIL `safeParse`, and a
        // safeParse failure here silently reverts the ENTIRE chat-sections matrix
        // to defaults — the exact silent-revert class F2 exists to log. The
        // transform keeps `safeParse` succeeding and reads the value back clamped.
        .transform(n => Math.min(100, n))
        .default(CHAT_SECTIONS_REASONING_PREVIEW_LINES_DEFAULT),
    })
    .default({
      visible: true,
      defaultState: "expanded",
      previewLines: CHAT_SECTIONS_REASONING_PREVIEW_LINES_DEFAULT,
    }),
  // #3154: narration category — full parity with `reasoning` above. Interstitial
  // assistant text (a text block whose turn continues into tool calls) is
  // classified narration and rendered collapsibly like reasoning; the task-final
  // response stays uncategorized. Byte-for-byte mirror of the `reasoning` object.
  narration: z
    .object({
      visible: z.boolean().default(true),
      defaultState: z.enum(CHAT_SECTION_DEFAULT_STATES).default("expanded"),
      previewLines: z
        .number()
        .int()
        .min(0)
        // #3154: clamp-on-read to ≤100 via a transform, NOT a hard `.max(100)` —
        // mirrors reasoning's #3003 F5 guard exactly. A hard `.max()` makes a
        // stored value >100 FAIL `safeParse`, and a safeParse failure here
        // silently reverts the ENTIRE chat-sections matrix to defaults. The
        // transform keeps `safeParse` succeeding and reads the value back clamped.
        .transform(n => Math.min(100, n))
        .default(CHAT_SECTIONS_NARRATION_PREVIEW_LINES_DEFAULT),
      // #3879: length threshold that PROMOTES a substantial mid-turn interstitial
      // narration block to a visible response (consumed by `isCollapsedNarration`
      // in web/src/chat/presentation.ts). Full parity with `previewLines` above —
      // clamp-on-read via a transform, NOT a hard `.max()` (#3003 F5): a hard max
      // makes a stored value > MAX FAIL `safeParse` and silently reverts the ENTIRE
      // chat-sections matrix to defaults. Required-with-default (never `.optional()`)
      // so every consumer reads a defined leaf (#3003 F4). `0` disables promotion.
      promoteThresholdLines: z
        .number()
        .int()
        .min(0)
        .transform(n =>
          Math.min(CHAT_SECTIONS_NARRATION_PROMOTE_THRESHOLD_MAX, n)
        )
        .default(CHAT_SECTIONS_NARRATION_PROMOTE_THRESHOLD_DEFAULT),
    })
    .default({
      visible: true,
      defaultState: "expanded",
      previewLines: CHAT_SECTIONS_NARRATION_PREVIEW_LINES_DEFAULT,
      promoteThresholdLines: CHAT_SECTIONS_NARRATION_PROMOTE_THRESHOLD_DEFAULT,
    }),
});

export type ChatSectionsPreference = z.infer<
  typeof ChatSectionsPreferenceSchema
>;

// The single default matrix, derived from `parse({})` so the object-level
// schema defaults and this constant can never drift. Consumed by the web
// localStorage cache default (useAdminPreferences) and the server read
// fallback (readChatSections).
export const CHAT_SECTIONS_DEFAULT: ChatSectionsPreference =
  ChatSectionsPreferenceSchema.parse({});

/**
 * Deterministic migration from the retired 3-position `chatDetailLevel` enum
 * (#2622/#2623/#2625) to the per-category matrix (#2987 D1 "replace, not
 * layer"). One implementation in `shared/`, consumed by BOTH the server
 * read-migration (`readChatSections`) and any web fallback:
 *   - `full`        → both categories visible + expanded
 *   - `compact`     → both categories visible + collapsed
 *   - `output-only` → both categories hidden
 * A user's pre-deploy `chatDetailLevel` therefore resolves to equivalent
 * post-deploy rendering with no user action (issue #2988 R2). `previewLines` is
 * always the shared default (the enum carried no preview count).
 */
export function migrateChatDetailLevelToSections(
  level: ChatDetailLevel
): ChatSectionsPreference {
  const previewLines = CHAT_SECTIONS_REASONING_PREVIEW_LINES_DEFAULT;
  // #3154: narration mirrors reasoning in every migrated matrix (the retired enum
  // carried no narration concept, so the migrated default equals reasoning's).
  const narrationPreviewLines = CHAT_SECTIONS_NARRATION_PREVIEW_LINES_DEFAULT;
  // #3879: the promote-threshold is likewise always the shared default in every
  // migrated matrix (the retired enum carried no promote concept).
  const narrationPromoteThresholdLines =
    CHAT_SECTIONS_NARRATION_PROMOTE_THRESHOLD_DEFAULT;
  switch (level) {
    case "compact":
      return {
        toolRuns: { visible: true, defaultState: "collapsed" },
        reasoning: { visible: true, defaultState: "collapsed", previewLines },
        narration: {
          visible: true,
          defaultState: "collapsed",
          previewLines: narrationPreviewLines,
          promoteThresholdLines: narrationPromoteThresholdLines,
        },
      };
    case "output-only":
      return {
        toolRuns: { visible: false, defaultState: "expanded" },
        reasoning: { visible: false, defaultState: "expanded", previewLines },
        narration: {
          visible: false,
          defaultState: "expanded",
          previewLines: narrationPreviewLines,
          promoteThresholdLines: narrationPromoteThresholdLines,
        },
      };
    case "full":
    default:
      return {
        toolRuns: { visible: true, defaultState: "expanded" },
        reasoning: { visible: true, defaultState: "expanded", previewLines },
        narration: {
          visible: true,
          defaultState: "expanded",
          previewLines: narrationPreviewLines,
          promoteThresholdLines: narrationPromoteThresholdLines,
        },
      };
  }
}

export const DEFAULT_OUTPUT_STYLE_DEFAULT = "default";

export const DefaultOutputStylePreferenceSchema = z.object({
  style: z.string().min(1).default(DEFAULT_OUTPUT_STYLE_DEFAULT),
});

export type DefaultOutputStylePreference = z.infer<
  typeof DefaultOutputStylePreferenceSchema
>;

// The Terminal aux-keyboard dock expand/collapse state (#4548, epic #4515). A
// federation-native key: #4516 persists it per node locally (the first-paint
// cache / resolver fallback), and this key broadcasts it federation-wide so a
// toggle on node A's PWA reaches node B's open Terminal. `{ expanded: boolean }`
// mirrors `defaultOutputStyle`'s `{ style }`; `expanded` is REQUIRED (no inline
// default), so `{}` / a bare boolean fail — the single default lives in the
// constant below (#4516 SA6: expanded on first visit).
export const TerminalKeyboardExpandedPreferenceSchema = z.object({
  expanded: z.boolean(),
});
export type TerminalKeyboardExpandedPreference = z.infer<
  typeof TerminalKeyboardExpandedPreferenceSchema
>;
export const TERMINAL_KEYBOARD_EXPANDED_DEFAULT: TerminalKeyboardExpandedPreference =
  { expanded: true };

// ── Federation-global settings layer (#2624, epic #2622 Sub-Issue B) ──
//
// The generic per-node settings model: each registered setting has a
// federation-global value plus an optional node-local override, selected by a
// per-setting inherit flag surfaced as 🌐 (filled = inheriting the global,
// unfilled = a node-local value). B globalizes A's two keys; future settings
// register by adding one registry row in the server settingsSyncService, with
// no new wire schema. Convergence is last-write-wins by per-key updatedAt, safe
// under one-human-per-federation (epic Design Decision). Only keys/values cross
// the wire, never tokens (KD-6). See docs/internal/architecture/federation.md.

// The registered federation-global settings. Each key is added deliberately by
// its own issue (so the key-list tests are a deliberate edit per key, R8); no
// pre-existing per-device value is migrated in — a key starts empty and fills on
// the first user write. `timeLogTimezone` (#4613) is the one federation-wide IANA
// time-log timezone every node uses for day bucketing + the midnight reset.
// `terminalKeyboardExpanded` (#4548) is a federation-NATIVE key: it has no
// A-local `settings.json` storage, only the per-node first-paint cache #4516 owns
// in the browser.
export const FEDERATION_SETTING_KEYS = [
  "chatSections",
  "defaultOutputStyle",
  "timeLogTimezone",
  "terminalKeyboardExpanded",
] as const;
export type FederationSettingKey = (typeof FEDERATION_SETTING_KEYS)[number];

// #4613: the federation-global time-log timezone value is a bare IANA identifier
// (e.g. "America/New_York", "UTC"). Validated cross-runtime via Intl — `new
// Intl.DateTimeFormat(..., { timeZone })` throws RangeError on an invalid zone.
// Defined in shared/ (no server import) so the registry (server) and the browser
// both validate the same way. This is the ONLY validator for the key's value
// (KD-4 of #2624: the layer never hard-codes value shapes).
function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
export const TimeLogTimezoneSchema = z
  .string()
  .min(1)
  .refine(isValidIanaTimezone, {
    message: "must be a valid IANA timezone identifier",
  });
export type TimeLogTimezone = z.infer<typeof TimeLogTimezoneSchema>;

// One federation-global value plus its LWW clock. originNodeId makes an
// equal-updatedAt tie decidable on the wire (KD-2 tie-break: the strictly
// higher id wins), so two values written in the same millisecond on two nodes
// still converge. [expert-review 2026-08-05: 2624-9]
export const TimestampedValueSchema = z.object({
  value: z.unknown(),
  updatedAt: z.number().int().nonnegative(),
  originNodeId: z.string().optional(),
});
export type TimestampedValue = z.infer<typeof TimestampedValueSchema>;

// The per-node federationSettings block persisted in settings.json. All three
// records default to empty so parse({}) (or a settings file predating B) yields
// a valid, all-inheriting block.
export const FederationSettingsBlockSchema = z.object({
  globalValues: z.record(z.string(), TimestampedValueSchema).default({}),
  localOverrides: z.record(z.string(), z.unknown()).default({}),
  inheritFlags: z.record(z.string(), z.boolean()).default({}),
});
export type FederationSettingsBlock = z.infer<
  typeof FederationSettingsBlockSchema
>;

// The node-to-node channel body: POST /federation/settings-sync request and the
// GET /federation/settings-digest response both carry { key -> TimestampedValue }.
export const FederationSettingsSyncSchema = z.object({
  values: z.record(z.string(), TimestampedValueSchema),
});
export type FederationSettingsSync = z.infer<
  typeof FederationSettingsSyncSchema
>;

// Per-key provenance of the effective value the browser sees.
export const FederationSettingProvenanceSchema = z.enum([
  "global",
  "local",
  "default",
]);
export type FederationSettingProvenance = z.infer<
  typeof FederationSettingProvenanceSchema
>;

// The browser-facing (JWT) view for the Preferences UI: per-key effective value,
// 🌐 inherit state, and provenance. [expert-review 2026-08-05: 2624-1]
export const FederationSettingsViewSchema = z.object({
  values: z.record(z.string(), z.unknown()),
  inheritFlags: z.record(z.string(), z.boolean()),
  provenance: z.record(z.string(), FederationSettingProvenanceSchema),
});
export type FederationSettingsView = z.infer<
  typeof FederationSettingsViewSchema
>;

// PUT /preferences/federation-settings/:key body — set the value and/or toggle
// 🌐. inherit is the ONLY path that flips the inherit flag. [expert-review
// 2026-08-05: 2624-1]
export const FederationSettingPatchSchema = z.object({
  value: z.unknown().optional(),
  inherit: z.boolean().optional(),
});
export type FederationSettingPatch = z.infer<
  typeof FederationSettingPatchSchema
>;

// ── Create-Session page UI preferences (server-persisted) ────────────
//
// The expand/collapse state of the Create-Session accordion's four top-level
// sections, persisted server-side so the layout survives leaving and returning
// to the Create page (and follows the account across devices/browsers — unlike
// the localStorage-backed admin preferences). Default ALL-EXPANDED; a user's
// deliberate collapses are retained.
export const CreateSessionPreferencesSchema = z.object({
  sections: z
    .object({
      machine: z.boolean().default(true),
      github: z.boolean().default(true),
      model: z.boolean().default(true),
      session: z.boolean().default(true),
    })
    .default({ machine: true, github: true, model: true, session: true }),
});

export type CreateSessionPreferences = z.infer<
  typeof CreateSessionPreferencesSchema
>;

// ── Create-Session per-field saved defaults (bookmark feature) ───────
//
// The user-bookmarked default value for each Create-Session field, keyed by a
// stable field id (e.g. "directory", "cliHarness", "schedule.interval"). Values
// are the raw field values (string / boolean / number / small JSON objects for
// composite fields), stored opaquely — the web form owns the id registry and
// the per-field apply semantics. Persisted under its OWN settings key (NOT
// inside `createSessionPreferences`) because both preference hooks PUT their
// whole blob fire-and-forget; sharing one blob would let the sections writer
// clobber saved defaults and vice versa.
export const CreateSessionDefaultsSchema = z.object({
  defaults: z.record(z.string(), z.unknown()).default({}),
});

export type CreateSessionDefaults = z.infer<typeof CreateSessionDefaultsSchema>;

// ── Session capacity / max-concurrency (issues #1805, #4417) ─────────
//
// The settable per-node spawn cap and the live slot-meter share one wire
// vocabulary. `maxConcurrent` is the user-settable cap (also the gate
// threshold); `effectiveCount` is the daemon's authoritative in-use count
// (#1477). #4417 adds two OPTIONAL fields to the meter: `recommendedConcurrent`
// (the warn-at count — ≤ maxConcurrent) and `capSource` (which resolver layer
// decided the cap: env/settings/tier/derived/default). Both are optional so an
// older daemon omits them and the UI fails open (no warn threshold shown).
// KD-3: the HARD ceiling rejects absurd values while honoring per-host reality
// (a single ceiling of 10 would wrongly cap an SL7-class host); the daemon-side
// clamp (not this schema) is the real OOM safety boundary — UI/route validation
// is a UX nicety on top of it.

/** Hard ceiling for the settable max-concurrency (reject above). KD-3. */
export const MAX_CONCURRENCY_HARD_CEILING = 50;
/**
 * Static fallback recommended cap (#4417): used ONLY when a daemon does not report a
 * live `recommendedConcurrent`/`capSource` (an older daemon). The live recommended count
 * now comes from the daemon's RAM/CPU-or-tier resolver (`sessionCapacity.ts`), carried on
 * `DaemonCapacitySchema.recommendedConcurrent`; this constant is no longer the source of
 * truth for the warn threshold.
 */
export const MAX_CONCURRENCY_RECOMMENDED = 10;
/** Floor — a cap of 0 would lock out all spawning. */
export const MAX_CONCURRENCY_FLOOR = 1;
/** Default cap when nothing is configured (env/settings absent). Single source
 * shared by the daemon resolver (cli) and the server's source-inference. */
export const MAX_CONCURRENCY_DEFAULT = 10;

/**
 * Which resolver layer the DAEMON reports deciding its live cap (#4417). The
 * server adds `"remote"` / `"unknown"` on top for its own inference; those are NOT
 * part of the daemon's own vocabulary.
 */
export const DaemonCapSourceSchema = z.enum([
  "env",
  "settings",
  "tier",
  "derived",
  "default",
]);
export type DaemonCapSource = z.infer<typeof DaemonCapSourceSchema>;

/** Local-meter wire shape — returned by GET /api/daemon/capacity. */
export const DaemonCapacitySchema = z.object({
  effectiveCount: z.number().int(),
  maxConcurrent: z.number().int(),
  /**
   * Warn-at count (#4417). OPTIONAL: an older daemon omits it → the UI shows no
   * recommended threshold (fail-open). Below `maxConcurrent` under the tier/derived layer
   * (e.g. a lite VM: 3 of 12); equal to it under the default layer.
   */
  recommendedConcurrent: z.number().int().optional(),
  /** Which resolver layer decided the cap (#4417). OPTIONAL for an older daemon. */
  capSource: DaemonCapSourceSchema.optional(),
});

export type DaemonCapacity = z.infer<typeof DaemonCapacitySchema>;

/**
 * Request body for POST /api/nodes/:nodeId/max-concurrency.
 * `value: null` CLEARS an explicit cap back to automatic (#4417, Task 6) — the writer
 * deletes the `maxConcurrentSessions` key so the daemon resolver falls through to the
 * tier/derived/default layers. An older peer that still has the integer-only schema
 * rejects a `null` body with HTTP 400, so the clear fails visibly (nothing is written).
 */
export const MaxConcurrencyPreferenceSchema = z.object({
  value: z
    .number()
    .int()
    .min(MAX_CONCURRENCY_FLOOR)
    .max(MAX_CONCURRENCY_HARD_CEILING)
    .nullable(),
});

export type MaxConcurrencyPreference = z.infer<
  typeof MaxConcurrencyPreferenceSchema
>;
// ── MCP Toggle (issue #1077) ─────────────────────────────────────────

/** Request body for POST /api/sessions/:id/mcp-toggle */
export const McpToggleRequestSchema = z
  .object({
    serverName: z.string().min(1),
    enabled: z.boolean(),
  })
  .passthrough();

export type McpToggleRequest = z.infer<typeof McpToggleRequestSchema>;

export const McpToggleErrorCodeSchema = z.enum([
  "local_mode_not_supported",
  "server_not_found",
  "transport_failed",
  "claude_exited",
  "no_active_query",
  "invalid_request",
  "session_not_found",
  /** ~/.claude.json exists but cannot be parsed as JSON. Distinct from
   * transport_failed so users can take corrective action (restore from
   * backup or remove the corrupted entry). */
  "config_corrupt",
  /** Failed to acquire the ~/.claude.json file lock within the timeout (5s
   * default). Likely contention from another Hapimatic session or native
   * Claude Code process toggling MCP servers concurrently. The caller can
   * retry — this is a transient condition. (Issue #1100) */
  "config_lock_timeout",
  /** projectDir failed safe-path validation (e.g. relative path, traversal
   * segment, NUL byte, or blacklisted system prefix like /etc, /root, or
   * ~/.ssh). Defense-in-depth check before writing ~/.claude.json — bad
   * paths should normally be rejected at session-creation time by
   * `MetadataSchema.path`, but this catches anything that bypasses the
   * boundary. NOT retryable — the projectDir itself must change. (Issue #1098) */
  "unsafe_path",
  /** The session's owning federation node is offline or restarting (the hub's
   * remote-session availability guard rewrote a session-not-found). Transient —
   * retry once the node returns. (Issue #5375) */
  "node_offline",
  /** The owning node is marked online but the hub's proxy call failed at the
   * transport layer. Transient. (Issue #5375) */
  "node_unreachable",
  "unknown",
]);

export type McpToggleErrorCode = z.infer<typeof McpToggleErrorCodeSchema>;

/**
 * Method used to apply an MCP toggle on the server side.
 * - "sdk": SDK control_request reached the active Claude Query (mid-stream).
 * - "config": Config-write fallback to ~/.claude.json (no active Query —
 *   takes effect on the next Claude SDK process spawn / next user message).
 */
export const McpToggleMethodSchema = z.enum(["sdk", "config"]);
export type McpToggleMethod = z.infer<typeof McpToggleMethodSchema>;

/** Response body for POST /api/sessions/:id/mcp-toggle */
export const McpToggleResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      method: McpToggleMethodSchema,
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string(),
      code: McpToggleErrorCodeSchema,
    })
    .passthrough(),
]);

export type McpToggleResponse = z.infer<typeof McpToggleResponseSchema>;

// ── Set Model (issue #2256) ──────────────────────────────────────────
// Mirrors the MCP-Toggle block above. Exposes the SDK `set_model`
// control_request through the server chain to the landed #2421 runClaude
// "set-model" handler (which owns the durable model-pin write).

/** Request body for POST /api/sessions/:id/set-model.
 * The field is `modelMode` (NOT `model`) — it matches the landed #2421
 * runClaude "set-model" RPC handler contract. A `{model}` payload fails
 * validation (modelMode missing) → 400, before it can hit the handler's
 * "set-model requires a modelMode" throw. */
export const SetModelRequestSchema = z
  .object({
    modelMode: z.string().min(1),
  })
  .passthrough();

export type SetModelRequest = z.infer<typeof SetModelRequestSchema>;

/** Error codes for set-model — a strict subset of McpToggleErrorCodeSchema.
 * Dropped vs mcp-toggle: the config-write codes (`config_corrupt` /
 * `config_lock_timeout` / `unsafe_path` / `server_not_found`) — set-model has
 * no ~/.claude.json write path; and `local_mode_not_supported` / `no_active_query`
 * — the runClaude "set-model" handler is registered on EVERY launcher class and
 * degrades to method:"config" (durable pin) when no live query is present, so a
 * non-sdk / pre-launch / post-teardown session never rejects. */
export const SetModelErrorCodeSchema = z.enum([
  "transport_failed",
  "claude_exited",
  "invalid_request",
  "session_not_found",
  /** Owning federation node offline / unreachable (#5375, see McpToggleErrorCodeSchema). */
  "node_offline",
  "node_unreachable",
  "unknown",
]);

export type SetModelErrorCode = z.infer<typeof SetModelErrorCodeSchema>;

/**
 * Method used to apply a set-model on the server side.
 * - "sdk": the set_model control_request reached the active Claude Query
 *   (live, out-of-band switch on the running query).
 * - "config": the durable model pin was applied (session.updateMetadata) with
 *   no live Query present — takes effect on the next Claude SDK process spawn.
 */
export const SetModelMethodSchema = z.enum(["sdk", "config"]);
export type SetModelMethod = z.infer<typeof SetModelMethodSchema>;

/** Response body for POST /api/sessions/:id/set-model. The `applied` envelope
 * PRESERVES the landed #2421 handler's response shape ({modelMode, rawModel});
 * `ok`/`method` are additive superset fields, so anything scripted against the
 * #2421 shape keeps working. */
export const SetModelResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      method: SetModelMethodSchema,
      applied: z
        .object({
          modelMode: z.string(),
          rawModel: z.string().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string(),
      code: SetModelErrorCodeSchema,
    })
    .passthrough(),
]);

export type SetModelResponse = z.infer<typeof SetModelResponseSchema>;

// ── set-permission-mode (issue #2346) ──────────────────────────────────────
// Mirrors the set-model block above, but follows the mcp-toggle contract rather
// than set-model's: it is a LAUNCHER-registered control (Task 7), so it KEEPS
// `local_mode_not_supported` / `no_active_query` (which set-model dropped under
// its every-launcher #2421 design) and has NO `"config"` method — a non-sdk /
// idle session rejects rather than degrading to a durable-pin apply.

/** Request body for POST /api/sessions/:id/set-permission-mode.
 * KD-3: validate `mode` against the closed `ClaudePermissionModeSchema` enum (NOT
 * a free `z.string()` like set-model's model id, and NOT the wide PermissionMode
 * enum) — a typo (or a codex mode) must become a 400 at the boundary, never a
 * silently-ignored control request leaving the session in its prior, possibly
 * more permissive, mode (the OR-3 security divergence). The Claude subset is
 * required here because the applier bypasses runClaude's resolvePermissionMode
 * flavor check. */
export const SetPermissionModeRequestSchema = z
  .object({
    mode: ClaudePermissionModeSchema,
  })
  .passthrough();

export type SetPermissionModeRequest = z.infer<
  typeof SetPermissionModeRequestSchema
>;

/** Error codes for set-permission-mode — the mcp-toggle-derived subset. Unlike
 * set-model this KEEPS `local_mode_not_supported` (tmux/pty/local launchers have
 * no SDK channel → 501) and `no_active_query` (the remote handler rejects when no
 * live Query is present rather than doing a config-only apply). The config-write
 * codes mcp-toggle carries (`config_corrupt` / `config_lock_timeout` /
 * `unsafe_path` / `server_not_found`) are dropped — set-permission-mode has no
 * ~/.claude.json write path; the durable pin is written by the set-session-config
 * / applier path, not this route. */
export const SetPermissionModeErrorCodeSchema = z.enum([
  "local_mode_not_supported",
  "no_active_query",
  "transport_failed",
  "claude_exited",
  "invalid_request",
  "session_not_found",
  /** Owning federation node offline / unreachable (#5375, see McpToggleErrorCodeSchema). */
  "node_offline",
  "node_unreachable",
  "unknown",
]);

export type SetPermissionModeErrorCode = z.infer<
  typeof SetPermissionModeErrorCodeSchema
>;

/** Method used to apply a set-permission-mode. Only `"sdk"` — the mode is
 * delivered to the live Claude Query via the set_permission_mode control_request.
 * There is no `"config"` method (cf. set-model): a session with no live query
 * rejects with `no_active_query` rather than degrading to a durable-pin apply. */
export const SetPermissionModeMethodSchema = z.enum(["sdk"]);
export type SetPermissionModeMethod = z.infer<
  typeof SetPermissionModeMethodSchema
>;

/** Response body for POST /api/sessions/:id/set-permission-mode. */
export const SetPermissionModeResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      method: SetPermissionModeMethodSchema,
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string(),
      code: SetPermissionModeErrorCodeSchema,
    })
    .passthrough(),
]);

export type SetPermissionModeResponse = z.infer<
  typeof SetPermissionModeResponseSchema
>;

/** Request body for POST /api/sessions/:id/mcp-set-desired. */
export const McpSetDesiredRequestSchema = z
  .object({
    /** Partial desired state — only the names being set. Merges into existing. */
    desired: z.record(z.string(), z.boolean()),
  })
  .passthrough();
export type McpSetDesiredRequest = z.infer<typeof McpSetDesiredRequestSchema>;

/**
 * Issue #2149 — request body for `POST /api/sessions/:id/relaunch` (and the
 * federation receiver). v1 overrides cover ONLY the spawn-frozen params that have
 * NO live-mutation plane — `launcher` and `safeMode`. The live-plane params
 * (modelMode / permission-mode / MCP / effort / rawModel) are NOT relaunch
 * overrides: they apply in place via their own routes (KD-2). All fields optional;
 * an empty body is a no-op `--resume` relaunch with unchanged params. Modeled on
 * `spawnBodySchema` (machines.ts) and reuses `ClaudeRemoteLauncherKindSchema`;
 * `.passthrough()` for federation forward-compat, matching the sibling
 * `McpSetDesiredRequestSchema`.
 */
export const RelaunchRequestSchema = z
  .object({
    /** Per-session launcher override (sdk | tmux | pty) — spawn-frozen, so a
     *  change requires a teardown + `--resume` relaunch. */
    launcher: ClaudeRemoteLauncherKindSchema.optional(),
    /** `--safe-mode` toggle — spawn-frozen, relaunch-only. */
    safeMode: z.boolean().optional(),
  })
  .passthrough();
export type RelaunchRequest = z.infer<typeof RelaunchRequestSchema>;

// ─────────────────────────── Session token stats (#1671) ───────────────────────────
// Per-turn footer + server-side session token totals (epic #1662, Sub I).
// Single source of truth for GET /api/sessions/:id/token-stats, shared by the
// server route (which builds the response from `v_session_totals` + the `turns`
// table) and the web client. `totals` mirrors the `v_session_totals` view's
// LOCKED column contract (camelCase); `turns` is the per-turn breakdown the
// footer correlates to messages by timestamp. All aggregate/per-turn numeric
// fields are nullable because SQLite SUM/MAX over NULL token/cost columns is
// NULL until Sub B/C/E have populated a turn.

/** Issue #5254 R4/R5: one persisted runaway-ceiling-guard breach record. */
export const CEILING_BREACH_KINDS = ["cumulative", "rate"] as const;
export const CEILING_BREACH_DIMENSIONS = [
  "tokens",
  "iterations",
  "cost",
  "turnsPerHour",
  "uncachedTokensPerHour",
] as const;
export const CEILING_BREACH_ACTIONS = [
  "hard-stop",
  "notify",
  "suppressed-operator-active",
] as const;
export const CeilingBreachSummarySchema = z
  .object({
    dimension: z.enum(CEILING_BREACH_DIMENSIONS),
    kind: z.enum(CEILING_BREACH_KINDS),
    value: z.number().nullable(),
    ceiling: z.number().nullable(),
    action: z.enum(CEILING_BREACH_ACTIONS),
    occurredAtMs: z.number(),
  })
  .passthrough();
export type CeilingBreachSummary = z.infer<typeof CeilingBreachSummarySchema>;
export type CeilingBreachDimension = CeilingBreachSummary["dimension"];
export type CeilingBreachKind = CeilingBreachSummary["kind"];
export type CeilingBreachAction = CeilingBreachSummary["action"];

/** Session-level token + cost totals, derived from the `v_session_totals` view. */
export const SessionTokenTotalsSchema = z
  .object({
    hapiSessionId: z.string(),
    nodeId: z.string().nullable(),
    namespace: z.string().nullable(),
    turnCount: z.number(),
    firstStartedAtMs: z.number().nullable(),
    lastEndedAtMs: z.number().nullable(),
    totalDurationMs: z.number().nullable(),
    totalTokIn: z.number().nullable(),
    totalTokOut: z.number().nullable(),
    totalTokCacheRead: z.number().nullable(),
    totalTokCacheWrite: z.number().nullable(),
    /** Rate-card-computed authoritative "API value" (Sub E); NOT SDK total_cost_usd. */
    totalCost: z.number().nullable(),
    lastSeq: z.number().nullable(),
    lastModelId: z.string().nullable(),
    lastAccountId: z.string().nullable(),
    lastLinkedIssue: z.string().nullable(),
    lastRepo: z.string().nullable(),
    /** Issue #4824: the part of `totalCost` from turns (and background agents)
     *  that ran on an `api-key` / `gateway-key` binding — real charges. */
    realCost: z.number().nullable().optional(),
    /** Issue #4824: the part from `subscription-account` turns — an
     *  API-equivalent value, not a charge. */
    equivalentCost: z.number().nullable().optional(),
    /** Issue #4824: the part from rows with no recorded binding (legacy rows)
     *  or an `inherited` one. The three parts sum to `totalCost`. All three are
     *  optional: an older federation peer does not send them. */
    unattributedCost: z.number().nullable().optional(),
    /** Issue #5254 R5: turns started in the trailing 60 minutes. Optional: an
     *  older federation peer does not send the rate fields. Aggregate-only
     *  (never on the per-session `getSessionTotals` hot path). */
    turnsLastHour: z.number().nullable().optional(),
    /** Issue #5254 R5: uncached tokens in the trailing 60 minutes (turns plus
     *  background agents — the value the ceiling guard meters). */
    uncachedTokensLastHour: z.number().nullable().optional(),
    /** Issue #5254 R5: the session's peak turns in any rolling 60 minutes. */
    peakTurnsPerHour: z.number().nullable().optional(),
    /** Issue #5254 R5: the peak uncached tokens in any rolling 60 minutes —
     *  TURN tokens only (background agents carry no per-turn timestamp). */
    peakUncachedTokensPerHour: z.number().nullable().optional(),
    /** Issue #5254 R5: the session's most recent ceiling-guard breach. */
    lastCeilingBreach: CeilingBreachSummarySchema.nullable().optional(),
  })
  .passthrough();
export type SessionTokenTotals = z.infer<typeof SessionTokenTotalsSchema>;

/** One finalized turn's token + cost breakdown (prompt→Stop boundary). */
export const TurnTokenBreakdownSchema = z
  .object({
    seq: z.number(),
    startedAtMs: z.number(),
    endedAtMs: z.number().nullable(),
    status: z.string(),
    modelId: z.string().nullable(),
    tokIn: z.number().nullable(),
    tokOut: z.number().nullable(),
    tokCacheRead: z.number().nullable(),
    tokCacheWrite: z.number().nullable(),
    /** Rate-card-computed per-turn API value (Sub E `cost_total`). */
    costTotal: z.number().nullable(),
    /** Issue #4068: the launcher the turn ran on — `sdk`/`pty`/`tmux` for
     *  claude, the flavor name for non-claude runners, null on legacy rows.
     *  Optional so an older federation peer's response still parses. */
    launcher: z.string().nullable().optional(),
    /** Issue #4824: the `authBinding.kind` the turn ran under, recorded when it
     *  opened; null on a legacy row. Optional for federation skew. */
    authBindingKind: z.string().nullable().optional(),
  })
  .passthrough();
export type TurnTokenBreakdown = z.infer<typeof TurnTokenBreakdownSchema>;

/**
 * Issue #4385: one background agent's stored usage — the agent file's FULL,
 * message-id-deduped usage, recorded on the owning node when the agent finished.
 * `agentId` is the Claude Code agent id that names `subagents/agent-<id>.jsonl`
 * (=== `BackgroundAgentEntry.id`), so a breakdown row can open #4386's peek.
 */
export const BackgroundAgentUsageEntrySchema = z
  .object({
    agentId: z.string(),
    agentType: z.string().nullable(),
    description: z.string().nullable(),
    status: z.string(),
    tokIn: z.number(),
    tokOut: z.number(),
    tokCacheRead: z.number(),
    tokCacheWrite: z.number(),
    costTotal: z.number().nullable(),
    startedAtMs: z.number().nullable(),
    endedAtMs: z.number().nullable(),
  })
  .passthrough();
export type BackgroundAgentUsageEntry = z.infer<
  typeof BackgroundAgentUsageEntrySchema
>;

/**
 * Issue #4385: the session's background-agent breakout — built from the
 * `background_agent_usage` rows (the ONE source). The same sums are already
 * folded into `totals.totalTok*` / `totals.totalCost`; this block only says how
 * much of the total they are, and per agent.
 */
export const BackgroundAgentUsageSchema = z
  .object({
    count: z.number(),
    tokIn: z.number(),
    tokOut: z.number(),
    tokCacheRead: z.number(),
    tokCacheWrite: z.number(),
    /** Null when no stored agent has a rate-card price. */
    costTotal: z.number().nullable(),
    agents: z.array(BackgroundAgentUsageEntrySchema),
  })
  .passthrough();
export type BackgroundAgentUsage = z.infer<typeof BackgroundAgentUsageSchema>;

/** Response body for GET /api/sessions/:id/token-stats. */
export const SessionTokenStatsResponseSchema = z
  .object({
    /** Null when the session has no recorded turns yet. */
    totals: SessionTokenTotalsSchema.nullable(),
    /** Per-turn breakdown, ascending by `seq`. */
    turns: z.array(TurnTokenBreakdownSchema),
    /** Issue #4385: background-agent breakout; absent when the session has no
     *  stored background agent. Optional so an older federation peer's
     *  response (which never sends it) still parses. */
    backgroundAgentUsage: BackgroundAgentUsageSchema.optional(),
  })
  .passthrough();
export type SessionTokenStatsResponse = z.infer<
  typeof SessionTokenStatsResponseSchema
>;

/**
 * `GET /api/sessions/:id/background-agents/:agentId/transcript` — one background
 * agent's sub-transcript, newest-first, scrubbed (#4386, R2/R5). Modeled on the
 * transcript-messages page. `before` loads the next OLDER page (null at the
 * start); `remaining` drives "Load earlier · N more"; `nextCursor` is the
 * forward (live-tail) seam for #4388. `.passthrough()` for mixed-version
 * federation (the proxy lands in #4387).
 */
export const AgentTranscriptPageSchema = z
  .object({
    messages: z.array(DecryptedMessageSchema),
    before: z.string().nullable(),
    remaining: z.number(),
    nextCursor: z.string(),
    /** tool_use id → where its truncated result lives and its full length. */
    truncatedToolResults: z.record(
      z.string(),
      z.object({ seq: z.number(), chars: z.number() })
    ),
    tokens: z.object({
      in: z.number(),
      out: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
    agentType: z.string().nullable(),
    description: z.string().nullable(),
  })
  .passthrough();
export type AgentTranscriptPage = z.infer<typeof AgentTranscriptPageSchema>;

// ─────────────────────── Workflow-state badges (#1672 — Sub J) ───────────────────────
// Per-turn workflow chip + session checkpoint badge from captured label events
// (epic #1662, Sub J). Single source of truth for GET /api/sessions/:id/workflow-state,
// shared by the server route (which builds the response from the `v_workflow_state`
// view + `turn_events` label rows) and the web client. The phase-map interpretation
// (label → phase, highest-checkpoint) lives in `@hapi/protocol/workflowPhases`; these
// schemas carry only RAW labels + per-turn label events. All J surfaces are best-effort
// display (R7) — `badge` is nullable and `turns` may be empty.

/** One resolved workflow label mutation inside a turn (R5: carries the issue it touched). */
export const WorkflowLabelEventSchema = z
  .object({
    kind: z.enum(["label_added", "label_removed"]),
    label: z.string(),
    issueNumber: z.number(),
    tsMs: z.number(),
  })
  .passthrough();
export type WorkflowLabelEvent = z.infer<typeof WorkflowLabelEventSchema>;

/** One turn's resolved workflow label events (prompt→Stop boundary) — feeds the per-turn chip (R1). */
export const TurnWorkflowBreakdownSchema = z
  .object({
    seq: z.number(),
    startedAtMs: z.number(),
    endedAtMs: z.number().nullable(),
    events: z.array(WorkflowLabelEventSchema),
  })
  .passthrough();
export type TurnWorkflowBreakdown = z.infer<typeof TurnWorkflowBreakdownSchema>;

/** Net active workflow labels for a session's linked issue, from `v_workflow_state` (R2). */
export const SessionWorkflowBadgeSchema = z
  .object({
    issueNumber: z.number(),
    /** Net active labels (lock + checkpoint) per the non-monotonic view (R4). */
    activeLabels: z.array(z.string()),
    lastEventTsMs: z.number().nullable(),
  })
  .passthrough();
export type SessionWorkflowBadge = z.infer<typeof SessionWorkflowBadgeSchema>;

/** Response body for GET /api/sessions/:id/workflow-state. */
export const SessionWorkflowStateResponseSchema = z
  .object({
    /** Null when the session has no linked issue or no workflow-state row yet. */
    badge: SessionWorkflowBadgeSchema.nullable(),
    /** Per-turn resolved label events, ascending by `seq`. */
    turns: z.array(TurnWorkflowBreakdownSchema),
  })
  .passthrough();
export type SessionWorkflowStateResponse = z.infer<
  typeof SessionWorkflowStateResponseSchema
>;

// ─────────────────────── API Keys vault (#1955, epic #1954) ───────────────────────
// Management-UI layer over node-local provider API keys. B2 (#1955) builds the
// STORE — an `apiKeys[]` field in settings.json (0600) — plus the admin page and
// CRUD endpoints. #1734's OmniBox provides the security *patterns* (0600 perms;
// agent-never-sees-key via SECRET_ENV_VARS strip + egress broker), NOT a turnkey
// store. The secret (`key`) is stored plaintext-at-rest in the 0600 file
// (consistent with the existing `openRouterApiKey` / `cliApiToken`) and is NEVER
// returned over the HTTP API after initial entry (R5) — only the redacted (masked)
// view crosses the wire. B3 (#1956) adds a per-key validation `status`; B4 (#1957)
// adds a conversational-registration `descriptor` — both ride StoredApiKey's
// `.passthrough()` without a schema break.

/** Known provider discriminators. `custom` is the escape hatch for any
 *  OpenAI-compatible gateway not enumerated here. `provider` is STORED as a
 *  plain string (forward-compat), but the POST boundary validates against this
 *  closed set (OQ-5). `openrouter` matches #1733's Codex gateway consumer, which
 *  the B2 add/remove write-through keeps in sync (R9/KD-3). */
export const API_KEY_PROVIDERS = [
  "openrouter",
  "openai",
  "anthropic",
  "gemini",
  "google",
  "custom",
] as const;
export const ApiKeyProviderSchema = z.enum(API_KEY_PROVIDERS);
export type ApiKeyProvider = z.infer<typeof ApiKeyProviderSchema>;

/** Provider → key-generation page URL (#3812). The SINGLE source of the "where do
 *  I get this key" hint for every consumer: the API Keys page's "Get your key" link
 *  (this page); #3806's provider sections and #3807's Gemini link "consume if landed";
 *  #2724's `connectors.ts` `tokenPageUrl` IMPORTS this map, never restates it.
 *
 *  Keyed by the EXISTING {@link API_KEY_PROVIDERS} members — the enum is NOT widened
 *  (D24 → A): a `Partial<Record<…>>` adds a lookup dimension without touching the POST
 *  boundary's accepted-provider set. `custom` is deliberately absent (an arbitrary
 *  OpenAI-compatible gateway has no canonical key page).
 *
 *  URLs are BROWSER-verified 2026-09-19 — scripted probes cannot confirm all of them
 *  (OpenAI 403s non-browser clients; the Anthropic console 301s to platform.claude.com).
 *  Providers occasionally move key pages: update HERE (one place), not inline in a
 *  component. The structure test in schemas.test.ts catches a malformed entry, not a
 *  moved page.
 *   - openrouter → https://openrouter.ai/keys              (307 alias of /workspaces/default/keys)
 *   - openai     → https://platform.openai.com/api-keys
 *   - anthropic  → https://platform.claude.com/settings/keys (console.anthropic.com/settings/keys 301s here)
 *   - gemini     → Google AI Studio
 *   - google     → Google AI Studio (alias of gemini; both open the same page) */
export const API_KEY_PROVIDER_URLS: Partial<Record<ApiKeyProvider, string>> = {
  openrouter: "https://openrouter.ai/keys",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://platform.claude.com/settings/keys",
  gemini: "https://aistudio.google.com/app/apikey",
  google: "https://aistudio.google.com/app/apikey",
};

/** Narrowing accessor for {@link API_KEY_PROVIDER_URLS} (#3812). The API Keys page
 *  holds `provider` as a plain `string` (`useState<string>`; the server stores it as
 *  a string for forward-compat), so it cannot index the map directly — this is the ONE
 *  place the `string → ApiKeyProvider` cast lives. Returns the key-page URL for a known
 *  provider, or `undefined` for `custom` and any unknown id. */
export function getApiKeyProviderUrl(provider: string): string | undefined {
  return API_KEY_PROVIDER_URLS[provider as ApiKeyProvider];
}

/** Per-key validation status (B3 #1956), driven by the per-provider validation
 *  adapters and surfaced in {@link RedactedApiKey} for the API Keys page (#1955)
 *  AND the future account↔API-key selector (epic #1947 A3, SEAM-2 — reads it off
 *  the GET list response). The four states:
 *  - `valid` 🟢 — last probe returned success
 *  - `invalid` 🔴 — last probe returned a definitive auth rejection (401/403)
 *  - `unverified` 🟠 — ambiguous/transient probe (network/timeout/429/5xx) or no
 *    adapter for the provider; NEVER demotes a known-good key (sticky last-known-good)
 *  - `none` ⚪ — never validated (initial state), or no key for the provider (selector) */
export const API_KEY_STATUSES = [
  "valid",
  "invalid",
  "unverified",
  "none",
] as const;
export const ApiKeyStatusSchema = z.enum(API_KEY_STATUSES);
export type ApiKeyStatus = z.infer<typeof ApiKeyStatusSchema>;

/** A reusable, NON-SECRET service descriptor (B4 #1957). The Claude-assisted
 *  conversational registration flow (Architecture S — descriptor-first) captures
 *  this descriptor — provider config ONLY, NEVER the secret — and the secure
 *  client-side entry card persists it alongside the key through the existing
 *  #1955 vault (the secret crosses the wire exactly once: card → server). It
 *  rides {@link StoredApiKeySchema}'s `.passthrough()` and is whitelisted into
 *  {@link RedactedApiKeySchema}. `.passthrough()` here so a new provider is data,
 *  not code (a `custom` OpenAI-compatible gateway carries its `baseUrl`).
 *  INVARIANT: this schema MUST NOT carry any secret-bearing field — the secret
 *  lives ONLY in `StoredApiKey.key`. */
export const ServiceDescriptorSchema = z
  .object({
    /** How the descriptor was created — drives the "via chat" provenance badge. */
    source: z.enum(["conversational", "manual"]).default("manual"),
    /** Base URL for a custom / OpenAI-compatible gateway (the "data not code" axis). */
    baseUrl: z.string().url().max(2048).optional(),
    /** Optional default-model hint for the provider. */
    model: z.string().max(200).optional(),
    /** Free-form note captured during the conversational flow. */
    notes: z.string().max(500).optional(),
  })
  .passthrough();
export type ServiceDescriptor = z.infer<typeof ServiceDescriptorSchema>;

/** What the last validation probe honestly reported (#4463): the provider's HTTP
 *  status, and for a models-list probe the number of models the key can reach
 *  (`modelCountCapped` when the list held more than one page). Every field is
 *  optional — a network error has no status, and OpenRouter lists no models. No
 *  quota, rate-limit or billing figure exists here; no provider text is stored. */
export const ApiKeyLastValidationSchema = z.object({
  httpStatus: z.number().int().optional(),
  modelCount: z.number().int().nonnegative().optional(),
  modelCountCapped: z.boolean().optional(),
});
export type ApiKeyLastValidation = z.infer<typeof ApiKeyLastValidationSchema>;

/** A key's user-set name budget in the #4463 flows (append add, PATCH). The
 *  schema-wide `label` cap stays 120 for keys stored before. */
export const API_KEY_NAME_MAX_CHARS = 64;

/** A stored provider API key — server-internal; holds the secret `key`.
 *  Persisted in settings.json `apiKeys[]` (0600). `.passthrough()` so B3/B4 can
 *  extend it without a schema break. A provider may hold several entries: the
 *  default POST upserts one entry in place, while an append add (#4463 D-2) and
 *  every Gemini/Google add (each its own Google account) add a new one. NEVER
 *  serialize this to a client — use {@link RedactedApiKey} at the HTTP boundary. */
export const StoredApiKeySchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    /** #3808: OPTIONAL account binding. Widens the vault invariant from "one entry
     *  per provider" to "at most ONE entry per (`provider`, `accountUuid ?? null`)"
     *  so N per-account Gemini keys can coexist. Absent ⇒ the provider's unbound
     *  (default) key — today's behaviour, byte-identical for every pre-#3808 entry.
     *  #3362's resolver reads the entry matching the bound spawn's `accountUuid`; an
     *  unbound spawn reads the entry with no `accountUuid`. [ER 2026-09-19: 3808-5] */
    accountUuid: z.string().optional(),
    label: z.string().optional(),
    /** The secret. Plaintext-at-rest in the 0600 settings file; never returned
     *  over the API after initial entry (R5). */
    key: z.string(),
    createdAt: z.string(), // ISO 8601
    /** Per-key validation status (B3 #1956). Optional — absent on pre-B3 stored
     *  entries; treated as "none" until the first validate. Persisted in the 0600
     *  settings file (derived, non-secret state — NOT the key). */
    status: ApiKeyStatusSchema.optional(),
    /** ISO 8601 timestamp of the last validation probe (B3 #1956). Drives the
     *  cache TTL: a re-validate within the window reuses the cached status. */
    lastValidatedAt: z.string().optional(),
    /** Reusable service descriptor (B4 #1957). Non-secret provider config +
     *  provenance captured by the conversational registration flow. Optional —
     *  absent on manually-added keys; rides `.passthrough()` without a break. */
    descriptor: ServiceDescriptorSchema.optional(),
    /** #4463 (D-3 A): the key's monogram override `{ letter?, color? }`, the same
     *  shape the accounts use. Absent ⇒ the client draws the default (the initial
     *  of `label` and a hash colour); the server never generates one. */
    monogram: AccountMonogramSchema.optional(),
    /** #4463: what the last probe reported (status code, reachable models). */
    lastValidation: ApiKeyLastValidationSchema.optional(),
  })
  .passthrough();
export type StoredApiKey = z.infer<typeof StoredApiKeySchema>;

/** Redacted view returned over the HTTP API. Whitelist-by-construction (built
 *  field-by-field, NEVER a spread of StoredApiKey) so it structurally CANNOT
 *  carry `key` — the same discipline as RedactedAccount (#1446). `maskedKey`
 *  shows only enough to recognize the key (e.g. last 4 chars). */
export const RedactedApiKeySchema = z.object({
  id: z.string(),
  provider: z.string(),
  /** #4463 R4: the account the key is bound to (a Gemini key's Google account),
   *  so a key card can join its usage row. Non-secret. */
  accountUuid: z.string().optional(),
  label: z.string().optional(),
  maskedKey: z.string(),
  createdAt: z.string(),
  /** Per-key validation status (B3 #1956). Defaults to "none" when the key has
   *  never been validated. Whitelisted into the redacted view because it is
   *  derived, non-secret state — the SEAM-2 selector (epic #1947 A3) reads it
   *  directly off the GET /api/api-keys list response. */
  status: ApiKeyStatusSchema.default("none"),
  /** ISO 8601 timestamp of the last validation probe; absent until first validate. */
  lastValidatedAt: z.string().optional(),
  /** Reusable service descriptor (B4 #1957). Whitelisted into the redacted view
   *  because it is derived, NON-SECRET state (provider config + provenance) — the
   *  API Keys page reads `descriptor.source` to badge "via chat" registrations.
   *  Explicitly listed (field-by-field) per the no-leak discipline. */
  descriptor: ServiceDescriptorSchema.optional(),
  /** #4463 R4: the key's monogram override; absent ⇒ the client default. */
  monogram: AccountMonogramSchema.optional(),
  /** #4463 R4: the last probe's status code and reachable-model count. */
  lastValidation: ApiKeyLastValidationSchema.optional(),
});
export type RedactedApiKey = z.infer<typeof RedactedApiKeySchema>;

/**
 * Mask a secret for display: a fixed dot run + the last 4 chars, so the user can
 * recognize WHICH key it is without exposing the secret. Keys shorter than 4 chars
 * are fully masked (defensive — a real provider key is far longer).
 *
 * The ONE masking rule (#4568): the vault's {@link RedactedApiKey.maskedKey}, the
 * daemon's spawn-time stamp, and the launcher's per-launch re-check all call this,
 * so the masked form an API-key session records is byte-identical to the one the
 * picker shows and the one the launch compares against.
 */
export function maskApiKey(key: string): string {
  const last4 = key.length >= 4 ? key.slice(-4) : "";
  return `••••${last4}`;
}

/** How POST /api/api-keys places a key (#4463 D-2 A). `upsert` (the default,
 *  what Settings → Keys and the chat registration card send) replaces one entry of
 *  the provider in place; `append` adds a new entry (anthropic, openai, gemini,
 *  google only). */
export const ApiKeyAddModeSchema = z.enum(["upsert", "append"]);
export type ApiKeyAddMode = z.infer<typeof ApiKeyAddModeSchema>;

/** Request body for POST /api/api-keys (add / upsert a provider key). The raw
 *  `key` crosses the wire exactly ONCE here (client → server); thereafter only
 *  the redacted view is returned. */
export const AddApiKeyRequestSchema = z
  .object({
    provider: ApiKeyProviderSchema,
    /** #3808: OPTIONAL account binding — a per-account Gemini key upserts against the
     *  (`provider`, `accountUuid`) pair rather than clobbering the provider's single
     *  entry. Absent ⇒ the provider's unbound (default) key (today's behaviour). */
    accountUuid: z.string().optional(),
    label: z.string().max(120).optional(),
    key: z.string().min(1).max(4096),
    /** Reusable service descriptor (B4 #1957). Sent by the conversational flow's
     *  secure entry card alongside the key; persisted onto the StoredApiKey. */
    descriptor: ServiceDescriptorSchema.optional(),
    /** #4463 D-1 A: probe the key first and store it only when the provider
     *  accepts it. Absent ⇒ store without a probe (today's behaviour). */
    validate: z.boolean().optional(),
    /** #4463 D-2 A: absent ⇒ `upsert`. Deliberately no zod `.default()`: this
     *  type is the parse OUTPUT, and a default would make `mode` required for
     *  every existing caller. */
    mode: ApiKeyAddModeSchema.optional(),
    /** #4463 D-3 A: the key's monogram, normalized by the route before storing. */
    monogram: AccountMonogramSchema.optional(),
  })
  .refine(
    r =>
      r.mode !== "append" ||
      r.label === undefined ||
      r.label.length <= API_KEY_NAME_MAX_CHARS,
    {
      path: ["label"],
      message: `label must be at most ${API_KEY_NAME_MAX_CHARS} characters in append mode`,
    }
  );
export type AddApiKeyRequest = z.infer<typeof AddApiKeyRequestSchema>;

/** Request body for PATCH /api/api-keys/:id (#4463 R6): set the key's name and
 *  monogram in one write. An absent field is left as it is; an empty `label`
 *  clears the name, and a monogram that normalizes to `{}` clears the override. */
export const PatchApiKeyRequestSchema = z.object({
  label: z.string().max(API_KEY_NAME_MAX_CHARS).optional(),
  monogram: AccountMonogramSchema.optional(),
});
export type PatchApiKeyRequest = z.infer<typeof PatchApiKeyRequestSchema>;

// ── Feedback (epic #2663 — In-app feedback system; Sub-Issue A #2664) ────────
// Shared payload for POST /api/feedback. Pinned HERE in @hapi/protocol (the
// package server + web both import) so the server route's Zod validation and
// the web client's types derive from ONE source. #2665 (attachments) EXTENDS
// this file — do NOT fork a route-local copy.

/** Feedback category selector (Bug / Feature request / Other). */
export const FeedbackCategorySchema = z.enum(["bug", "feature", "other"]);
export type FeedbackCategory = z.infer<typeof FeedbackCategorySchema>;

/**
 * The category a STORED / emailed feedback row carries (issue #4371): the
 * user-selectable categories above plus `support-escalation`, which only the
 * server composes (the in-app support "Contact a human" bundle,
 * `POST /api/support/escalation/send`). `FeedbackRequestSchema` deliberately
 * keeps the narrower {@link FeedbackCategorySchema}, so a client can never
 * submit a row that poses as a support escalation.
 */
export const FeedbackEntryCategorySchema = z.enum([
  ...FeedbackCategorySchema.options,
  "support-escalation",
]);
export type FeedbackEntryCategory = z.infer<typeof FeedbackEntryCategorySchema>;

/** Whitelisted install-metadata block, composed client-side from GET /api/about. */
const FeedbackAboutSchema = z
  .object({
    osName: z.string().max(200).optional(),
    kernel: z.string().max(200).optional(),
    arch: z.string().max(50).optional(),
    deviceModel: z.string().max(200).optional(),
    cpuCores: z.number().int().min(0).max(4096).optional(),
    totalRamBytes: z.number().min(0).optional(),
    serverUptimeSec: z.number().min(0).optional(),
    systemUptimeSec: z.number().min(0).optional(),
    tailnet: z.string().max(200).optional(),
  })
  .strict();

/** Whitelisted live-VM-stats block, composed client-side from GET /api/system-health. */
const FeedbackStatsSchema = z
  .object({
    cpuUsagePercent: z.number().optional(),
    cpuTemperatureF: z.number().nullable().optional(),
    memUsedBytes: z.number().min(0).optional(),
    memTotalBytes: z.number().min(0).optional(),
    memUsagePercent: z.number().optional(),
    swapUsagePercent: z.number().nullable().optional(),
    diskUsagePercent: z.number().nullable().optional(),
    hostname: z.string().max(200).optional(),
    uptimeSec: z.number().min(0).optional(),
  })
  .strict();

/** Whitelisted session-launch-config block, present ONLY inside a session view (R3). */
const FeedbackSessionSchema = z
  .object({
    sessionId: z.string().max(200).optional(),
    workingDir: z.string().max(1000).optional(),
    flavor: z.string().max(100).optional(),
    launcherKind: z.string().max(50).optional(),
    accountEmail: z.string().max(320).optional(),
    accountUuid: z.string().max(200).optional(),
    safeMode: z.boolean().optional(),
    modelMode: z.string().max(100).optional(),
    activeModel: z.string().max(200).optional(),
    effort: z.string().max(50).optional(),
    rawModel: z.string().max(200).optional(),
  })
  .strict();

/**
 * The privacy-safe metadata whitelist sent with each feedback submission (R4).
 * CLOSED shape (`.strict()`) with a bounded max length on every string, so the
 * whitelist is enforced on the SERVER (Zod rejects any un-whitelisted key with
 * 400) — NOT just by the client composer. Do NOT relax to `.passthrough()` /
 * `z.record(...)`: that would let arbitrary client keys (message content,
 * tokens, notes) ride through. Every field is optional so a partial/degraded
 * compose (e.g. #2513 blank VM stats) still validates. `stats`/`session` union
 * a literal degrade-marker with their object so R5 ("unavailable") and R3
 * ("no active session") are representable in the same closed schema.
 */
export const FeedbackMetadataSchema = z
  .object({
    appVersion: z.string().max(200).optional(),
    route: z.string().max(500).optional(),
    userAgent: z.string().max(500).optional(),
    viewport: z.string().max(64).optional(),
    about: FeedbackAboutSchema.optional(),
    stats: z.union([z.literal("unavailable"), FeedbackStatsSchema]).optional(),
    session: z
      .union([z.literal("no active session"), FeedbackSessionSchema])
      .optional(),
  })
  .strict();
export type FeedbackMetadata = z.infer<typeof FeedbackMetadataSchema>;

/**
 * Attachment caps for the feedback form (issue #2665, epic #2663). Path A
 * carries attachment bytes base64-in-payload, and base64 inflates ~33%, so
 * these caps are DELIBERATELY smaller than the prompt-upload MAX_FILE_SIZE
 * (200 MB in server/src/web/routes/upload.ts): a 200 MB file would be a
 * ~266 MB JSON body. Defined HERE (not a route-local or web-local constant) so
 * the web modal and the server route enforce ONE value — a divergence fails the
 * build, the same shared-default discipline as AUTO_RECOVER_DEFAULT_ENABLED.
 */
export const FEEDBACK_MAX_ATTACHMENTS = 5;
export const FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB across all attachments

/**
 * A single feedback attachment (issue #2665). `data` is the base64-encoded file
 * bytes; the authoritative byte-size cap (FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES) is
 * enforced SERVER-SIDE after decode — the generous string bound here only rejects
 * an absurd payload before it is decoded. `.strict()` mirrors the metadata
 * whitelist so no un-declared key rides along.
 */
export const FeedbackAttachmentSchema = z
  .object({
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255),
    data: z
      .string()
      .min(1)
      .max(FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES * 2),
  })
  .strict();
export type FeedbackAttachment = z.infer<typeof FeedbackAttachmentSchema>;

/** Request body for POST /api/feedback. Bounded lengths on every free-text
 *  field, mirroring the errorReports discipline (server/src/web/routes/errorReports.ts). */
export const FeedbackRequestSchema = z.object({
  description: z.string().min(1).max(5000),
  category: FeedbackCategorySchema,
  metadata: FeedbackMetadataSchema,
  /** Login username ≡ account email (epic Design Decision D2); null when unauthenticated. */
  submitterEmail: z.string().max(320).nullable(),
  route: z.string().max(500).optional(),
  appVersion: z.string().max(200).optional(),
  /** Optional user-attached files (issue #2665). Carried base64-in-payload
   *  (Path A); MIME allowlist + total byte-size are re-validated server-side.
   *  Count is bounded here; the empty/omitted case is #2664's plain feedback. */
  attachments: z
    .array(FeedbackAttachmentSchema)
    .max(FEEDBACK_MAX_ATTACHMENTS)
    .optional(),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

/** Response body for POST /api/feedback — the persisted row id. */
export const FeedbackResponseSchema = z.object({ id: z.string() });
export type FeedbackResponse = z.infer<typeof FeedbackResponseSchema>;

/**
 * Issue #3809: the CLI→server carrier for an OpenAI/codex
 * `token_count.rate_limits` pacing snapshot. Emitted by `codexRemoteLauncher`
 * through the SAME `/cli` socket the turn reporter uses (a DISTINCT event —
 * `provider-usage-snapshot` — never a parallel channel), received by
 * `socket/handlers/cli/sessionHandlers.ts`. The server attributes the snapshot
 * to the session's bound account (`session.metadata.accountUuid` — the same key
 * `turnEnrichment` stamps on `turns.account_id`, so OpenAI snapshots and the
 * Google counter key identically), and `ProviderUsageService` normalizes each
 * window's reset (a codex epoch-seconds `resets_at`, or a relative
 * `resets_in_seconds` → `now + …`) into an ISO-8601 string.
 *
 * `.passthrough()` on the window tolerates codex protocol additions (codex-origin
 * data — the `@hapi/protocol` convention). No secret ever rides here — only usage
 * percentages + reset times.
 */
export const ProviderUsageSnapshotWindowSchema = z
  .object({
    name: z.enum(["primary", "secondary"]),
    used_percent: z.number(),
    window_minutes: z.number(),
    // Absolute reset — codex emits epoch SECONDS (number); an ISO or epoch string
    // is also tolerated. The installed 0.147.x field name is pinned by #3352 T1;
    // the receiver normalizes whichever form arrives.
    resets_at: z.union([z.string(), z.number()]).nullish(),
    // Relative reset — normalized to `now + resets_in_seconds` server-side.
    resets_in_seconds: z.number().nullish(),
  })
  .passthrough();
export type ProviderUsageSnapshotWindow = z.infer<
  typeof ProviderUsageSnapshotWindowSchema
>;

export const ProviderUsageSnapshotMessageSchema = z.object({
  sid: z.string(),
  provider: z.literal("openai"),
  windows: z.array(ProviderUsageSnapshotWindowSchema),
});
export type ProviderUsageSnapshotMessage = z.infer<
  typeof ProviderUsageSnapshotMessageSchema
>;

/**
 * Issue #3839: the transcript browser — the `/settings/transcripts` archive of
 * every Claude-harness transcript ever run on this node, scoped to the caller's
 * namespace (D27). Served by `server/src/web/routes/transcripts.ts` over the
 * separate `transcripts.db` FTS index (`server/src/store/transcriptIndexStore.ts`).
 *
 * Every text field that reaches a client (`snippet`, `firstPrompt`) is built
 * from `scrubSecretTokens`-masked text — the index never stores an unmasked
 * token (R6).
 */
export const TranscriptSortSchema = z.enum(["newest", "oldest", "largest"]);
export type TranscriptSort = z.infer<typeof TranscriptSortSchema>;

export const TranscriptListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  fromMs: z.number().int().nonnegative().optional(),
  toMs: z.number().int().nonnegative().optional(),
  harness: z.string().max(100).optional(),
  account: z.string().max(200).optional(),
  repo: z.string().max(500).optional(),
  linkedIssue: z.number().int().positive().optional(),
  sort: TranscriptSortSchema.default("newest"),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
});
export type TranscriptListQuery = z.infer<typeof TranscriptListQuerySchema>;

export const TranscriptSummarySchema = z.object({
  /** Claude Code session id — the transcript's `<id>.jsonl` name. */
  ccSessionId: z.string(),
  /** The Hapimatic session this transcript belonged to, when known. */
  hapiSessionId: z.string().nullable(),
  /** True while the Hapimatic session row still exists (live or archived). */
  hasSessionRow: z.boolean(),
  /** A resumed conversation is a NEW JSONL linked to the one it continued. */
  parentCcSessionId: z.string().nullable(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  repo: z.string().nullable(),
  harness: z.string(),
  account: z.string().nullable(),
  linkedIssue: z.number().nullable(),
  startedAtMs: z.number().nullable(),
  lastActivityMs: z.number().nullable(),
  messageCount: z.number(),
  sizeBytes: z.number(),
  /** Scrubbed text — the first human prompt, truncated. */
  firstPrompt: z.string().nullable(),
  /** Scrubbed FTS snippet around the search match (null without `q`). */
  snippet: z.string().nullable(),
});
export type TranscriptSummary = z.infer<typeof TranscriptSummarySchema>;

export const TranscriptIndexStatusSchema = z.object({
  indexed: z.number(),
  total: z.number(),
  /** False when the arm64 SQLite lacks FTS5 and search degrades to LIKE. */
  fts5: z.boolean(),
  lastSweepAtMs: z.number().nullable(),
  /**
   * True when indexing is off on this instance (#4053): the list reflects the
   * last index, or nothing when none was ever built. Optional for older nodes.
   */
  disabled: z.boolean().optional(),
});
export type TranscriptIndexStatus = z.infer<typeof TranscriptIndexStatusSchema>;

export const TranscriptListResponseSchema = z.object({
  transcripts: z.array(TranscriptSummarySchema),
  total: z.number(),
  status: TranscriptIndexStatusSchema,
});
export type TranscriptListResponse = z.infer<
  typeof TranscriptListResponseSchema
>;

export const TranscriptFilterOptionsSchema = z.object({
  harnesses: z.array(z.string()),
  accounts: z.array(z.string()),
  repos: z.array(z.string()),
  linkedIssues: z.array(z.number()),
});
export type TranscriptFilterOptions = z.infer<
  typeof TranscriptFilterOptionsSchema
>;

/**
 * The resume request. `directory` is the D28 picker's chosen directory — only
 * sent after the server answered `needsDirectory` (the original cwd is gone
 * and no trashed worktree could be restored).
 */
export const TranscriptResumeRequestSchema = z.object({
  directory: z.string().min(1).max(4096).optional(),
});
export type TranscriptResumeRequest = z.infer<
  typeof TranscriptResumeRequestSchema
>;

export const TranscriptResumeResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resumed"),
    sessionId: z.string(),
    /** How the session was continued (reconnect of a live row, or a fresh spawn). */
    via: z.enum(["reconnect", "spawn"]),
    /** True when a soft-deleted worktree was re-materialised first (D28 step C). */
    restoredWorktree: z.boolean(),
    directory: z.string(),
  }),
  z.object({
    type: z.literal("needsDirectory"),
    /** The picker's starting directory (repo root from the transcript cwd, else ~). */
    suggestedDirectory: z.string(),
    machineId: z.string(),
    reason: z.string(),
  }),
]);
export type TranscriptResumeResponse = z.infer<
  typeof TranscriptResumeResponseSchema
>;

/**
 * `GET /api/transcripts/:ccSessionId/messages` — a transcript adapted to the
 * renderer's `DecryptedMessage` input (scrubbed, R6), served one PAGE at a time
 * (#4053) so a response never scales with the transcript's size. A page stops
 * at `limit` entries or `TRANSCRIPT_MESSAGES_BYTE_BUDGET` serialized bytes
 * (always at least one entry); tool results over
 * `TRANSCRIPT_TOOL_RESULT_SERVE_CAP` chars are cut and listed in
 * `truncatedToolResults` so the reader can fetch one in full with
 * `limit=1&full=1`. `nextCursor` (opaque) resumes after the last entry;
 * `truncated` mirrors `nextCursor !== null` for older clients.
 */
export const TRANSCRIPT_MESSAGES_PAGE = 500;
export const TRANSCRIPT_MESSAGES_BYTE_BUDGET = 2 * 1024 * 1024;
export const TRANSCRIPT_TOOL_RESULT_SERVE_CAP = 8192;

export const TranscriptMessagesQuerySchema = z
  .object({
    /** Opaque `<afterSeq>:<byteOffset>` from a previous page's `nextCursor`. */
    cursor: z
      .string()
      .regex(/^\d{1,9}:\d{1,15}$/)
      .optional(),
    limit: z.number().int().min(1).max(TRANSCRIPT_MESSAGES_PAGE).optional(),
    /** `"1"` with `limit=1`: return that entry without tool-result truncation. */
    full: z.literal("1").optional(),
  })
  .refine(q => q.full === undefined || q.limit === 1, {
    message: "full=1 requires limit=1",
    path: ["full"],
  });
export type TranscriptMessagesQuery = z.infer<
  typeof TranscriptMessagesQuerySchema
>;

export const TranscriptMessagesResponseSchema = z.object({
  transcript: TranscriptSummarySchema,
  messages: z.array(DecryptedMessageSchema),
  nextCursor: z.string().nullable(),
  /** tool_use id → where its truncated result lives and its full length. */
  truncatedToolResults: z.record(
    z.string(),
    z.object({ seq: z.number(), chars: z.number() })
  ),
  truncated: z.boolean(),
});
export type TranscriptMessagesResponse = z.infer<
  typeof TranscriptMessagesResponseSchema
>;

/**
 * Query for `GET /api/sessions/:id/background-agents/:agentId/transcript`
 * (#4386). `before` / `after` are opaque `<seq>:<byteOffset>` cursors and are
 * mutually exclusive — `before` pages newest-first ("Load earlier"), `after` is
 * the forward live-tail seam (#4388). `full=1` serves one entry untruncated and
 * is valid only with `limit=1` + `after` (the expand-on-demand read).
 */
export const AgentTranscriptQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(TRANSCRIPT_MESSAGES_PAGE).optional(),
    before: z
      .string()
      .regex(/^\d{1,9}:\d{1,15}$/)
      .optional(),
    after: z
      .string()
      .regex(/^\d{1,9}:\d{1,15}$/)
      .optional(),
    full: z.literal("1").optional(),
  })
  .refine(q => q.before === undefined || q.after === undefined, {
    message: "before and after are mutually exclusive",
    path: ["before"],
  })
  .refine(
    q => q.full === undefined || (q.limit === 1 && q.after !== undefined),
    { message: "full=1 requires limit=1 and after", path: ["full"] }
  );
export type AgentTranscriptQuery = z.infer<typeof AgentTranscriptQuerySchema>;

// ── In-app onboarding tour state (node-local, #3865) ─────────────────
//
// The progress of the P22 first-run feature tour, persisted in THIS instance's
// own settings file under the `onboardingState` key (OQ-2: node-local, never the
// gateway). Steps are stored as IDs, never indexes, so the v2 connector
// checklist can add steps without changing what a stored value means.
// `status` is REQUIRED and has no default: `pending` is the one value that opens
// the tour automatically, and a default would turn every absent or half-written
// value into it. The patch schema has every key optional and no default, so a
// `{ lastStep }`-only PUT cannot fabricate a `status`.
export const ONBOARDING_STEP_IDS = ["t1", "t2", "t3", "t4", "t5"] as const;
export const OnboardingStepIdSchema = z.enum(ONBOARDING_STEP_IDS);
export type OnboardingStepId = z.infer<typeof OnboardingStepIdSchema>;

export const OnboardingStatusSchema = z.enum([
  "pending",
  "dismissed",
  "completed",
]);
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;

export const OnboardingStateSchema = z.object({
  status: OnboardingStatusSchema,
  lastStep: OnboardingStepIdSchema.optional(),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const OnboardingStatePatchSchema = z.object({
  status: OnboardingStatusSchema.optional(),
  lastStep: OnboardingStepIdSchema.optional(),
});
export type OnboardingStatePatch = z.infer<typeof OnboardingStatePatchSchema>;
