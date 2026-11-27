// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import {
  describeInstanceKind,
  serverPortFromUrl,
} from "@hapi/protocol/instanceKind";
import { readInstanceKind } from "@hapi/protocol/instanceKindReader";
import {
  readTestStoreState,
  writeTestStoreMarker,
  type TestStoreState,
} from "@/accounts/accountStore";
import { scrubTenantProviderEnv } from "@/accounts/tenantMode";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import { CLI_VERSION } from "@/version";
import { detectSelfUnitName } from "./systemdInvariants";
import type { DaemonContext, DaemonInstanceKind } from "./daemonContext";

/**
 * Issue #6756 (TC1): the daemon's instance-kind boot step, run ONCE beside the tenant
 * decision and BEFORE the boot record is built (`run.ts`).
 *
 *  1. Read the kind (`readInstanceKind`) from the data dir the configuration resolved, the
 *     server port, and the daemon's own systemd unit; log one `[INSTANCE] kind=…` line
 *     naming the signals that matched (and one warn per signal that could not be read).
 *  2. On a TEST instance, remove the onboarding token(s) from the daemon env, as a tenant
 *     daemon does (R1, M8): the spawner falls back to `CLAUDE_CODE_OAUTH_TOKEN` and the
 *     tmux server inherits the env, so with them gone nothing seeds an env-token account
 *     or holds an instance token for unbound spawns.
 *  3. On a TEST instance, read what its account store holds by directory listing (R7):
 *     an empty store gets the test-store marker; a store with any `*.json` and no marker
 *     predates this work and is recorded as inherited (ER-D1), so nothing binds from it
 *     and nothing renews any of it. This step deletes, moves and rewrites nothing in it
 *     (the shared-chain pass may still flag a record).
 *
 * Never throws: the classifier reader never throws, and every store read here reports its
 * failure as a value.
 */

export interface InstanceKindBootLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface PrepareInstanceKindOptions {
  /** The daemon env (`process.env`); the onboarding token(s) are removed from it on a test instance. */
  env: Record<string, string | undefined>;
  /** `configuration.happyHomeDir`. */
  dataDir: string;
  /** `configuration.accountsDir`. */
  accountsDir: string;
  /** `configuration.serverUrl`. */
  serverUrl: string | null;
  /** The daemon's own systemd unit; defaults to the one `/proc/self/cgroup` names. */
  unitName?: string | null;
  /** The build written into the marker (`CLI_VERSION`). */
  build: string;
  log: InstanceKindBootLog;
  /** Test seam for the user's home (production: `os.homedir()`). */
  userHome?: string;
}

/** The daemon's own systemd unit, from `/proc/self/cgroup`; `null` off Linux or outside systemd. */
export function readOwnUnitName(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return detectSelfUnitName(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return null;
  }
}

export async function prepareDaemonInstanceKind(
  opts: PrepareInstanceKindOptions
): Promise<DaemonInstanceKind> {
  const reading: DaemonInstanceKind = readInstanceKind({
    dataDir: opts.dataDir,
    serverPort: serverPortFromUrl(opts.serverUrl),
    unitName: opts.unitName === undefined ? readOwnUnitName() : opts.unitName,
    env: opts.env,
    userHome: opts.userHome,
  });
  opts.log.info(`[INSTANCE] ${describeInstanceKind(reading)}`);
  for (const what of reading.unreadable) {
    opts.log.warn(`[INSTANCE] could not read the ${what}; counted as absent`);
  }
  if (reading.kind !== "real") {
    opts.log.info("[INSTANCE] account-folder adoption off (#6756)");
  }
  if (reading.kind !== "test") return reading;

  const removed = scrubTenantProviderEnv(opts.env);
  if (removed.length > 0) {
    opts.log.info(
      `[INSTANCE] test instance: ignored ${removed.join(", ")} from the daemon env; no env-token account and no instance token for unbound spawns (#6756)`
    );
  }

  const store: TestStoreState = await readTestStoreState(
    opts.accountsDir,
    opts.dataDir
  );
  switch (store.state) {
    case "marked":
      break;
    case "empty": {
      const written = await writeTestStoreMarker(opts.accountsDir, opts.build);
      if (written.ok) {
        opts.log.info("[INSTANCE] test store marked (#6756)");
      } else {
        // The store stays unmarked, so no later step will ever delete it. It is empty
        // now; a record signed in later makes it read as inherited at the next boot.
        opts.log.warn(
          `[INSTANCE] could not write the test-store marker (${written.code}); the store stays unmarked (#6756)`
        );
      }
      break;
    }
    case "unmarked-configs":
      opts.log.info(
        "[INSTANCE] test store left unmarked: the data dir holds a legacy account-configs folder (#6756)"
      );
      break;
    case "unmarked-bookkeeping":
      opts.log.info(
        "[INSTANCE] test store left unmarked: it holds only a daemon bookkeeping file, no login (#6756)"
      );
      break;
    case "inherited":
      reading.inheritedStore = { records: store.records };
      opts.log.warn(
        `[INSTANCE] test store predates #6756 (${store.records} records); none of it is used (Q5 decides it)`
      );
      break;
    case "unreadable":
      // Nothing proves the store empty, so it is treated as inherited (fail closed).
      reading.inheritedStore = { records: 0 };
      opts.log.warn(
        `[INSTANCE] could not list the test store (${store.code}); none of it is used (#6756)`
      );
      break;
  }
  return reading;
}

/**
 * The daemon's boot call (`run.ts`, beside the tenant decision and before the boot
 * record): {@link prepareDaemonInstanceKind} on this process's configuration, stored on
 * `ctx.instanceKind`, the one reading every gate shares.
 */
export async function bootDaemonInstanceKind(
  ctx: Pick<DaemonContext, "instanceKind">
): Promise<DaemonInstanceKind> {
  const reading = await prepareDaemonInstanceKind({
    env: process.env,
    dataDir: configuration.happyHomeDir,
    accountsDir: configuration.accountsDir,
    serverUrl: configuration.serverUrl,
    build: CLI_VERSION,
    log: logger,
  });
  ctx.instanceKind = reading;
  return reading;
}
