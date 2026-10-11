// SPDX-License-Identifier: AGPL-3.0-only
import type { HarnessManifest } from "../harnessManifest";
import { EFFORT_LEVELS } from "../effort";

/**
 * Claude Code harness manifest.
 *
 * Axis values verified against the installed binary — claude 2.1.239
 * (`claude --version` + `claude --help`) — plus the Hapimatic spawn gates in
 * `cli/src/daemon/sessionSpawner.ts`.
 */
export const claudeManifest: HarnessManifest = {
  agentId: "claude",
  // verified: claude 2.1.239 (`claude --version`).
  verifiedAgainst: "claude-code >=2.0.0 <3.0.0",
  // verified: 2.1.239 — native skills dir; `/skill-name` resolution,
  // `--disable-slash-commands` == "Disable all skills". Discovered from
  // `.claude/skills/` (project) + `~/.claude/skills/` (user).
  skills: { mode: "native-dir", discoveryPath: ".claude/skills/" },
  // verified: 2.1.239 — native hook lifecycle taxonomy (`--include-hook-events`;
  // `--bare` == "skip hooks"); config in settings.json `hooks` block.
  hooks: { mode: "native-taxonomy", dialectId: "claude-settings-json" },
  // verified: 2.1.239 — `--mcp-config` loads MCP servers from JSON (`mcpServers`).
  mcp: { configFormatId: "mcpServers" },
  // verified: 2.1.239 — vendor-specific CLAUDE.md, auto-discovered at project
  // root + ancestor dirs (the `--bare` flag lists "CLAUDE.md auto-discovery").
  instructionFile: {
    name: "CLAUDE.md",
    placement: "project-root-and-ancestors",
    semantics: "CLAUDE.md",
  },
  // verified: 2.1.239 — no `acp` subcommand; Claude Code is not an ACP peer.
  acp: { server: "absent", client: "absent" },
  // verified: 2.1.239 — `-p/--print` non-interactive; `--output-format`
  // text|json|stream-json.
  headlessExec: {
    modes: ["print"],
    outputFormats: ["text", "json", "stream-json"],
  },
  // verified: 2.1.239 — native subagents (`--agents`, `--agent`, `claude agents`).
  subagents: "native",
  // verified: Hapimatic tmux-persistence gate sessionSpawner.ts:898
  // (`agent === "claude" || agent === "codex"`).
  sessionPersistence: { tmuxSafe: true },
  // verified: sessionSpawner.ts:1552 — the sessionRole gate is claude-only.
  sessionRoles: "native",
  // verified: sessionSpawner.ts:1558 — the outputStyle gate is claude-only.
  outputStyles: "native",
  // verified: 2.1.239 — permission modes + native sandbox
  // (`--dangerously-skip-permissions` gates a real permission enforcement layer).
  sandboxing: "native",
  // verified: claude's native model catalog is MODEL_MODES (modes.ts:
  // sonnet/opus/fable/haiku); switchable live in-session (the `set-model`
  // control request / `/model`). Not the OpenRouter gateway (codex/opencode).
  // reasoningEffort (#3348): claude's `--effort` levels (EFFORT_LEVELS,
  // low..max). Presence here is what keeps the Create-page Effort dropdown
  // visible now that deriveFormState reads the axis instead of a hardcoded
  // `isClaude` gate; per-MODEL narrowing stays downstream (the live catalog's
  // per-model `effortLevels`, ModelEffortRow).
  modelSelection: {
    catalogSources: [{ source: "native-catalog", catalogId: "claude-modes" }],
    switchSemantics: "live",
    reasoningEffort: { values: [...EFFORT_LEVELS] },
  },
  // verified: CLAUDE_PERMISSION_MODES (modes.ts). All four switch in-session via
  // the composer permission switcher; at the spawn wire only the yolo-equivalent
  // survives as the `yolo` boolean (#1951 isYoloEquivalentMode → bypassPermissions),
  // so bypassPermissions + the default (yolo:false baseline) are "both" while
  // acceptEdits/plan collapse to that baseline at spawn and are distinct only
  // in-session.
  permissionModes: {
    modes: [
      { id: "default", applicability: "both" },
      { id: "acceptEdits", applicability: "in-session" },
      { id: "bypassPermissions", applicability: "both" },
      { id: "plan", applicability: "in-session" },
    ],
  },
  // verified: claude SDK emits per-turn usage; server/src/parity/tokenParity.ts
  // tracks the cache read/write split (tokCacheRead/tokCacheWrite); context-window
  // usage is reported (the get-context-usage capability, #1191).
  usageReporting: {
    mode: "native",
    granularity: "per-turn",
    cacheSplit: true,
    contextWindow: true,
  },
  // verified: Hapimatic binds a subscription Anthropic account per session
  // (CLAUDE_CODE_OAUTH_TOKEN injection, #1446) OR — #4568 — a node-vault Anthropic
  // API key chosen at spawn: the SDK launcher's child reads it from the
  // per-session `--settings` `apiKeyHelper` (`hapi api-key-helper`), its only
  // credential — the key is in no process environment, and buildSdkSpawnEnv strips
  // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, which outrank the helper (2.1.280
  // reports `apiKeySource: apiKeyHelper`; a turn needs no approval prompt in
  // streamed-input mode). The PTY/tmux launchers REFUSE a key session (D-4568-2 A).
  authBinding: { kinds: ["subscription-account", "api-key"] },
  // verified: buildSystemPrompt() appends the rendered Tier-0 catalog to the
  // system prompt on all five Claude paths (R4) — folds :10/:12, keeps :14/:16
  // verbatim — within the 2600-char budget; skipped under --safe-mode (R4a),
  // disabled by HAPI_CAPABILITY_TIER0=0 (R8).
  capabilityInjection: {
    mode: "system-prompt",
    verifiedOn: "systemPrompt.test.ts + tier0Budget.test.ts (issue #3748)",
  },
  // #3811: claude's native session id is the Claude Code UUID in
  // metadata.claudeSessionId (shown as "CLI ID" since #4479; `description` is
  // the tooltip).
  nativeSessionId: {
    mode: "native",
    field: "claudeSessionId",
    label: "Claude",
    description: "Claude session ID (UUID from Claude Code)",
  },
  // Host-jail axis (issue #3813). The Anthropic inference/auth hosts already live
  // in DEFAULT_EGRESS_ALLOWLIST (egressPolicy.ts), so claude ADDS none. `~/.claude`
  // is always bound by the jail regardless — listed here only to declare the axis
  // explicitly. No secret kept: a Claude child loses the whole SECRET_ENV_VARS set.
  hostJail: {
    mode: "native",
    reexposeHomeDirs: [".claude"],
    egressHosts: [],
    keepSecrets: [],
  },
};
