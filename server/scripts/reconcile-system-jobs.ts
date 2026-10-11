#!/usr/bin/env bun
/**
 * Standalone system-jobs reconciler runner (issue #1535, epic #1534).
 *
 * Applies the committed registry manifest to the current node's systemd user
 * timers via the reconciler module — with NO web/API dependency. This is the
 * foundation step that Sub-Issue B's (#1536) API will invoke in-process.
 *
 * nodeId resolution (highest precedence first):
 *   1. --node <id>                       (explicit override)
 *   2. $FEDERATION_NODE_ID               (env, matches loadFederationConfig)
 *   3. settings.json .federation.nodeId  ($HAPI_HOME or ~/.hapimatic-private)
 *   4. "unknown"
 *
 * Usage:
 *   bun run server/scripts/reconcile-system-jobs.ts [--dry-run] [--node <id>] [--help]
 *
 * Options:
 *   --dry-run     Compute and print the plan; do NOT apply it.
 *   --node <id>   Target node id (overrides env + settings).
 *   --help        Show this help.
 *
 * Examples:
 *   bun run server/scripts/reconcile-system-jobs.ts --dry-run --node rp1-prod
 *   bun run server/scripts/reconcile-system-jobs.ts --node rp1-prod
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { getSettingsFile, readSettings } from "../src/config/settings";
import { systemJobsRegistry } from "../src/systemJobs/registry";
import {
  isEmptyPlan,
  reconcile,
  type ReconcilePlan,
} from "../src/systemJobs/reconciler";

function parseArgs(argv: string[]): {
  dryRun: boolean;
  node: string | null;
  help: boolean;
} {
  let dryRun = false;
  let node: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--node") {
      node = argv[i + 1] ?? null;
      i++;
    }
  }
  return { dryRun, node, help };
}

async function resolveNodeId(explicit: string | null): Promise<string> {
  if (explicit) return explicit;
  if (process.env.FEDERATION_NODE_ID) return process.env.FEDERATION_NODE_ID;
  const dataDir =
    process.env.HAPI_HOME ?? join(homedir(), ".hapimatic-private");
  const settings = await readSettings(getSettingsFile(dataDir));
  return settings?.federation?.nodeId ?? "unknown";
}

function printPlan(plan: ReconcilePlan, nodeId: string, dryRun: boolean): void {
  const mode = dryRun ? "DRY RUN (no changes applied)" : "APPLIED";
  console.log(`System-jobs reconcile — node=${nodeId} — ${mode}`);
  // Surface name conflicts BEFORE the empty-plan check (issue #1536): a
  // conflict-only plan is "empty" for applyPlan but still needs operator
  // visibility — these units were skipped to avoid clobbering a foreign unit.
  if (plan.conflicts.length > 0) {
    const conflicts = plan.conflicts
      .map(c => `${c.name} (${c.reason})`)
      .join(", ");
    console.log(`  conflicts: ${plan.conflicts.length} → ${conflicts}`);
  }
  if (isEmptyPlan(plan)) {
    console.log("  No changes — live state already matches the manifest.");
    return;
  }
  const writes = plan.writes.map(w => `${w.name}.timer`).join(", ") || "(none)";
  console.log(`  writes:   ${plan.writes.length} → ${writes}`);
  console.log(
    `  enables:  ${plan.enables.length} → ${plan.enables.join(", ") || "(none)"}`
  );
  console.log(
    `  disables: ${plan.disables.length} → ${plan.disables.join(", ") || "(none)"}`
  );
  console.log(
    `  prunes:   ${plan.prunes.length} → ${plan.prunes.join(", ") || "(none)"}`
  );
}

async function main(): Promise<void> {
  const { dryRun, node, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(
      [
        "Usage: bun run server/scripts/reconcile-system-jobs.ts [--dry-run] [--node <id>] [--help]",
        "",
        "  --dry-run     Compute and print the plan; do NOT apply it.",
        "  --node <id>   Target node id (overrides env + settings).",
        "  --help        Show this help.",
      ].join("\n")
    );
    return;
  }

  const nodeId = await resolveNodeId(node);
  const plan = reconcile(systemJobsRegistry, nodeId, { dryRun });
  printPlan(plan, nodeId, dryRun);
}

main().catch(err => {
  console.error("reconcile-system-jobs failed:", err);
  process.exit(1);
});
