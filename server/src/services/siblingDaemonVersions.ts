// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Older sibling daemons on this machine (issue #6800, the re-login warning).
 *
 * Before #6800 every Hapimatic daemon ran a CredentialsWatcher that copied the
 * `~/.claude` login chain into the account folders. A daemon on an older build
 * still does, and it would overwrite a fresh sign-in of the account
 * `~/.claude.json` names. While such a daemon is live on the machine, the
 * Provider Accounts sign-in shows a warning (never a refusal) naming it.
 *
 * The server cannot import the CLI (`usageService.ts`), so this is its own
 * small reader with the same rule as the CLI's shared-chain detector
 * (`cli/src/accounts/hostChainQuarantine.ts`): a sibling counts when its pid is
 * alive, its heartbeat is at most 180 s old or absent (a daemon built before
 * 1.0.1498, or in its first heartbeat interval), and its build is older by
 * `isOlderSiblingVersion` (`shared/src/buildVersion.ts`). Only `pid`,
 * `lastHeartbeatAt` and `startedWithCliVersion` are parsed out of each
 * `daemon.state.json`: the file also holds the daemon's control token, which
 * never leaves this module. Never throws.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isOlderSiblingVersion } from "@hapi/protocol";
import { resolveDataPaths } from "../configuration";
import { VERSION } from "../version.generated";

/** A sibling whose heartbeat is older than this is not live (three 60 s beats). */
export const SIBLING_HEARTBEAT_STALE_MS = 180_000;

export interface OlderSiblingDaemonOptions {
  /** The home dir whose `.hapimatic-*` folders are instance homes. */
  home?: string;
  /** This server's own instance home (its daemon is not a sibling). */
  ownHapiHome?: string;
  /** This build's version. */
  ownVersion?: string;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The instance names (the `.hapimatic-<name>` folder names, without the dot)
 * of the live sibling daemons that run an older build than this one. An empty
 * list on any read error.
 */
export async function listOlderLiveSiblingDaemons(
  opts: OlderSiblingDaemonOptions = {}
): Promise<string[]> {
  try {
    const home = opts.home ?? homedir();
    const own = resolve(opts.ownHapiHome ?? resolveDataPaths().dataDir);
    const ownVersion = opts.ownVersion ?? VERSION;
    const now = (opts.now ?? Date.now)();
    const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    const entries = await readdir(home, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".hapimatic-")) {
        continue;
      }
      const instanceHome = join(home, entry.name);
      if (resolve(instanceHome) === own) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(
          await readFile(join(instanceHome, "daemon.state.json"), "utf-8")
        ) as Record<string, unknown>;
      } catch {
        continue;
      }
      const pid = parsed.pid;
      const heartbeat = parsed.lastHeartbeatAt;
      const version = parsed.startedWithCliVersion;
      if (typeof pid !== "number" || !Number.isInteger(pid)) continue;
      // No heartbeat field: live while its pid is (it may still run the watcher).
      if (
        typeof heartbeat === "number" &&
        now - heartbeat > SIBLING_HEARTBEAT_STALE_MS
      ) {
        continue;
      }
      if (!isPidAlive(pid)) continue;
      if (
        !isOlderSiblingVersion(
          typeof version === "string" ? version : null,
          ownVersion
        )
      ) {
        continue;
      }
      names.push(entry.name.slice(1));
    }
    return names.sort();
  } catch {
    return [];
  }
}
