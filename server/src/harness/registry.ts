// SPDX-License-Identifier: AGPL-3.0-only
import {
  validateHarnessRegistry,
  type HarnessRegistry,
  type HarnessDescriptor,
  type RedactedHarnessDescriptor,
} from "@hapi/protocol";

/**
 * Harness self-update registry — the committed SINGLE SOURCE OF TRUTH for the
 * LLM-harnesses Hapimatic can detect + update (issue #1770, epic #1769).
 *
 * Code-defined and NOT user-editable by design: every descriptor carries
 * PRIVILEGED shell command templates (`detect.cmd`, per-flavor `update`/
 * `rollback`). The web never sees them — routes serve
 * `toRedactedHarnessDescriptor(...)` (R6). This mirrors the `systemJobs`
 * committed-const registry (epic #1534): a plain array validated at module load
 * (belt-and-suspenders against a hand-edit that bypasses the type checker).
 *
 * Entry 0 is Claude Code — the session backend. The `install_flavors` command
 * strings are TEMPLATES: sub-issue #1774 detects the active flavor
 * (`detectInstallFlavor`), substitutes `{version}`/`{prior_version}` into the
 * matching flavor's template, and EXECUTES it. Sub A only STORES the templates
 * and exposes detection — it never runs an update/rollback.
 */
const rawRegistry = [
  {
    id: "claude-code",
    display_name: "Claude Code",
    is_session_backend: true,
    // `claude --version` prints e.g. `2.1.207 (Claude Code)`; the regex pulls
    // the leading semver. Only the regex string changes if the format shifts.
    detect: { cmd: "claude --version", version_regex: "(\\d+\\.\\d+\\.\\d+)" },
    latest_source: { type: "npm", ref: "@anthropic-ai/claude-code" },
    changelog: {
      type: "github_markdown",
      url: "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md",
    },
    // Per-flavor update/rollback TEMPLATES. The fleet's real hosts are NATIVE
    // installs (`~/.local/bin/claude` → `~/.local/share/claude/versions/<v>`),
    // which is why a single hard-coded npm command would be a silent no-op there.
    install_flavors: {
      npm: {
        update: { cmd: "npm install -g @anthropic-ai/claude-code@{version}" },
        rollback: {
          cmd: "npm install -g @anthropic-ai/claude-code@{prior_version}",
        },
      },
      native: {
        update: { cmd: "claude install {version}" },
        rollback: { cmd: "claude install {prior_version}" },
      },
    },
    // The areas a Claude Code upgrade can silently break — #1772's analysis
    // pass inspects these; #1774 surfaces them at apply time.
    coupling_watch_areas: [
      "launcher/PTY",
      "SDK control protocol",
      "billing",
      "hook API",
      "MCP",
      "CLI flags",
    ],
    analysis_repos: ["hapimatic-private"],
  },
  // ── HAL stock-flavor CLIs (issue #3313, epic #3345) ──────────────────────
  // The remaining stock agent flavors (`codex`/`gemini`/`opencode`) alongside
  // `claude-code` above. Added so the existing poll → upsertDetectionState →
  // getDetectionState path detects + persists their INSTALLED versions, which
  // the extensions page (`GET /api/extension-registry` → `toSummary`) surfaces
  // as `probedVersion` instead of the flat wrapper manifest `0.1.0` (ruling
  // D4(a)). They are NOT session backends (only `claude-code` is), so detection
  // resolves the binary via PATH / well-known locations, never the configured
  // claudePath. `install_flavors` is REQUIRED by the schema (both npm + native):
  // these are npm-distributed CLIs with no separate vendor native installer, and
  // `detectInstallFlavor` classifies an npm/nvm-global install as "npm", so the
  // never-selected `native` slot reuses the correct npm command rather than an
  // invented one. `coupling_watch_areas` / `analysis_repos` are empty: no #1772
  // coupling analysis is defined for these flavors (honest, schema-valid).
  {
    id: "codex",
    display_name: "Codex",
    is_session_backend: false,
    // `codex --version` prints e.g. `codex-cli 0.147.0`; the regex pulls the
    // leading semver from the line.
    detect: { cmd: "codex --version", version_regex: "(\\d+\\.\\d+\\.\\d+)" },
    latest_source: { type: "npm", ref: "@openai/codex" },
    changelog: {
      type: "github_markdown",
      url: "https://raw.githubusercontent.com/openai/codex/main/CHANGELOG.md",
    },
    install_flavors: {
      npm: {
        update: { cmd: "npm install -g @openai/codex@{version}" },
        rollback: { cmd: "npm install -g @openai/codex@{prior_version}" },
      },
      // npm-distributed: the never-selected native slot reuses the npm command.
      native: {
        update: { cmd: "npm install -g @openai/codex@{version}" },
        rollback: { cmd: "npm install -g @openai/codex@{prior_version}" },
      },
    },
    coupling_watch_areas: [],
    analysis_repos: [],
  },
  {
    id: "gemini",
    display_name: "Gemini CLI",
    is_session_backend: false,
    // `gemini --version` prints e.g. `0.57.0`.
    detect: { cmd: "gemini --version", version_regex: "(\\d+\\.\\d+\\.\\d+)" },
    latest_source: { type: "npm", ref: "@google/gemini-cli" },
    changelog: {
      type: "github_markdown",
      url: "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/CHANGELOG.md",
    },
    install_flavors: {
      npm: {
        update: { cmd: "npm install -g @google/gemini-cli@{version}" },
        rollback: { cmd: "npm install -g @google/gemini-cli@{prior_version}" },
      },
      native: {
        update: { cmd: "npm install -g @google/gemini-cli@{version}" },
        rollback: { cmd: "npm install -g @google/gemini-cli@{prior_version}" },
      },
    },
    coupling_watch_areas: [],
    analysis_repos: [],
  },
  {
    id: "opencode",
    display_name: "opencode",
    is_session_backend: false,
    // `opencode --version` prints e.g. `1.17.11`.
    detect: {
      cmd: "opencode --version",
      version_regex: "(\\d+\\.\\d+\\.\\d+)",
    },
    latest_source: { type: "npm", ref: "opencode-ai" },
    changelog: {
      type: "github_markdown",
      url: "https://raw.githubusercontent.com/sst/opencode/dev/CHANGELOG.md",
    },
    install_flavors: {
      npm: {
        update: { cmd: "npm install -g opencode-ai@{version}" },
        rollback: { cmd: "npm install -g opencode-ai@{prior_version}" },
      },
      native: {
        update: { cmd: "npm install -g opencode-ai@{version}" },
        rollback: { cmd: "npm install -g opencode-ai@{prior_version}" },
      },
    },
    coupling_watch_areas: [],
    analysis_repos: [],
  },
];

// Validate at module load. Compile-time typing already enforces the shape; this
// is belt-and-suspenders against a hand-edit that bypasses the type checker.
const result = validateHarnessRegistry(rawRegistry);
if (!result.ok) {
  throw new Error(`harness registry is invalid: ${result.error}`);
}

export const harnessRegistry: HarnessRegistry = result.registry;

/**
 * Project a full `HarnessDescriptor` to its web-safe redacted view. Built
 * FIELD-BY-FIELD (NEVER `{...d}`) so the privileged command templates
 * (`detect`, `install_flavors`) cannot leak — adding a new command field to the
 * descriptor can never accidentally surface it here (mirrors `toRedactedAccount`).
 */
export function toRedactedHarnessDescriptor(
  d: HarnessDescriptor
): RedactedHarnessDescriptor {
  return {
    id: d.id,
    display_name: d.display_name,
    is_session_backend: d.is_session_backend,
    latest_source: d.latest_source,
    changelog: d.changelog,
    coupling_watch_areas: d.coupling_watch_areas,
    analysis_repos: d.analysis_repos,
  };
}
