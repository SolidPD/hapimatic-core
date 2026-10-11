// SPDX-License-Identifier: AGPL-3.0-only
import type { HarnessManifest } from "../harnessManifest";
import { CODEX_REASONING_EFFORTS } from "../codexModelCatalog";

/**
 * Codex CLI harness manifest.
 *
 * Axis values verified against the installed binary — codex-cli 0.147.0
 * (`codex --version` + `codex --help` / `codex exec --help` / `codex mcp --help`).
 * ⚠️ Codex is volatile — see sibling epic members #2196 (`wire_api=responses`)
 * and #3060 (session death); re-verify the `mcp` / `headlessExec` axes on upgrade.
 */
export const codexManifest: HarnessManifest = {
  agentId: "codex",
  // verified: codex-cli 0.147.0 (`codex --version`).
  verifiedAgainst: "codex-cli >=0.147.0 <0.148.0",
  // verified: 0.147.0 — no native skills dir in `codex --help`; skill content
  // reaches codex via AGENTS.md instruction-file injection.
  skills: { mode: "injected" },
  // verified: epic #3117 survey — codex hooks.json clones the Claude hook
  // taxonomy since v0.114 (0.147.0 > 0.114); config in `~/.codex/config.toml`.
  hooks: { mode: "native-taxonomy", dialectId: "codex-hooks-json" },
  // verified: 0.147.0 — `codex mcp` manages servers in `~/.codex/config.toml`.
  mcp: { configFormatId: "codex-config-toml" },
  // verified: 0.147.0 — reads AGENTS.md (vendor-neutral LF standard).
  instructionFile: {
    name: "AGENTS.md",
    placement: "project-root",
    semantics: "AGENTS.md",
  },
  // verified: 0.147.0 — no `acp` subcommand (`app-server`/`mcp-server` are not ACP).
  acp: { server: "absent", client: "absent" },
  // verified: 0.147.0 — `codex exec` + `codex review` run non-interactively;
  // `codex exec --json` prints JSONL events.
  headlessExec: {
    modes: ["exec", "review"],
    outputFormats: ["text", "jsonl"],
  },
  // verified: 0.147.0 — no subagent primitive in `codex --help`.
  subagents: "absent",
  // verified: Hapimatic tmux-persistence gate sessionSpawner.ts:898
  // (`agent === "claude" || agent === "codex"`).
  sessionPersistence: { tmuxSafe: true },
  // verified: sessionSpawner.ts:1552 — session roles are claude-only.
  sessionRoles: "absent",
  // verified: sessionSpawner.ts:1558 — output styles are claude-only.
  outputStyles: "absent",
  // verified: 0.147.0 — native `codex sandbox` subcommand + `sandbox_permissions`
  // config.
  sandboxing: "native",
  // verified: codex reaches the OpenRouter gateway model catalog today
  // (web ModelSelector.tsx — the picker shows for codex on a gateway:openrouter
  // target; an empty selection falls back to ChatGPT auth). Model is chosen at
  // spawn (`--hapi-model` / config.toml bake), so a change is a relaunch. #3348
  // adds the codex-native (ChatGPT-token) catalog alongside OpenRouter — DUAL
  // source: the OpenRouter picker binds when the node has gateway auth, else the
  // ChatGPT-token native picker binds (mutual exclusion lives in deriveFormState).
  // reasoningEffort verified against the installed binary (codex-cli 0.147.0
  // ~/.codex/models_cache.json 2026-09-21) — see codexModelCatalog.ts.
  modelSelection: {
    catalogSources: [
      { source: "openrouter-gateway", catalogId: "openrouter" },
      { source: "native-catalog", catalogId: "codex-native" },
    ],
    switchSemantics: "relaunch",
    reasoningEffort: { values: [...CODEX_REASONING_EFFORTS] },
  },
  // verified: CODEX_PERMISSION_MODES (modes.ts). Every native id is "both" —
  // codex switches modes in-session today (session.ts setMode + the composer
  // PermissionModeTrigger), and all four are spawn-selectable (finding 3346-2
  // corrected the earlier "spawn"-only example).
  permissionModes: {
    modes: [
      { id: "default", applicability: "both" },
      { id: "read-only", applicability: "both" },
      { id: "safe-yolo", applicability: "both" },
      { id: "yolo", applicability: "both" },
    ],
  },
  // verified (#3352 Task 1, codex-cli 0.147.0): the `token_count` event nests
  // usage under `info` — `last_token_usage` (per-turn input/output + a cache-READ
  // count `cached_input_tokens`) and `total_token_usage.total_tokens` /
  // `model_context_window` (context occupancy). A cache-read count is ingested,
  // but NO cache-WRITE split exists, so `cacheSplit` is false (R4). Codex is
  // volatile (#2196/#3060/#3216) — re-verify on upgrade.
  usageReporting: {
    mode: "native",
    granularity: "per-turn",
    cacheSplit: false,
    contextWindow: true,
    note: "codex-cli 0.147.0: token_count.info.last_token_usage (in/out + cached_input read); context via total_token_usage.total_tokens + model_context_window; no cache-write split.",
  },
  // verified (Ruling D5): codex binds either a subscription ChatGPT account
  // (empty OpenRouter selection) or the OpenRouter gateway key
  // (settings.json openRouterApiKey, delivered via the OPENROUTER_API_KEY env).
  // #3807 (epic #3345) adds the in-app `codex login --with-api-key` path, which
  // binds a raw OpenAI api-key in a per-account codex home — so `api-key` is now
  // a real codex authBinding kind (the enum already carries it,
  // harnessManifest.ts). [ER 2026-09-19: 3807-7]
  authBinding: { kinds: ["subscription-account", "api-key", "gateway-key"] },
  // verified: codexSystemPrompt appends Tier-0 to developer_instructions (local
  // + remote paths), surviving TOML escaping (R5/R5a); disabled by
  // HAPI_CAPABILITY_TIER0=0 (R8).
  capabilityInjection: {
    mode: "developer-instructions",
    verifiedOn: "codexSystemPrompt.test + TOML round-trip (issue #3748)",
  },
  // #3811: codex's native session id is ALREADY persisted as
  // metadata.codexSessionId (threadId ?? sessionId, #3060) — the descriptor
  // names that existing field; no second write. Modal composes "Codex ID".
  nativeSessionId: {
    mode: "native",
    field: "codexSessionId",
    label: "Codex",
    description:
      "Codex thread ID (the legacy session id on codex < 0.144.6 — the field holds threadId ?? sessionId)",
  },
  // Host-jail axis (issue #3813). Re-expose `~/.codex` (the host-login auth dir);
  // ADD OpenAI's inference/auth hosts to the node-wide egress allowlist
  // (chatgpt.com = the ChatGPT-subscription backend at /backend-api/codex,
  // auth.openai.com = OAuth, api.openai.com = API key); KEEP OPENAI_API_KEY through
  // the per-flavor strip (a codex child needs it for provider auth). This is the ONLY
  // flavor whose egressHosts currently reach the node-wide list (tmuxSafe === true).
  hostJail: {
    mode: "native",
    reexposeHomeDirs: [".codex"],
    egressHosts: ["api.openai.com", "auth.openai.com", "chatgpt.com"],
    keepSecrets: ["OPENAI_API_KEY"],
  },
};
