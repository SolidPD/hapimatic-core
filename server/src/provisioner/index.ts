// SPDX-License-Identifier: AGPL-3.0-only
/**
 * VM provisioner — public entry point (issue #2468).
 *
 * `initProvisioner()` is the composition root: it runs the capability verdict
 * (R6) ONCE at construction and returns a discriminated handle — an inert
 * `{ enabled:false, reason }` when the gate is closed, or a live
 * `{ enabled:true, runner, store, capability, fleetLock }` when open. It wires
 * the {@link JobStore} (SQLite), the {@link SystemdExecutor} (real systemd on
 * RP1, a stub in tests), the cross-instance {@link FleetLock}, and the
 * {@link JobRunner}. The `capability` member re-evaluates the gate LIVE so
 * #2469 can surface *why* it is (still) disabled without a restart.
 *
 * This factory is intentionally NOT wired into `server/src/index.ts` here — the
 * server-startup call site is deferred to #2469 (keeps Sub A purely additive;
 * revert = delete this directory).
 *
 * The bottom of this file re-exports the module's public surface (barrel).
 */

import type { Database } from "bun:sqlite";

import { type CapabilityVerdict, evaluateCapability } from "./capability";
import { FleetLock } from "./fleetLock";
import {
  JobRunner,
  RealSystemdExecutor,
  type SystemdExecutor,
} from "./jobRunner";
import { JobStore } from "./jobStore";
import { isTerminalState, type JobRecord } from "./types";

/** Gate closed: the subsystem is inert. No runner/store is wired. */
export interface DisabledProvisioner {
  enabled: false;
  /** Human-readable reason (surfaced by #2469 when disabled). */
  reason: string;
}

/** Gate open: the live provisioner surface handed to the HTTP route layer. */
export interface EnabledProvisioner {
  enabled: true;
  /** Launches / finalizes / re-attaches jobs (#2470 submit, #2469 startup). */
  runner: JobRunner;
  /** Read-only store access for the status/list endpoints (#2469). */
  store: JobStore;
  /** Re-evaluate the gate against the CURRENT env + filesystem (live). */
  capability: () => CapabilityVerdict;
  /** The fleet lock — #2469's preflight reaches `fleetLock.status()`. */
  fleetLock: FleetLock;
}

export type ProvisionerHandle = DisabledProvisioner | EnabledProvisioner;

export interface InitProvisionerConfig {
  /** SQLite database the job table lives in (the server passes its Store's db). */
  db: Database;
  /** Instance label for unit-name namespacing + lock holder (e.g. `dev:3009`). */
  instance: string;
  /** Absolute repo root the provisioning scripts live under. */
  repoRoot: string;
  /** Directory for per-job append logs. */
  logDir: string;
  /** Fleet-lock path (default: the shared cross-instance path). */
  lockPath?: string;
  /** systemd executor (default: {@link RealSystemdExecutor}) — injectable for tests. */
  executor?: SystemdExecutor;
  /** Env source for the capability gate (default: `process.env`). */
  env?: Record<string, string | undefined>;
  /** Home dir for credential resolution (default: `os.homedir()`). */
  homeDir?: string;
  /** File-existence probe for the capability gate (default: `node:fs`). */
  fileExists?: (path: string) => boolean;
  /**
   * Provisioning secret env reader for the capability gate (default: `node:fs`
   * readFileSync) — injectable for tests. Only NAMES are parsed from it; a value
   * is never read into the verdict (issue #2551).
   */
  readEnvFile?: (path: string) => string;
  /** Clock (default `Date.now`) — forwarded to the runner. */
  now?: () => number;
  /** Id generator (default `crypto.randomUUID`) — forwarded to the runner. */
  genId?: () => string;
  /** Log reader (default `node:fs`) — forwarded to the runner. */
  readLog?: (logPath: string) => Promise<string>;
  /** Log-dir/file ensurer (default `node:fs`) — forwarded to the runner. */
  ensureLog?: (logPath: string) => Promise<void>;
  /**
   * Terminal-state observer (issue #2471 R3) — forwarded to the runner. Fires once
   * per job reaching a terminal state; the server wiring appends a `system`-actor
   * terminal audit entry.
   */
  onTerminal?: (record: JobRecord) => void;
  /** Structured error sink (issue #2561) — forwarded to the runner's audit-observer catches. */
  logError?: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Wire the provisioner subsystem. Fails CLOSED: if the capability verdict is
 * disabled, returns an inert handle with the reason and wires nothing. When
 * enabled, the fleet lock's staleness probes are bound to the SAME executor +
 * store the runner uses, so a lock is only ever reaped when its unit is
 * genuinely inactive AND its job record is terminal (R7).
 */
export function initProvisioner(
  config: InitProvisionerConfig
): ProvisionerHandle {
  const capability = (): CapabilityVerdict =>
    evaluateCapability({
      env: config.env,
      fileExists: config.fileExists,
      homeDir: config.homeDir,
      repoRoot: config.repoRoot,
      readEnvFile: config.readEnvFile,
    });

  const verdict = capability();
  if (!verdict.enabled) {
    return { enabled: false, reason: verdict.reason };
  }

  const store = new JobStore(config.db);
  const executor = config.executor ?? new RealSystemdExecutor();

  const fleetLock = new FleetLock({
    lockPath: config.lockPath,
    isUnitActive: unit => executor.isActive(unit),
    isJobTerminal: jobId => {
      const rec = store.get(jobId);
      return !!rec && isTerminalState(rec.state);
    },
  });

  const runner = new JobRunner({
    store,
    fleetLock,
    executor,
    instance: config.instance,
    repoRoot: config.repoRoot,
    logDir: config.logDir,
    now: config.now,
    genId: config.genId,
    readLog: config.readLog,
    ensureLog: config.ensureLog,
    onTerminal: config.onTerminal,
    logError: config.logError,
  });

  return { enabled: true, runner, store, capability, fleetLock };
}

// ── Barrel: public surface of the provisioner module ────────────────────────
export * from "./types";
export * from "./jobModel";
export * from "./jobStore";
export * from "./capability";
export * from "./fleetLock";
export * from "./jobRunner";
export * from "./auditLog";
export * from "./logMasking";
