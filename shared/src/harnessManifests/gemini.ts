// SPDX-License-Identifier: AGPL-3.0-only
import type { HarnessManifest } from "../harnessManifest";

/**
 * Gemini CLI harness manifest.
 *
 * Axis values verified against the installed binary — gemini-cli 0.57.0
 * (`gemini --version` + `gemini --help` + the `skills`/`hooks`/`mcp` subcommand
 * help) — plus the Hapimatic spawn gates in `cli/src/daemon/sessionSpawner.ts`.
 * (Issue #3346 re-verified the epic #3117 2026-08 survey axes against the
 * now-installed binary — #2008 installed it — and corrected the drift the survey
 * carried: `skills` is a NATIVE subcommand, not injection, and `headlessExec`
 * emits `stream-json`.) The four #3345 session-UX axes stay `// survey:` where
 * the behavioral verdict is owned by a downstream sub (noted per axis).
 */
export const geminiManifest: HarnessManifest = {
  agentId: "gemini",
  // verified: gemini-cli 0.57.0 (`gemini --version`).
  verifiedAgainst: "gemini-cli >=0.57.0 <0.58.0",
  // verified: 0.57.0 — NATIVE skill discovery via the `gemini skills` subcommand
  // (`skills list/install/link/enable/disable`), NOT injection (the 2026-08
  // survey was wrong). Exact discovery dir not surfaced by `--help`, so the
  // optional discoveryPath is omitted rather than guessed.
  skills: { mode: "native-dir" },
  // verified: 0.57.0 — native `gemini hooks` subcommand incl.
  // `hooks migrate` (from Claude Code), i.e. the Claude hook taxonomy.
  hooks: { mode: "native-taxonomy", dialectId: "gemini-hooks-json" },
  // verified: 0.57.0 — native `gemini mcp` management (add/remove/list/enable/
  // disable), config in `~/.gemini/settings.json`.
  mcp: { configFormatId: "gemini-settings-json" },
  // verified: 0.57.0 — vendor-specific GEMINI.md (CLAUDE.md-style instruction
  // file; the hooks projection writes under `.gemini/`).
  instructionFile: {
    name: "GEMINI.md",
    placement: "project-root",
    semantics: "CLAUDE.md",
  },
  // verified: 0.57.0 — `--acp` "Starts the agent in ACP mode"; gemini is an ACP
  // server (the HAL generic-driver base, epic #3117 D1), not a client.
  acp: { server: "native", client: "absent" },
  // verified: 0.57.0 — `-p/--prompt` runs non-interactively; `-o/--output-format`
  // choices are text | json | stream-json (the survey missed stream-json).
  headlessExec: {
    modes: ["prompt"],
    outputFormats: ["text", "json", "stream-json"],
  },
  // verified: 0.57.0 — no subagent primitive in `gemini --help`.
  subagents: "absent",
  // verified: Hapimatic tmux-persistence gate excludes gemini (sessionSpawner.ts:898).
  sessionPersistence: { tmuxSafe: false },
  // verified: sessionSpawner.ts:1552 — session roles are claude-only.
  sessionRoles: "absent",
  // verified: sessionSpawner.ts:1558 — output styles are claude-only.
  outputStyles: "absent",
  // verified: 0.57.0 — `-s/--sandbox` "Run in sandbox?" (Docker/Podman).
  sandboxing: "native",
  // survey: gemini natively selects models via `-m/--model` (native catalog);
  // Hapimatic surfaces no gemini model picker today, so a switch is a relaunch.
  modelSelection: {
    catalogSources: [{ source: "native-catalog", catalogId: "gemini-native" }],
    switchSemantics: "relaunch",
  },
  // verified (#3350 Task 1, 2026-09-21): gemini's native `--approval-mode`
  // choices (default/auto_edit/yolo/plan, from `gemini --help` 0.57.0) are
  // spawn-set only — Hapimatic exposes no in-session gemini mode switcher
  // (getPermissionModesForFlavor("gemini") === []). The pivotal behavioral
  // verdict is now RESOLVED: under Hapimatic's ACP driver (`gemini
  // --experimental-acp [--yolo]`, text-only client capabilities), `--yolo`
  // produces an OBSERVABLE, REPRODUCIBLE difference — default mode gates file
  // edits behind an ACP `session/request_permission` (kind `edit`), `--yolo`
  // auto-approves them (no request); trivial shell (`echo`) auto-approves in
  // both. So the {default, YOLO} spawn pair is REAL, not a placebo (provenance
  // upgraded survey -> verified). Only `default` and `yolo` are wire-distinct on
  // the spawn `yolo` bool; `auto_edit`/`plan` collapse to the default posture and
  // are not in-session switchable, so the honest picker surfaces only {default,
  // YOLO} (see getSpawnPermissionModeOptionsForFlavor). Evidence in the issue body.
  permissionModes: {
    modes: [
      { id: "default", applicability: "spawn" },
      { id: "auto_edit", applicability: "spawn" },
      { id: "yolo", applicability: "spawn" },
      { id: "plan", applicability: "spawn" },
    ],
  },
  // verified (#3352 Task 1, gemini-cli 0.57.0): per-turn input/output tokens ride
  // the `session/prompt` RESPONSE `_meta.quota.token_count.{input_tokens,
  // output_tokens}` (model id via `_meta.quota.model_usage[].model`); context-
  // window occupancy rides a `session/update` of kind `usage_update` ({size,
  // used}). NO cache read/write split is emitted (R4 — absent, not fabricated).
  usageReporting: {
    mode: "native",
    granularity: "per-turn",
    cacheSplit: false,
    contextWindow: true,
    note: "gemini-cli 0.57.0: per-turn in/out via prompt-response _meta.quota.token_count; context via session/update usage_update {size,used}; no cache split.",
  },
  // survey (Ruling D5): "inherited" — Hapimatic delivers NO gemini credential
  // today (the spawner has no gemini auth branch); the harness inherits whatever
  // auth the host environment already holds.
  authBinding: { kinds: ["inherited"] },
  // verified: Tier-0 delivered as a leading text block on the FIRST ACP turn
  // (runAgentSession), once per session (R6) — a user-turn injection that lands
  // in transcript history and does NOT survive a transcript trim; disabled by
  // HAPI_CAPABILITY_TIER0=0 (R8).
  capabilityInjection: {
    mode: "first-turn-prompt",
    verifiedOn: "runAgentSession first-turn Tier-0 test (issue #3748)",
  },
  // #3811: gemini runs through the generic ACP runner, whose ACP session id is
  // persisted into metadata.acpSessionId (runAgentSession.ts). Modal → "Gemini ID".
  nativeSessionId: {
    mode: "native",
    field: "acpSessionId",
    label: "Gemini",
    description: "Gemini ACP session ID",
  },
  // Host-jail axis (issue #3813). DECLARED BUT INERT: gemini rides the direct-spawn
  // path (sessionPersistence.tmuxSafe === false), which the jail never wraps, so
  // `harnessEgressHosts()` deliberately EXCLUDES these hosts from the node-wide
  // allowlist until the direct-spawn path is sandboxed (drop that gate then). Data
  // only. (Add `cloudcode-pa.googleapis.com` for the Google-login Code-Assist path
  // when gemini is jailed.)
  hostJail: {
    mode: "native",
    reexposeHomeDirs: [".gemini"],
    egressHosts: [
      "generativelanguage.googleapis.com",
      "oauth2.googleapis.com",
      "accounts.google.com",
    ],
    keepSecrets: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
};
