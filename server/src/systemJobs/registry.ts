// SPDX-License-Identifier: AGPL-3.0-only
import {
  validateSystemJobsRegistry,
  type SystemJobsRegistry,
} from "@hapi/protocol";

/**
 * System-jobs registry manifest — the committed SINGLE SOURCE OF TRUTH for
 * OS-level scheduled jobs (issue #1535, epic #1534).
 *
 * The FOUNDATION (Sub-Issue A) uses a committed const. Runtime read/write
 * mutability (the UI editing the registry) is Sub-Issue B's (#1536)
 * responsibility — this issue deliberately does NOT build mutation
 * infrastructure it doesn't require.
 *
 * First registrant: `claude-token-logger` — migrated from the live
 * ~/.config/systemd/user/claude-token-logger.{timer,service} (daily Claude
 * token-usage aggregation) to prove the registry → reconciler → live-timer
 * round-trip end to end.
 *
 * The `node` field holds the federation nodeId the entry targets. Multiple
 * Hapimatic instances share one host's ~/.config/systemd/user/, so the
 * reconciler's node-scoped managed-marker keeps each node's jobs isolated.
 */
const rawRegistry = [
  {
    name: "claude-token-logger",
    description:
      "Daily Claude token-usage aggregation — upsert daily token totals from session transcripts to ~/.claude/metrics/ (survives transcript purge; charting + diagnostics signal)",
    // systemd OnCalendar expression: daily at 04:30 (matches the live unit).
    schedule: "*-*-* 04:30:00",
    command: "/usr/bin/python3 %h/.claude/scripts/token-usage-extractor.py",
    enabled: true,
    logPath: null,
    // Federation nodeId of the prod hub, where this job currently runs. The
    // standalone runner's --node flag retargets for worktree/dev testing.
    node: "rp1-prod",
  },
];

// Validate at module load. Compile-time typing already enforces the shape; this
// is belt-and-suspenders against hand-edits that bypass the type checker.
const result = validateSystemJobsRegistry(rawRegistry);
if (!result.ok) {
  throw new Error(`system-jobs registry is invalid: ${result.error}`);
}

export const systemJobsRegistry: SystemJobsRegistry = result.registry;
