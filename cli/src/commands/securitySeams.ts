// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The real-host implementations of `hapi security audit`'s injectable seams (issue #3841):
 * spawning gitleaks and git, probing pids, reading the daemon's environment, listing
 * interface addresses. `security.ts` uses them unless a test passes its own.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

import { GITLEAKS_TIMEOUT_MS } from "@/ext/supplyChainScan/scanner";

import type { SpawnResult } from "./security";
import { gitScanEnv } from "./securityFailClosed";

export function defaultRunGitleaks(bin: string, args: string[]): SpawnResult {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: GITLEAKS_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: gitScanEnv(process.env),
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

/**
 * Runs git for the coverage check under the same scan environment as gitleaks, so both read
 * the range the same way. `--diff-merges=remerge` creates and removes a temporary object
 * directory inside the scanned repo, so a read-only object store fails closed
 * (`fatal: unable to create temporary object directory`, #4886).
 */
export function defaultRunGit(repo: string, args: string[]): SpawnResult {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    // `log --raw --numstat` over a large merge delta; gitleaks reads the same diffs with -p.
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: gitScanEnv(process.env),
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parse a NUL-separated `/proc/<pid>/environ` (or `KEY=VAL` list) into a map. */
export function parseEnvBlock(
  block: string,
  separator: string
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of block.split(separator)) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * Read the daemon's environment: `/proc/<pid>/environ` first, then the environment of
 * the systemd unit owning the pid (from `/proc/<pid>/cgroup`). Never the audit's own
 * `process.env` — `HAPI_OMNIBOX_SANDBOX` is set on the daemon unit, not on this shell.
 */
export function defaultReadDaemonEnv(
  pid: number
): Record<string, string> | null {
  try {
    return parseEnvBlock(readFileSync(`/proc/${pid}/environ`, "utf8"), "\0");
  } catch {
    // fall through to systemd
  }
  try {
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8");
    const unit = cgroup.match(/([A-Za-z0-9@._-]+\.service)/)?.[1];
    if (!unit) return null;
    const r = spawnSync(
      "systemctl",
      ["--user", "show", unit, "-p", "Environment", "--value"],
      { encoding: "utf8", timeout: 5_000 }
    );
    if (r.status !== 0) return null;
    return parseEnvBlock((r.stdout ?? "").trim(), " ");
  } catch {
    return null;
  }
}

export function defaultListInterfaceAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const e of entries ?? []) {
      if (e.internal) continue;
      // IPv6 link-local needs a zone id to be dialled; it is never routable anyway.
      if (e.family === "IPv6" && e.address.toLowerCase().startsWith("fe80")) {
        continue;
      }
      out.push(e.address);
    }
  }
  return out;
}

export function defaultGetUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}
