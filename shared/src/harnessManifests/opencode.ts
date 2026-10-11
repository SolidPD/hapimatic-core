// SPDX-License-Identifier: AGPL-3.0-only
import type { HarnessManifest } from "../harnessManifest";

/**
 * OpenCode harness manifest.
 *
 * Axis values verified against the installed binary — opencode 1.17.11
 * (`opencode --version` + `opencode --help`) — plus the Hapimatic spawn gates.
 */
export const opencodeManifest: HarnessManifest = {
  agentId: "opencode",
  // verified: opencode 1.17.11 (`opencode --version`).
  verifiedAgainst: "opencode >=1.17.0 <1.18.0",
  // verified: 1.17.11 — no native skills dir in `opencode --help`; skill content
  // reaches opencode via AGENTS.md instruction-file injection.
  skills: { mode: "injected" },
  // verified: 1.17.11 — `opencode plugin` installs JS plugins; hooks are a JS
  // plugin shim (no native lifecycle-event taxonomy).
  hooks: { mode: "plugin-shim", dialectId: "opencode-plugin-js" },
  // verified: 1.17.11 — `opencode mcp` manages servers in `opencode.json`.
  mcp: { configFormatId: "opencode-json" },
  // verified: 1.17.11 — reads AGENTS.md (vendor-neutral LF standard).
  instructionFile: {
    name: "AGENTS.md",
    placement: "project-root",
    semantics: "AGENTS.md",
  },
  // verified: 1.17.11 — `opencode acp` == "start ACP (Agent Client Protocol) server".
  acp: { server: "native", client: "absent" },
  // verified: 1.17.11 — `opencode run <message>` (one-shot) + `opencode serve`
  // (headless server); `opencode export` emits JSON.
  headlessExec: {
    modes: ["run", "serve"],
    outputFormats: ["text", "json"],
  },
  // verified: 1.17.11 — `opencode agent` manages multiple agents (subagents).
  subagents: "native",
  // verified: Hapimatic tmux-persistence gate excludes opencode (sessionSpawner.ts:898).
  sessionPersistence: { tmuxSafe: false },
  // verified: sessionSpawner.ts:1552 — session roles are claude-only.
  sessionRoles: "absent",
  // verified: sessionSpawner.ts:1558 — output styles are claude-only.
  outputStyles: "absent",
  // verified: 1.17.11 — per-tool permission config in opencode.json
  // (allow/ask/deny); no OS-level sandbox subcommand — a HAL-emulated permission
  // model rather than a native OS sandbox.
  sandboxing: "emulated",
  // verified (#3349): opencode reaches models via BOTH the OpenRouter gateway
  // catalog AND — as of #3349 — native providers keyed from the #1955 apiKeys
  // vault (the OpenRouter-mandatory constraint of #1975 is dropped). Model is
  // chosen at spawn, so a change is a relaunch. Dual-source (like codex's
  // ChatGPT-native + OpenRouter): `native-catalog`/`opencode-native` +
  // `openrouter-gateway`/`openrouter`. formState's dual-source mutual exclusion
  // (deriveFormState) picks the OpenRouter picker when the node has gateway auth,
  // else the native provider/model picker (NativeProviderModelFields, #3349).
  modelSelection: {
    catalogSources: [
      { source: "native-catalog", catalogId: "opencode-native" },
      { source: "openrouter-gateway", catalogId: "openrouter" },
    ],
    switchSemantics: "relaunch",
  },
  // verified (#3350 Task 3): opencode has NO in-session permission switching
  // (getPermissionModesForFlavor("opencode") === [] in modes.ts stays empty),
  // but its SPAWN posture IS a real binary distinction — the spawn `yolo` bool
  // reaches buildOpenCodeConfigContent (cli/src/agent/runners/opencodeConfig.ts),
  // emitting every tool category `"allow"` (yolo:true) vs `"ask"` (yolo:false)
  // into OPENCODE_CONFIG_CONTENT (proven at spawn by opencodeConfig.test.ts).
  // So the axis declares the two SPAWN-applicable postures the honest spawn
  // picker offers: `default` = all-`ask` (gated), `yolo` = all-`allow` (bypass).
  // The richer per-tool allow/ask/deny model in opencode.json is not surfaced as
  // distinct picker levels (it does not map to the single spawn `yolo` bool);
  // #3350 R3's fallback KEEPS these two honestly-labeled levels rather than
  // synthesize levels the wire cannot express.
  permissionModes: {
    modes: [
      { id: "default", applicability: "spawn" },
      { id: "yolo", applicability: "spawn" },
    ],
  },
  // verified (#3352 Task 1, opencode 1.17.11): opencode is ACP and emits a
  // `usage_update` session/update (context occupancy — the shared ACP {size,
  // used} shape). Per-turn tokens use a CLAUDE-STYLE `usage` object
  // (`{input, output, cache_read_input, cache_creation_input}` — a FULL cache
  // read/write split, field names verified in-binary), read by the shared ACP
  // detector's shape-B path. ⚠️ The exact ACP CARRIER of the per-turn usage
  // object was not confirmed against a live opencode session this pass; the
  // detector degrades honestly to context-only if the shape is absent (R4).
  // opencode is multi-provider — re-verify per model on upgrade.
  usageReporting: {
    mode: "native",
    granularity: "per-turn",
    cacheSplit: true,
    contextWindow: true,
    note: "opencode 1.17.11 (ACP): context via usage_update {size,used}; per-turn tokens + full cache split via a claude-style usage object (shared ACP detector shape-B); live per-turn carrier pending verification.",
  },
  // verified (#3349): opencode honestly supports two credential kinds — a native
  // per-provider `api-key` from the #1955 apiKeys vault (delivered into the
  // OPENCODE_CONFIG_CONTENT provider block, #3349 native path) OR the OpenRouter
  // `gateway-key` (settings.json openRouterApiKey → OPENROUTER_API_KEY env, the
  // pre-#3349 path). No `subscription-account` (opencode has no ChatGPT-style
  // OAuth path) and no `inherited`.
  authBinding: { kinds: ["api-key", "gateway-key"] },
  // verified: Tier-0 delivered as a leading text block on the FIRST ACP turn
  // (runAgentSession, shared with gemini), once per session (R6); disabled by
  // HAPI_CAPABILITY_TIER0=0 (R8).
  capabilityInjection: {
    mode: "first-turn-prompt",
    verifiedOn: "runAgentSession first-turn Tier-0 test (issue #3748)",
  },
  // #3811: opencode runs through the SAME generic ACP runner as gemini, so its
  // native id is the ACP session id in metadata.acpSessionId — NOT `absent`.
  // Modal → "OpenCode ID".
  nativeSessionId: {
    mode: "native",
    field: "acpSessionId",
    label: "OpenCode",
    description: "OpenCode ACP session ID",
  },
  // Host-jail axis (issue #3813). opencode is never jailed (tmuxSafe === false) and
  // has no host-jail needs — `absent` (all arrays empty, enforced by the schema's
  // .refine + manifests.test.ts).
  hostJail: {
    mode: "absent",
    reexposeHomeDirs: [],
    egressHosts: [],
    keepSecrets: [],
  },
};
