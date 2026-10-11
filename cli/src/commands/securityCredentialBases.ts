// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Which directories hold per-account credentials, for `hapi security audit` (issue #3841).
 *
 * The audit has to check every directory a reader actually uses. The server's
 * `UsageService.resolveToken` always reads the XDG base first and the per-instance
 * `<HAPI_HOME>/account-configs` second, whatever `HAPI_ACCOUNT_CONFIG_SHARED` says
 * (`server/src/accounts/usageService.ts`). The XDG base is resolved from the READER's
 * environment, which may differ from the auditing shell's, so the audit also checks the
 * home default (`~/.config/...`, what the systemd units resolve to) and the directory the
 * daemon records in `daemon.state.json` (read once by the caller, #4886). The CLI's
 * configured base comes last, so a future override cannot slip past the audit.
 */
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CredentialBase {
  dir: string;
  /** Prefix for finding labels, e.g. `account-configs/<uuid>/.credentials.json`. */
  label: string;
  /** False when `--fix` must not treat it as a safe root (a path read from a file). */
  fixRoot?: boolean;
}

export interface CredentialBaseInputs {
  happyHomeDir: string;
  /** The CLI's configured base (`configuration.accountConfigsDir`). */
  accountConfigsDir: string;
  /** The XDG base as this process resolves it: `${XDG_CONFIG_HOME:-~/.config}/hapimatic/account-configs`. */
  xdgAccountConfigsDir: string;
  /** The home default `~/.config/hapimatic/account-configs`, whatever XDG_CONFIG_HOME says. */
  homeAccountConfigsDir: string;
  /**
   * The `accountConfigsDir` the daemon records in `daemon.state.json` (#4153) — its own
   * base — or null when there is none. The caller reads the file once and reports a file
   * it cannot read, so this module stays free of I/O on the state file.
   */
  daemonRecordedDir: string | null;
}

/** The server's XDG credential base, resolved the way `UsageService` resolves it. */
export function defaultXdgAccountConfigsDir(
  env: NodeJS.ProcessEnv = process.env
): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "hapimatic", "account-configs");
}

/** A directory's identity: its realpath when it exists, else its normalised path. */
function dirKey(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Every credential base: the XDG bases first (as this process resolves it, then the home
 * default), the per-instance base, the CLI's configured base, then the daemon-recorded
 * one. The first three follow the server's read order. Deduplicated by realpath, so one
 * directory reached by two names (the SHARED=0 layout, a symlink alias, an unset
 * XDG_CONFIG_HOME) is checked once, under its first label.
 */
export function accountConfigBases(p: CredentialBaseInputs): CredentialBase[] {
  const candidates: CredentialBase[] = [
    { dir: p.xdgAccountConfigsDir, label: "account-configs" },
    { dir: p.homeAccountConfigsDir, label: "default account-configs" },
    {
      dir: join(p.happyHomeDir, "account-configs"),
      label: "instance account-configs",
    },
    { dir: p.accountConfigsDir, label: "configured account-configs" },
  ];
  const recorded = p.daemonRecordedDir;
  if (recorded) {
    // Checked, but never a --fix root: the path comes from a file, not from this process.
    candidates.push({
      dir: recorded,
      label: "daemon account-configs",
      fixRoot: false,
    });
  }
  const seen = new Set<string>();
  return candidates.filter(b => {
    const key = dirKey(b.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The bases `--fix` may use as safe roots: real directories this process resolved itself.
 * A symlinked base, or one read from a file (the daemon-recorded base), is left out, so a
 * credential reached through it is refused as outside the roots.
 */
export function fixRootDirs(bases: CredentialBase[]): string[] {
  return bases
    .filter(b => {
      if (b.fixRoot === false) return false;
      try {
        const st = lstatSync(b.dir);
        return st.isDirectory() && !st.isSymbolicLink();
      } catch {
        return false;
      }
    })
    .map(b => b.dir);
}
