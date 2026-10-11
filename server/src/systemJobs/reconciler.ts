// SPDX-License-Identifier: AGPL-3.0-only
/**
 * System-jobs reconciler — idempotently applies a declarative job manifest to
 * systemd user timers (issue #1535, epic #1534).
 *
 * The registry (shared/src/systemJobs.ts schema) is the SINGLE SOURCE OF TRUTH;
 * this module reads the desired state and applies it to the OS. Applying twice
 * produces NO change (idempotent).
 *
 * Architecture (pure core + thin I/O shell — mirrors cli/src/daemon/systemdInvariants.ts):
 *   - PURE:   renderTimerUnit / renderServiceUnit / parseUnitMarker / planReconciliation
 *             — no I/O, fully unit-testable, deterministic (byte-stable rendering).
 *   - IMPURE: readCurrentState / applyPlan / reconcile — execFileSync(systemctl) + fs.
 *
 * The idempotency acceptance criterion is proven WITHOUT mutating the host by
 * testing planReconciliation(desired, stateMatchingDesired) === empty plan.
 *
 * Safety invariant (node-scoped managed marker): prod/dev/worktree instances all
 * run as the same user on one host and SHARE ~/.config/systemd/user/. Every unit
 * this module writes carries a `# HAPImatic-managed: <nodeId>` marker comment.
 * readCurrentState keeps ONLY units whose marker node matches the current node,
 * so prune NEVER touches unmanaged units (e.g. lsp-reaper.timer) or another
 * instance's managed units.
 *
 * Crontab fallback is DOCUMENTED, not implemented here — see
 * claudedocs/system-jobs-reconciler.md. systemd user timers are preferred.
 *
 * Standalone-invocable via server/scripts/reconcile-system-jobs.ts (the
 * foundation that Sub-Issue B's #1536 API will invoke in-process).
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SystemJob } from "@hapi/protocol";

export const MANAGED_MARKER_PREFIX = "# HAPImatic-managed:";
export const JOB_MARKER_PREFIX = "# HAPImatic-job:";

/** Default systemd user-unit directory. Injectable for tests. */
export function defaultUnitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

// ─── Pure: unit rendering ────────────────────────────────────

/**
 * Render the `.service` unit content for a job. Deterministic (byte-stable) —
 * the reconciliation plan compares this output against on-disk content.
 */
export function renderServiceUnit(job: SystemJob): string {
  const output =
    job.logPath === null
      ? "StandardOutput=journal\nStandardError=journal"
      : `StandardOutput=append:${job.logPath}\nStandardError=append:${job.logPath}`;
  return (
    `${MANAGED_MARKER_PREFIX} ${job.node}\n` +
    `${JOB_MARKER_PREFIX} ${job.name}\n` +
    `[Unit]\n` +
    `Description=${job.description}\n` +
    `After=network.target\n` +
    `\n` +
    `[Service]\n` +
    `Type=oneshot\n` +
    `ExecStart=${job.command}\n` +
    `Nice=10\n` +
    `${output}\n`
  );
}

/**
 * Render the `.timer` unit content for a job. Deterministic (byte-stable).
 * Non-configurable boilerplate (Persistent, RandomizedDelaySec, WantedBy) is a
 * reconciler default — the manifest's seven-field contract stays minimal.
 */
export function renderTimerUnit(job: SystemJob): string {
  return (
    `${MANAGED_MARKER_PREFIX} ${job.node}\n` +
    `${JOB_MARKER_PREFIX} ${job.name}\n` +
    `[Unit]\n` +
    `Description=${job.description} (timer)\n` +
    `\n` +
    `[Timer]\n` +
    `OnCalendar=${job.schedule}\n` +
    `Persistent=true\n` +
    `RandomizedDelaySec=300\n` +
    `\n` +
    `[Install]\n` +
    `WantedBy=timers.target\n`
  );
}

/**
 * Parse the Hapimatic-managed marker comments from a unit file's content.
 * Returns `{node: null, job: null}` for an unmanaged (non-Hapimatic) unit.
 */
export function parseUnitMarker(content: string): {
  node: string | null;
  job: string | null;
} {
  let node: string | null = null;
  let job: string | null = null;
  // First-match-wins (issue #1536 D7, finding 1539-14): a unit whose content
  // carries TWO `# HAPImatic-managed:` lines (e.g. injected via a newline in a
  // pre-#1536 `node` value, or a hand-crafted on-disk file) must NOT let the
  // SECOND line reassign ownership — that is the cross-node-prune spoof vector.
  // We lock each marker to the FIRST line we encounter (even if it is empty),
  // so a later line cannot overwrite it.
  let nodeSeen = false;
  let jobSeen = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(MANAGED_MARKER_PREFIX)) {
      if (!nodeSeen) {
        nodeSeen = true;
        node = trimmed.slice(MANAGED_MARKER_PREFIX.length).trim() || null;
      }
    } else if (trimmed.startsWith(JOB_MARKER_PREFIX)) {
      if (!jobSeen) {
        jobSeen = true;
        job = trimmed.slice(JOB_MARKER_PREFIX.length).trim() || null;
      }
    }
    // Stop scanning once we leave the leading comment/marker region.
    if (trimmed.startsWith("[")) break;
  }
  return { node, job };
}

// ─── Pure: reconciliation planning ───────────────────────────

/** Live state of a single managed unit on disk + in systemd. */
export interface CurrentUnitState {
  name: string;
  node: string | null;
  timerContent: string;
  serviceContent: string;
  enabled: boolean;
  active: boolean;
}

/** A reconciliation plan — what applyPlan must do to converge live → desired. */
export interface ReconcilePlan {
  writes: Array<{ name: string; timerContent: string; serviceContent: string }>;
  enables: string[];
  disables: string[];
  prunes: string[];
  /**
   * Name collisions with units this node does NOT own (issue #1536 D7, finding
   * 1539-14): a desired ENABLED job whose `<name>.timer` already exists on disk
   * as an UNMANAGED unit (e.g. a hand-authored `lsp-reaper.timer`) or as ANOTHER
   * node's managed unit. applyPlan refuses to overwrite these — the mutation
   * surfaces them as `code:"name_conflict"` instead of clobbering a foreign unit.
   */
  conflicts: Array<{ name: string; reason: "unmanaged" | "other-node" }>;
  daemonReloadNeeded: boolean;
}

/**
 * True when the plan is a no-op (the idempotency proof point). `conflicts` are
 * deliberately EXCLUDED (issue #1536): a conflict means "do nothing to that
 * unit", so a conflict-only plan is still empty from applyPlan's perspective —
 * there is nothing to apply. The conflict is surfaced separately by the caller.
 */
export function isEmptyPlan(plan: ReconcilePlan): boolean {
  return (
    plan.writes.length === 0 &&
    plan.enables.length === 0 &&
    plan.disables.length === 0 &&
    plan.prunes.length === 0
  );
}

/**
 * Compute the reconciliation plan from desired (manifest, already filtered to
 * the current node) and current (managed-for-this-node live state). PURE — no
 * I/O. An unchanged desired+current pair yields an empty plan (idempotency).
 */
export function planReconciliation(
  desired: SystemJob[],
  current: CurrentUnitState[],
  foreignUnits: Array<{ name: string; node: string | null }> = []
): ReconcilePlan {
  const plan: ReconcilePlan = {
    writes: [],
    enables: [],
    disables: [],
    prunes: [],
    conflicts: [],
    daemonReloadNeeded: false,
  };

  const currentByName = new Map(current.map(c => [c.name, c]));
  // Units on disk that this node does NOT own (unmanaged or another node's),
  // keyed by base name. A desired job whose name collides with one of these
  // must NOT be written — it would clobber a foreign unit (issue #1536 D7).
  const foreignByName = new Map(foreignUnits.map(f => [f.name, f.node]));
  const desiredEnabled = new Map<string, SystemJob>();
  const desiredDisabledNames = new Set<string>();
  for (const job of desired) {
    if (job.enabled) desiredEnabled.set(job.name, job);
    else desiredDisabledNames.add(job.name);
  }

  // Desired ENABLED jobs: write when content differs/absent; enable when not active.
  for (const [name, job] of desiredEnabled) {
    // Conflict check FIRST (issue #1536 R5): if the unit name collides with a
    // foreign on-disk unit, record a conflict and skip write+enable entirely —
    // never overwrite a unit we do not own.
    if (foreignByName.has(name)) {
      const fnode = foreignByName.get(name) ?? null;
      plan.conflicts.push({
        name,
        reason: fnode === null ? "unmanaged" : "other-node",
      });
      continue;
    }
    const timerContent = renderTimerUnit(job);
    const serviceContent = renderServiceUnit(job);
    const cur = currentByName.get(name);
    if (
      !cur ||
      cur.timerContent !== timerContent ||
      cur.serviceContent !== serviceContent
    ) {
      plan.writes.push({ name, timerContent, serviceContent });
      plan.daemonReloadNeeded = true;
    }
    if (!cur || !cur.enabled || !cur.active) {
      plan.enables.push(name);
    }
  }

  // Desired DISABLED jobs that are currently present: disable + prune.
  for (const name of desiredDisabledNames) {
    if (currentByName.has(name)) {
      plan.disables.push(name);
      plan.prunes.push(name);
      plan.daemonReloadNeeded = true;
    }
  }

  // Managed units no longer in the manifest at all: disable (if live) + prune.
  for (const cur of current) {
    if (desiredEnabled.has(cur.name) || desiredDisabledNames.has(cur.name)) {
      continue;
    }
    if (cur.enabled || cur.active) plan.disables.push(cur.name);
    plan.prunes.push(cur.name);
    plan.daemonReloadNeeded = true;
  }

  return plan;
}

// ─── Impure: systemctl + filesystem I/O ──────────────────────

/**
 * True when this host can manage systemd user units. Graceful-degradation guard
 * (R7) — mirrors systemdInvariants.ts: non-Linux or no `systemctl` ⇒ no-op.
 */
export function systemctlAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("systemctl", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function systemctlQuery(args: string[]): string {
  try {
    return execFileSync("systemctl", args, { encoding: "utf8" }).trim();
  } catch (e) {
    const err = e as { stdout?: Buffer | string };
    return (err.stdout?.toString() ?? "").trim();
  }
}

/**
 * Read the live state of all Hapimatic-managed units for the given node.
 * Returns [] gracefully on non-Linux / missing systemctl / missing unit dir.
 */
export function readCurrentState(
  nodeId: string,
  unitDir: string = defaultUnitDir()
): CurrentUnitState[] {
  if (!systemctlAvailable()) return [];
  if (!existsSync(unitDir)) return [];

  const result: CurrentUnitState[] = [];
  for (const file of readdirSync(unitDir)) {
    if (!file.endsWith(".timer")) continue;
    const timerPath = join(unitDir, file);
    let timerContent: string;
    try {
      timerContent = readFileSync(timerPath, "utf8");
    } catch {
      continue;
    }
    const marker = parseUnitMarker(timerContent);
    if (marker.node !== nodeId) continue; // only this node's managed units

    const name = file.slice(0, -".timer".length);
    const servicePath = join(unitDir, `${name}.service`);
    let serviceContent = "";
    if (existsSync(servicePath)) {
      try {
        serviceContent = readFileSync(servicePath, "utf8");
      } catch {
        serviceContent = "";
      }
    }
    const enabled =
      systemctlQuery(["--user", "is-enabled", file]) === "enabled";
    const active = systemctlQuery(["--user", "is-active", file]) === "active";

    result.push({
      name,
      node: marker.node,
      timerContent,
      serviceContent,
      enabled,
      active,
    });
  }
  return result;
}

/**
 * Scan the unit directory for `.timer` files this node does NOT own — i.e.
 * unmanaged units (no Hapimatic marker) or units managed by ANOTHER node. Used
 * for collision detection (issue #1536 R5): a desired job must never overwrite
 * one of these. Returns `{name, node}` per foreign unit (`node === null` ⇒
 * unmanaged). Pure-ish (filesystem read only); deliberately NOT gated on
 * `systemctlAvailable()` so the collision check works against a test `unitDir`
 * fixture on any platform.
 */
export function readForeignUnits(
  nodeId: string,
  unitDir: string = defaultUnitDir()
): Array<{ name: string; node: string | null }> {
  if (!existsSync(unitDir)) return [];
  const result: Array<{ name: string; node: string | null }> = [];
  for (const file of readdirSync(unitDir)) {
    if (!file.endsWith(".timer")) continue;
    let content: string;
    try {
      content = readFileSync(join(unitDir, file), "utf8");
    } catch {
      continue;
    }
    const marker = parseUnitMarker(content);
    if (marker.node === nodeId) continue; // this node's own unit — not foreign
    result.push({ name: file.slice(0, -".timer".length), node: marker.node });
  }
  return result;
}

/**
 * Apply a reconciliation plan to the host. Order: disable → prune files →
 * write files → daemon-reload → enable. Disable is best-effort (a unit that is
 * already disabled exits non-zero — not an error for our purposes).
 */
export function applyPlan(
  plan: ReconcilePlan,
  unitDir: string = defaultUnitDir()
): void {
  if (!systemctlAvailable()) return; // graceful no-op (R7)
  if (isEmptyPlan(plan)) return;

  // Defense-in-depth (issue #1536 R5): never touch a unit recorded as a
  // conflict. planReconciliation already excludes conflicts from writes/enables,
  // but this guard guarantees applyPlan can never clobber a foreign unit even if
  // a future caller hand-builds a plan.
  const conflictNames = new Set(plan.conflicts.map(c => c.name));

  mkdirSync(unitDir, { recursive: true });

  for (const name of plan.disables) {
    try {
      execFileSync(
        "systemctl",
        ["--user", "disable", "--now", `${name}.timer`],
        {
          stdio: "pipe",
        }
      );
    } catch {
      // best-effort: already disabled / not loaded
    }
  }

  for (const name of plan.prunes) {
    rmSync(join(unitDir, `${name}.timer`), { force: true });
    rmSync(join(unitDir, `${name}.service`), { force: true });
  }

  for (const w of plan.writes) {
    if (conflictNames.has(w.name)) continue; // never clobber a foreign unit (R5)
    writeFileSync(join(unitDir, `${w.name}.timer`), w.timerContent);
    writeFileSync(join(unitDir, `${w.name}.service`), w.serviceContent);
  }

  if (plan.daemonReloadNeeded) {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
  }

  for (const name of plan.enables) {
    if (conflictNames.has(name)) continue; // never enable a foreign unit (R5)
    execFileSync("systemctl", ["--user", "enable", "--now", `${name}.timer`], {
      stdio: "pipe",
    });
  }
}

export interface ReconcileOptions {
  /** Compute the plan but do NOT apply it. */
  dryRun?: boolean;
  /** Override the systemd user-unit directory (tests). */
  unitDir?: string;
}

/**
 * Reconcile a manifest against the host for the given node. Filters the manifest
 * to entries whose `node` matches `nodeId`, computes the plan, and applies it
 * (unless `dryRun`). Returns the plan for inspection/logging.
 *
 * Graceful no-op on non-Linux / missing systemctl (R7): returns an empty plan.
 */
export function reconcile(
  manifest: SystemJob[],
  nodeId: string,
  opts: ReconcileOptions = {}
): ReconcilePlan {
  const unitDir = opts.unitDir ?? defaultUnitDir();
  const desired = manifest.filter(job => job.node === nodeId);

  if (!systemctlAvailable()) {
    return {
      writes: [],
      enables: [],
      disables: [],
      prunes: [],
      conflicts: [],
      daemonReloadNeeded: false,
    };
  }

  const current = readCurrentState(nodeId, unitDir);
  const foreign = readForeignUnits(nodeId, unitDir);
  const plan = planReconciliation(desired, current, foreign);
  if (!opts.dryRun) applyPlan(plan, unitDir);
  return plan;
}
