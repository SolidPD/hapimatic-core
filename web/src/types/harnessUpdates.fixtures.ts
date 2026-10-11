// SPDX-License-Identifier: AGPL-3.0-only
import type {
  HarnessStatusResponse,
  HarnessAnalysisResponse,
  ChangelogSpan,
  ImpactArtifact,
} from "@/types/harnessUpdates";

/**
 * Wire-shaped test fixtures for the harness-update panel (issue #1773). snake_case
 * keys + epoch-ms number timestamps, exactly as the merged backends emit them — no
 * camel fields anywhere. Reused by the component + page + hook tests.
 */

export const fixtureStatusResponse: HarnessStatusResponse = {
  node_id: "rp1-standalone",
  harnesses: [
    {
      descriptor: {
        id: "claude-code",
        display_name: "Claude Code",
        is_session_backend: true,
        latest_source: { type: "npm", ref: "@anthropic-ai/claude-code" },
        changelog: {
          type: "github_markdown",
          url: "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
        },
        coupling_watch_areas: ["hooks", "mcp", "permissions"],
        analysis_repos: ["MattStarfield/hapimatic-private"],
      },
      state: {
        node_id: "rp1-standalone",
        harness_id: "claude-code",
        installed_version: "1.2.0",
        latest_version: "1.4.0",
        prior_version: "1.1.0",
        update_available: true,
        last_checked_at: 1_750_000_000_000,
        last_error: null,
        last_error_at: null,
      },
    },
  ],
};

/** A harness that is already up to date (no update available). */
export const fixtureStatusUpToDate: HarnessStatusResponse = {
  node_id: "rp1-standalone",
  harnesses: [
    {
      descriptor: fixtureStatusResponse.harnesses[0].descriptor,
      state: {
        node_id: "rp1-standalone",
        harness_id: "claude-code",
        installed_version: "1.4.0",
        latest_version: "1.4.0",
        prior_version: "1.3.0",
        update_available: false,
        last_checked_at: 1_750_000_000_000,
        last_error: null,
        last_error_at: null,
      },
    },
  ],
};

export const fixtureChangelogSpan: ChangelogSpan = {
  available: true,
  harness_id: "claude-code",
  installed: "1.2.0",
  latest: "1.4.0",
  versions: [
    {
      version: "1.4.0",
      bullets: [
        "Added a new `--foo` flag to the CLI",
        "Fixed a hook dispatch race condition",
      ],
    },
    {
      version: "1.3.0",
      bullets: ["Improved MCP server reconnect behavior"],
    },
  ],
  truncated: false,
  drift_line_count: 0,
  changelog_url:
    "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
  reason: "ok",
};

/** A degraded changelog (no cached text yet) — still 200s, not an error. */
export const fixtureChangelogUnavailable: ChangelogSpan = {
  available: false,
  harness_id: "claude-code",
  installed: "1.2.0",
  latest: "1.4.0",
  versions: [],
  truncated: false,
  drift_line_count: 0,
  changelog_url:
    "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
  reason: "not-cached",
};

/** A representative artifact: all four colors, each impacted-issue direction. */
export const fixtureArtifact: ImpactArtifact = {
  from_version: "1.2.0",
  to_version: "1.4.0",
  node_id: "rp1-standalone",
  harness_id: "claude-code",
  repos_checked: ["MattStarfield/hapimatic-private"],
  analyzed_at: 1_750_000_500_000,
  prior_version_for_rollback: "1.2.0",
  contract_version: 1,
  headline: {
    overall_color: "orange",
    summary: "This update **helps** two workflows and touches your hook gates.",
    must_investigate: ["hook dispatch change may affect the workflow gate"],
    resolves_or_helps_issues: [
      {
        repo: "MattStarfield/hapimatic-private",
        number: 1538,
        direction: "positive",
        note: "improves system-jobs polling",
      },
    ],
    risks_issues: [
      {
        repo: "MattStarfield/hapimatic-private",
        number: 1065,
        direction: "negative",
        note: "hook race fix changes branch-content timing",
      },
    ],
    watch_areas_hit: ["hooks", "mcp"],
  },
  items: [
    {
      version: "1.4.0",
      bullet: "Added a new `--foo` flag to the CLI",
      category: "feature",
      color: "green",
      rationale: "A purely additive flag; no Hapimatic surface depends on it.",
      evidence: ["cli/src/args.ts:42"],
      impacted_issues: [
        {
          repo: "MattStarfield/hapimatic-private",
          number: 1538,
          direction: "positive",
          note: "improves system-jobs polling",
        },
      ],
    },
    {
      version: "1.4.0",
      bullet: "Fixed a hook dispatch race condition",
      category: "bugfix",
      color: "orange",
      rationale:
        "Changes hook timing — verify the workflow-label-gate ordering.",
      evidence: ["#1065", "server/src/hooks/dispatch.ts:88"],
      impacted_issues: [
        {
          repo: "MattStarfield/hapimatic-private",
          number: 1065,
          direction: "negative",
          note: "hook race fix changes branch-content timing",
        },
      ],
    },
    {
      version: "1.3.0",
      bullet: "Improved MCP server reconnect behavior",
      category: "improvement",
      color: "gray",
      rationale: "No Hapimatic impact — internal MCP client behavior.",
      evidence: [],
      impacted_issues: [
        {
          repo: "MattStarfield/hapimatic-private",
          number: 1077,
          direction: "neutral",
          note: "unrelated MCP toggle path",
        },
      ],
    },
    {
      version: "1.4.0",
      bullet: "Removed the deprecated `--legacy-mode` flag",
      category: "breaking",
      color: "red",
      rationale:
        "A removed flag — investigate whether any spawn path passed it.",
      evidence: ["cli/src/daemon/spawn.ts:210"],
      impacted_issues: [
        {
          repo: "MattStarfield/hapimatic-private",
          number: 1633,
          direction: "negative",
          note: "safe-mode spawn used a legacy flag",
        },
      ],
    },
  ],
};

export const fixtureAnalysisReady: HarnessAnalysisResponse = {
  status: "ready",
  artifact: fixtureArtifact,
  companion_session_id: "hapi-analysis-1773",
  analyzed_at: 1_750_000_500_000,
};

export const fixtureAnalysisAnalyzing: HarnessAnalysisResponse = {
  status: "analyzing",
};

export const fixtureAnalysisAtCapacity: HarnessAnalysisResponse = {
  status: "at_capacity",
};

export const fixtureAnalysisFailed: HarnessAnalysisResponse = {
  status: "failed",
};

export const fixtureAnalysisNone: HarnessAnalysisResponse = {
  status: "none",
};
