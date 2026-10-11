// SPDX-License-Identifier: MIT
import { forceRefreshDaemonAccount } from "@/daemon/controlClient";
import type { ForceRefreshReport } from "@/modules/common/rpcTypes";
import {
  sweepLegacyConfigDirs,
  type LegacySweepResult,
} from "@/accounts/legacyConfigDirMigration";
import { configuration } from "@/configuration";
import type { CommandDefinition } from "./types";

/** Canonical UUID format — mirrors accountStore's UUID_REGEX (path-safety parity). */
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface ParsedFlags {
  json: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  return { json: args.includes("--json") || args.includes("-j") };
}

function printHelp(isError: boolean): number {
  const out = isError ? console.error : console.log;
  out("Usage:");
  out("  hapi accounts force-refresh <account-uuid> [--json]");
  out("  hapi accounts chain-probe <account-uuid> [--json]");
  out(
    "  hapi accounts migrate-config-dirs [--dry-run] [--delete-legacy] [--json]"
  );
  out("");
  out("Subcommands:");
  out(
    "  force-refresh <uuid>      Force one immediate OAuth token refresh for the"
  );
  out(
    "                            account and assert the full refresh → restart chain"
  );
  out("  chain-probe <uuid>        Read-only: each node's refresh-token chain");
  out(
    "                            fingerprint (a hash) + independence verdict (#3784)"
  );
  out(
    "  migrate-config-dirs       Migrate legacy per-instance isolated account dirs"
  );
  out(
    "                            into the machine-global SHARED dir (#1643). Lazy"
  );
  out(
    "                            per-spawn migration also runs automatically; this"
  );
  out(
    "                            sweeps ALL store accounts at once and reports the"
  );
  out(
    "                            glob-retirement gate (legacy-remaining count)."
  );
  out("");
  out("Flags:");
  out(
    "  --json, -j                Emit a machine-readable JSON result (for CI)"
  );
  out(
    "  --dry-run, -n             (migrate-config-dirs) report would-migrate without writing"
  );
  out(
    "  --delete-legacy           (migrate-config-dirs) delete legacy dirs AFTER a"
  );
  out(
    "                            successful migrate. Run ONLY after ALL instances are"
  );
  out(
    "                            upgraded — deleting a sibling's in-use legacy dir"
  );
  out("                            mid-rolling-deployment is unsafe (OR-2).");
  return isError ? 2 : 0;
}

const STATUS_ICON: Record<string, string> = {
  pass: "✓",
  fail: "✗",
  skipped: "⊘",
};

const OVERALL_LABEL: Record<string, string> = {
  pass: "✅ PASS",
  fail: "❌ FAIL",
  deferred: "⏭️  DEFERRED (host-default — not refreshable by Hapimatic)",
  "not-found": "❓ NOT FOUND",
};

function printReportHuman(report: ForceRefreshReport): void {
  console.log("");
  console.log(`Force-refresh: ${report.accountUuid}`);
  if (report.emailAddress) {
    console.log(`Account:       ${report.emailAddress}`);
  }
  console.log(
    `Overall:       ${OVERALL_LABEL[report.overall] ?? report.overall}`
  );
  console.log(`Duration:      ${report.durationMs}ms`);
  console.log("");
  console.log("Steps:");
  for (const step of report.steps) {
    const icon = STATUS_ICON[step.status] ?? "?";
    console.log(`  ${icon} ${step.name}`);
    if (step.detail) {
      console.log(`      ${step.detail}`);
    }
  }
  if (report.warnings.length > 0) {
    console.log("");
    console.log("⚠️  Warnings:");
    for (const w of report.warnings) {
      console.log(`  - ${w}`);
    }
  }
  console.log("");
}

/** Map the report's overall verdict to a process exit code. */
function exitCodeForReport(report: ForceRefreshReport): number {
  return report.overall === "pass" || report.overall === "deferred" ? 0 : 1;
}

async function runForceRefresh(
  uuid: string | undefined,
  flags: ParsedFlags
): Promise<number> {
  if (!uuid) {
    console.error("Error: missing <account-uuid>.");
    console.error("Usage: hapi accounts force-refresh <account-uuid> [--json]");
    return 2;
  }
  if (!UUID_REGEX.test(uuid)) {
    console.error(`Error: '${uuid}' is not a canonical UUID.`);
    return 2;
  }

  const result = await forceRefreshDaemonAccount(uuid);

  // daemonPost returns `{ error }` when no daemon is running / reachable (R7).
  if (typeof result.error === "string") {
    console.error("Error: could not reach the Hapimatic daemon.");
    console.error(`  ${result.error}`);
    console.error("");
    console.error(
      "The force-refresh harness runs INSIDE the daemon (it drives the live"
    );
    console.error(
      "TokenRefreshService + restartBoundSessions). Start the daemon, then retry:"
    );
    console.error("  hapi daemon start");
    console.error(
      "  (or `scripts/hapi-worktree.sh start` for a worktree instance)"
    );
    return 1;
  }

  const report = result as unknown as ForceRefreshReport;
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReportHuman(report);
  }
  return exitCodeForReport(report);
}

function printSweepHuman(result: LegacySweepResult): void {
  console.log("");
  console.log(
    `Migrate config dirs → machine-global SHARED (#1643)${result.dryRun ? " — DRY RUN, no changes written" : ""}:`
  );
  console.log(`  Accounts scanned:  ${result.total}`);
  if (result.dryRun) {
    const would = result.entries.filter(e => e.outcome === "would-migrate");
    console.log(`  Would migrate:     ${would.length}`);
    for (const e of would) console.log(`    • ${e.accountUuid}`);
  } else {
    console.log(`  Migrated:          ${result.migrated}`);
    console.log(`  No legacy dir:     ${result.none}`);
    console.log(`  Skipped/no-op:     ${result.skipped}`);
    if (result.deleteLegacy) {
      console.log("  (legacy dirs deleted after successful migration)");
    }
  }
  console.log(`  Legacy remaining:  ${result.legacyRemaining}`);
  if (result.legacyRemaining === 0 && !result.dryRun) {
    console.log("");
    console.log(
      "  ✅ Zero legacy dirs remain — a follow-up PR may retire the transitional"
    );
    console.log(
      "     ~/.hapimatic-* deferral scan in isIsolatedAccountAnywhere (#1643 KD-6)."
    );
  }
  console.log("");
}

async function runMigrateConfigDirs(args: string[]): Promise<number> {
  const json = args.includes("--json") || args.includes("-j");
  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const deleteLegacy = args.includes("--delete-legacy");
  try {
    const result = await sweepLegacyConfigDirs({ dryRun, deleteLegacy });
    if (json) console.log(JSON.stringify(result, null, 2));
    else printSweepHuman(result);
    return 0;
  } catch (err) {
    console.error(
      `Error: migrate-config-dirs sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }
}

/**
 * Issue #3784: READ-ONLY cross-node chain-probe. Reports, per federation node,
 * the sha256 refresh-token chain fingerprint for an account (a hash, never the
 * raw token) + the independence verdict for THIS node (independent / shared /
 * unknown). Never rotates or writes anything — the operator's tool to confirm
 * chains are independent and to detect a copy-collision.
 */
async function runChainProbe(
  uuid: string | undefined,
  flags: ParsedFlags
): Promise<number> {
  if (!uuid || !UUID_REGEX.test(uuid)) {
    console.error("Error: chain-probe needs a canonical <account-uuid>.");
    console.error("Usage: hapi accounts chain-probe <account-uuid> [--json]");
    return 2;
  }
  try {
    const authResp = await fetch(`${configuration.serverUrl}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: configuration.cliApiToken }),
    });
    if (!authResp.ok) throw new Error(`auth HTTP ${authResp.status}`);
    const { token } = (await authResp.json()) as { token?: string };
    if (!token) throw new Error("no JWT in /api/auth response");
    const resp = await fetch(
      `${configuration.serverUrl}/api/federation/account-chain-fingerprints?accountUuid=${encodeURIComponent(uuid)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) throw new Error(`chain-fingerprints HTTP ${resp.status}`);
    const body = (await resp.json()) as {
      fingerprints: Array<{
        nodeId: string;
        nodeLabel: string;
        self: boolean;
        fingerprint: string | null;
      }>;
      degraded: boolean;
    };
    const selfEntry = body.fingerprints.find(e => e.self);
    const others = body.fingerprints.filter(e => !e.self);
    const localFp = selfEntry?.fingerprint ?? null;
    const verdict: "independent" | "shared" | "unknown" = !localFp
      ? "unknown"
      : body.degraded
        ? "unknown"
        : others.some(e => e.fingerprint && e.fingerprint === localFp)
          ? "shared"
          : "independent";
    if (flags.json) {
      console.log(
        JSON.stringify({ accountUuid: uuid, verdict, ...body }, null, 2)
      );
      return 0;
    }
    console.log("");
    console.log(`Chain-probe ${uuid}:`);
    for (const e of body.fingerprints) {
      const fp = e.fingerprint ? `${e.fingerprint.slice(0, 16)}…` : "(none)";
      console.log(
        `  ${e.self ? "→ self " : "  peer "} ${e.nodeLabel.padEnd(16)} ${fp}`
      );
    }
    console.log(
      `  verdict: ${verdict}${body.degraded ? " (a peer was unreachable)" : ""}`
    );
    console.log("");
    return 0;
  } catch (err) {
    console.error(
      `Error: chain-probe failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }
}

export const accountsCommand: CommandDefinition = {
  name: "accounts",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    const sub = commandArgs[0];
    const rest = commandArgs.slice(1);
    let exit = 0;
    if (sub === "force-refresh") {
      exit = await runForceRefresh(rest[0], parseFlags(rest.slice(1)));
    } else if (sub === "chain-probe") {
      exit = await runChainProbe(rest[0], parseFlags(rest.slice(1)));
    } else if (sub === "migrate-config-dirs") {
      exit = await runMigrateConfigDirs(rest);
    } else if (sub === undefined || sub === "--help" || sub === "-h") {
      exit = printHelp(false);
    } else {
      console.error(`Error: unknown subcommand '${sub}'`);
      console.error("");
      exit = printHelp(true);
    }
    process.exit(exit);
  },
};
