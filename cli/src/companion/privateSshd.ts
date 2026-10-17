// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The helper's private `sshd` instances, run directory and watchdog
 * (issue #4352, Task 3).
 *
 * One `sshd` instance per approved principal (design decision W1), each started
 * from the system OpenSSH binary by absolute path, as the current user, with its
 * own configuration in a private run directory. The helper never installs,
 * enables or starts a system `sshd`, and never reads or writes `~/.ssh`.
 *
 * Lifetime (design doc, "Lifetime model" (a)): before any instance starts, a
 * detached POSIX `sh` watchdog is launched with its stdin on a pipe the helper
 * holds. It ignores INT/TERM/HUP and waits for EOF — which happens however the
 * helper exits, SIGKILL included — then kills every process whose command line
 * contains the run directory (every instance) and all their descendants, and
 * removes the run directory. Instances are started detached too, so a terminal
 * hangup's SIGHUP (which `sshd` treats as "re-exec") never reaches them.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopbackAddress, isTailnetAddress } from "@hapi/protocol/companion";
import { delay } from "@/utils/time";
import { generateOpenSshKeyPair } from "./sshKeys";

/** Run directories are created under the system temp dir with this prefix. */
export const RUN_DIR_PREFIX = "hapi-companion-";
/** Default first port of the instance range, and how many ports the range has. */
export const DEFAULT_PORT_BASE = 22200;
export const PORT_RANGE = 16;

// ── sshd binary ──────────────────────────────────────────────────────────────

export type SshdLookup =
  | { ok: true; path: string }
  | { ok: false; message: string };

/**
 * Find the system `sshd`. Never installs one: on a machine without it, return
 * instructions instead, because installing `openssh-server` on Debian/Ubuntu
 * enables a system `sshd.service` on port 22 — the incidental listener R2 forbids.
 */
export function findSshd(options: {
  platform: NodeJS.Platform;
  override?: string;
  exists?: (path: string) => boolean;
}): SshdLookup {
  const exists = options.exists ?? existsSync;
  if (options.override) {
    if (!options.override.startsWith("/")) {
      return { ok: false, message: "--sshd needs an absolute path" };
    }
    return exists(options.override)
      ? { ok: true, path: options.override }
      : { ok: false, message: `No sshd at ${options.override}` };
  }
  if (options.platform === "win32") {
    return {
      ok: false,
      message:
        "Native Windows is not qualified for the companion yet. Run it on macOS or Linux; see the hardware companion guide.",
    };
  }
  for (const candidate of ["/usr/sbin/sshd", "/usr/local/sbin/sshd"]) {
    if (exists(candidate)) return { ok: true, path: candidate };
  }
  if (options.platform === "darwin") {
    return {
      ok: false,
      message:
        "/usr/sbin/sshd was not found. macOS ships it; pass --sshd <path> if yours lives elsewhere.",
    };
  }
  return {
    ok: false,
    message: [
      "No OpenSSH server binary (sshd) was found. The companion runs its own private sshd",
      "and never installs one. To provide the binary:",
      "  Debian/Ubuntu:  sudo apt-get install openssh-server",
      "                  then, if you do not want a system SSH server on port 22:",
      "                  sudo systemctl disable --now ssh.service ssh.socket",
      "  Fedora:         sudo dnf install openssh-server   (its service stays disabled until enabled)",
      "Or pass --sshd <absolute path> to a binary you already have.",
    ].join("\n"),
  };
}

// ── Listen address ───────────────────────────────────────────────────────────

/** The first tailnet IPv4 address on this machine's interfaces, if any. */
export function findTailnetAddress(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): string | null {
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && isTailnetAddress(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}

/** A listen address the companion may bind: tailnet, or loopback for tests. */
export function isAllowedListenAddress(address: string): boolean {
  return isTailnetAddress(address) || isLoopbackAddress(address);
}

// ── Run directory ────────────────────────────────────────────────────────────

/**
 * Create the private run directory (mode 0700) and verify it belongs to us, so
 * `StrictModes no` in the instance config is safe: nobody else can write the
 * principals file, the CA file or the host key.
 */
export function createRunDir(base: string = tmpdir()): string {
  const dir = mkdtempSync(join(base, RUN_DIR_PREFIX));
  chmodSync(dir, 0o700);
  const st = statSync(dir);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("run directory is not owned by the current user");
  }
  if ((st.mode & 0o077) !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("run directory is accessible to other users");
  }
  return dir;
}

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Generate the helper's Ed25519 host key in the run directory. */
export function writeHostKey(runDir: string): { publicKeyLine: string } {
  const { privateKey, publicKeyLine } = generateOpenSshKeyPair(
    "hapi-companion-host"
  );
  writePrivate(join(runDir, "host_ed25519"), privateKey);
  writePrivate(join(runDir, "host_ed25519.pub"), `${publicKeyLine}\n`);
  return { publicKeyLine };
}

/** Write the pairing CA's public key — the only key the instances trust. */
export function writeCaKey(runDir: string, caPublicKeyLine: string): void {
  writePrivate(join(runDir, "ca.pub"), `${caPublicKeyLine.trim()}\n`);
}

// ── Instance configuration ───────────────────────────────────────────────────

export type InstanceConfigInput = {
  runDir: string;
  index: number;
  listenAddress: string;
  port: number;
  user: string;
};

/** Paths of one instance's files inside the run directory. */
export function instancePaths(runDir: string, index: number) {
  return {
    config: join(runDir, `sshd-${index}.conf`),
    principals: join(runDir, `principals-${index}`),
    pid: join(runDir, `sshd-${index}.pid`),
  };
}

/**
 * The `sshd_config` for one instance. Every directive is deliberate; the design
 * doc lists the reasons ("The private `sshd`" → "Configuration").
 */
export function renderSshdConfig(input: InstanceConfigInput): string {
  if (!isAllowedListenAddress(input.listenAddress)) {
    throw new Error(`refusing to listen on ${input.listenAddress}`);
  }
  if (input.port < 1024 || input.port > 65535) {
    throw new Error("instance port must be between 1024 and 65535");
  }
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(input.user)) {
    throw new Error("unusable local user name");
  }
  const paths = instancePaths(input.runDir, input.index);
  const listen = input.listenAddress.includes(":")
    ? `[${input.listenAddress}]:${input.port}`
    : `${input.listenAddress}:${input.port}`;
  return [
    "# Generated by hapi companion (issue #4352). Private to this run; deleted on exit.",
    `ListenAddress ${listen}`,
    `HostKey ${join(input.runDir, "host_ed25519")}`,
    `PidFile ${paths.pid}`,
    `TrustedUserCAKeys ${join(input.runDir, "ca.pub")}`,
    `AuthorizedPrincipalsFile ${paths.principals}`,
    "AuthorizedKeysFile none",
    "AuthenticationMethods publickey",
    "PubkeyAuthentication yes",
    "PubkeyAcceptedAlgorithms ssh-ed25519-cert-v01@openssh.com",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PermitRootLogin no",
    `AllowUsers ${input.user}`,
    "UsePAM no",
    "StrictModes no",
    "PermitUserRC no",
    "PermitUserEnvironment no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitTunnel no",
    "GatewayPorts no",
    "AllowTcpForwarding yes",
    "PermitTTY yes",
    "Subsystem sftp internal-sftp",
    "ClientAliveInterval 15",
    "ClientAliveCountMax 3",
    "LogLevel VERBOSE",
    "PrintMotd no",
    "",
  ].join("\n");
}

/** Write one instance's config and its single-principal principals file. */
export function writeInstanceFiles(
  input: InstanceConfigInput,
  principal: string
): ReturnType<typeof instancePaths> {
  const paths = instancePaths(input.runDir, input.index);
  writePrivate(paths.principals, `${principal}\n`);
  writePrivate(paths.config, renderSshdConfig(input));
  return paths;
}

/** True when nothing is listening on `address:port` right now. */
export async function isPortFree(
  address: string,
  port: number
): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: address, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** The first free port in `[base, base + PORT_RANGE)` not already used by us. */
export async function pickPort(
  address: string,
  base: number,
  inUse: ReadonlySet<number>,
  probe: (address: string, port: number) => Promise<boolean> = isPortFree
): Promise<number | null> {
  for (let port = base; port < base + PORT_RANGE; port++) {
    if (inUse.has(port)) continue;
    if (await probe(address, port)) return port;
  }
  return null;
}

// ── Processes ────────────────────────────────────────────────────────────────

export type ProcessRow = { pid: number; ppid: number; args: string };

/** Parse `ps -ww -A -o pid= -o ppid= -o args=` output (same columns on macOS and Linux). */
export function parsePsOutput(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      args: match[3] ?? "",
    });
  }
  return rows;
}

/** `roots` plus every descendant of them, in `rows`. */
export function descendantsOf(
  rows: readonly ProcessRow[],
  roots: Iterable<number>
): Set<number> {
  const found = new Set<number>(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!found.has(row.pid) && found.has(row.ppid)) {
        found.add(row.pid);
        grew = true;
      }
    }
  }
  return found;
}

export function listProcesses(): ProcessRow[] {
  const result = spawnSync(
    "ps",
    // -ww: never truncate the args column (procps honours $COLUMNS even
    // without a terminal), or a run directory in a long path goes unmatched.
    ["-ww", "-A", "-o", "pid=", "-o", "ppid=", "-o", "args="],
    {
      encoding: "utf8",
    }
  );
  return result.status === 0 ? parsePsOutput(result.stdout) : [];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM a process and every descendant, then SIGKILL whatever is left after
 * `graceMs`. Never signals pid 1 or this process.
 */
export async function killTree(rootPid: number, graceMs = 1000): Promise<void> {
  const targets = [...descendantsOf(listProcesses(), [rootPid])].filter(
    pid => pid > 1 && pid !== process.pid
  );
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && targets.some(isAlive)) await delay(50);
  for (const pid of targets) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Direct children of `pid` — for an `sshd` listener, one per live connection. */
export function childCount(rows: readonly ProcessRow[], pid: number): number {
  return rows.filter(r => r.ppid === pid).length;
}

// ── Watchdog ─────────────────────────────────────────────────────────────────

/**
 * The watchdog script. `$1` is the run directory. It reads stdin until EOF
 * (the helper's end of the pipe closing), then kills every process whose
 * command line contains the run directory plus their descendants — excluding
 * itself and its own children — and removes the run directory. The directory
 * reaches `awk` through the environment, never argv, so `awk` does not match
 * itself.
 */
export const WATCHDOG_SCRIPT = `#!/bin/sh
# hapi companion watchdog (issue #4352). Kills this run's sshd instances and
# removes the run directory when the helper's pipe closes, however it exits.
RUN_DIR="$1"
case "$RUN_DIR" in
  */${RUN_DIR_PREFIX}*) ;;
  *) exit 2 ;;
esac
trap '' INT TERM HUP
cat >/dev/null 2>&1
SELF=$$
targets() {
  ps -ww -A -o pid= -o ppid= -o args= | RUN_DIR="$RUN_DIR" SELF="$SELF" awk '
    { pid = $1; ppid = $2; $1 = ""; $2 = ""; parent[pid] = ppid
      if (index($0, ENVIRON["RUN_DIR"]) > 0 && pid != ENVIRON["SELF"] && ppid != ENVIRON["SELF"]) hit[pid] = 1 }
    END {
      grew = 1
      while (grew) { grew = 0; for (p in parent) if (!(p in hit) && (parent[p] in hit)) { hit[p] = 1; grew = 1 } }
      for (p in hit) if (p > 1) print p
    }'
}
PIDS=$(targets)
if [ -n "$PIDS" ]; then
  kill -TERM $PIDS 2>/dev/null
  sleep 1
  PIDS=$(targets)
  [ -n "$PIDS" ] && kill -KILL $PIDS 2>/dev/null
fi
rm -rf "$RUN_DIR"
exit 0
`;

export type Watchdog = { child: ChildProcess };

/**
 * Write and start the watchdog, detached (its own session), with its stdin on
 * a pipe this process holds open for its whole life. Must run before the first
 * instance starts.
 */
export function startWatchdog(runDir: string): Watchdog {
  const scriptPath = join(runDir, "watchdog.sh");
  writeFileSync(scriptPath, WATCHDOG_SCRIPT, { mode: 0o700 });
  const child = spawn("/bin/sh", [scriptPath, runDir], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  // Never written to: the pipe exists only so its EOF signals our exit.
  return { child };
}

// ── Instances ────────────────────────────────────────────────────────────────

export type SshdInstance = {
  principal: string;
  index: number;
  port: number;
  child: ChildProcess;
  /** Source addresses seen in this instance's "Accepted" log lines (most recent last). */
  sources: string[];
  exited: boolean;
};

/** "Accepted publickey for bench from 100.64.1.2 port 51234 ssh2: …" → the address. */
export function parseAcceptedSource(line: string): string | null {
  const match = line.match(/Accepted \S+ for \S+ from (\S+) port \d+/);
  return match?.[1] ?? null;
}

/**
 * Start one `sshd -D -e` instance, detached, with stderr piped so its
 * "Accepted … from <address>" lines identify this principal's sources. Resolves
 * once `sshd` reports it is listening, or rejects if it exits first.
 */
export function startInstance(options: {
  sshdPath: string;
  configPath: string;
  principal: string;
  index: number;
  port: number;
  startTimeoutMs?: number;
}): Promise<SshdInstance> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.sshdPath,
      ["-D", "-e", "-f", options.configPath],
      { detached: true, stdio: ["ignore", "ignore", "pipe"] }
    );
    const instance: SshdInstance = {
      principal: options.principal,
      index: options.index,
      port: options.port,
      child,
      sources: [],
      exited: false,
    };
    let settled = false;
    const errors: string[] = [];
    const timer = setTimeout(() => {
      if (settled) return;
      // No "listening" line within the timeout but still running: treat it as up.
      settled = true;
      resolve(instance);
    }, options.startTimeoutMs ?? 3000);
    let buffer = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!settled) errors.push(line);
        const source = parseAcceptedSource(line);
        if (source) {
          instance.sources = [
            ...instance.sources.filter(s => s !== source),
            source,
          ].slice(-8);
        }
        if (!settled && /Server listening on/.test(line)) {
          settled = true;
          clearTimeout(timer);
          resolve(instance);
        }
      }
    });
    child.once("error", error => {
      instance.exited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", code => {
      instance.exited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `sshd exited (${code ?? "signal"}) before listening: ${errors.slice(-3).join(" | ")}`
        )
      );
    });
  });
}
