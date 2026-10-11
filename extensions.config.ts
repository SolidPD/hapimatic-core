// extensions.config.ts — the enabled-extension registry (input to codegen).
//
// `scripts/generate-extension-registry.ts` reads this list and emits per-package
// `<pkg>/src/extensions.generated.ts` files. Each entry is a path relative to
// the repo root pointing at an extension DIRECTORY that contains a `manifest.ts`
// exporting a `HapiExtensionManifest` (`@hapi/protocol/ext`). Order is preserved
// verbatim in the generated output (determinism — see locked contract §5b).
//
// Governance (locked contract §9): this file is a 12-issue hotspot — every
// extension-migration sub-issue appends one line. Edits are APPEND-ONLY (never
// reorder or rewrite existing entries), and every worker must REBASE BEFORE
// EDITING to avoid clobbering parallel appends.
//
export const enabledExtensions: readonly string[] = [
  "server/src/extensions/notifications-push",
  "server/src/extensions/notifications-telegram",
  "cli/src/extensions/agent-codex",
  "cli/src/extensions/agent-gemini",
  // `builtin.scheduler` (#1274) ships as TWO directories sharing one logical id.
  // Each declares a single runtime entry point, and codegen filters by
  // `manifest.entryPoints[runtime]` — so the server directory lands only in
  // `server/src/extensions.generated.ts` and the web directory only in
  // `web/src/extensions.generated.ts`. Neither loader sees both, so the shared
  // id is not a duplicate registration, and the web bundle never imports server
  // code. Both resolve to the same `extension_prefs` row, so the two halves
  // enable and disable together.
  "server/src/extensions/scheduler",
  "web/src/extensions/scheduler",
  "server/src/extensions/watchdog",
  "web/src/extensions/tool-views",
  "server/src/extensions/git-rpc",
  "web/src/extensions/git-rpc",
  // `builtin.heartbeat` (#1275) — server + web halves sharing one id, mirroring
  // the scheduler. The SystemEventQueue it drains is core-owned, so heartbeat
  // may load after the scheduler here without the scheduler snapshotting null.
  "server/src/extensions/heartbeat",
  "web/src/extensions/heartbeat",
  "server/src/extensions/github-issues",
  // `builtin.telegram-miniapp` (#1283) — server + web halves sharing one id. The
  // server half validates Telegram Mini App init data for Telegram-launched
  // auth/bind requests; the web half detects the Telegram WebApp runtime.
  // `defaultEnabled: false` (niche distribution channel); the extension_prefs
  // seed (#1269) enables it on upgrade when a bot token is configured.
  "server/src/extensions/telegram-miniapp",
  "web/src/extensions/telegram-miniapp",
  // `builtin.error-log-viewer` (#1279) — web-only (no server half). The server-side
  // ErrorLogger + `/api/error-logs*` routes stay in core; only the `/error-logs` viewer
  // UI is the extension. `requiredAtBuild: true` keeps the route always-present (#1042).
  "web/src/extensions/error-log-viewer",
  // `builtin.analytics` (#1282) — web-only (no server half). The `/api/telemetry*`
  // routes, TelemetryStore, and TurnAnalyticsCounts stay in core; only the `/analytics`
  // dashboard UI (page + 11 panel components + query hooks) is the extension.
  // `requiredAtBuild: true` keeps the route always-present (#1042 links it from /admin).
  "web/src/extensions/analytics",
  // `builtin.extension-marketplace` (#1292, PR-2) — server + web halves sharing one id.
  // Server half: the `/api/ext/catalog` proxy + `/api/ext/install` route (approach A —
  // re-invokes the binary's own `hapi ext install`, Matt-signed-off). Web half: the
  // `/extensions` browse UX (static-imported by `router.tsx`). `requiredAtBuild: true`
  // (the static route is always present, so the extension stays enabled).
  "server/src/extensions/extension-marketplace",
  "web/src/extensions/extension-marketplace",
  "web/src/extensions/time-log",
  // HAL catalog CLI harnesses (#3120, epic #3117 Sub-D). Six `defaultEnabled: true` catalog
  // extensions whose metadata contributions register at load so the Extensions-page catalog
  // is browsable/installable before the CLI BINARY is present (the binary installs lazily via
  // the recipe, ruling D2). The catalog UI is folded into `builtin.extension-marketplace`
  // (ruling 1B-17 accepted alternative), so there is NO separate web entry here.
  "cli/src/extensions/harness-crush",
  "cli/src/extensions/harness-cursor",
  "cli/src/extensions/harness-cline",
  "cli/src/extensions/harness-grok",
  "cli/src/extensions/harness-pi",
  "cli/src/extensions/harness-kimi",
  // `builtin.voice-input` (#4707, epic #4706) — server-only. The mic button and the
  // Settings section are core web UI gated on `/api/voice/status` (404 → hidden).
  "server/src/extensions/voice-input",
];
