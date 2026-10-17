// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hapi companion start|stop|status` — the bench helper runtime (issue #4352,
 * Task 3). Runs on the customer's bench PC (macOS, Linux).
 *
 * `start` pairs with the VM's Hapimatic server, then runs until Stop: it
 * heartbeats, asks the bench user to approve each cloud session that wants in,
 * starts one private `sshd` per approved session, shows every live connection,
 * and tears everything down on Stop, crash (via the watchdog), stale contact,
 * session end or revocation. The decisions live in `lifetime.ts`; this file
 * executes them. Design: docs/internal/architecture/hardware-companion.md.
 *
 * Nothing here consults activation, licensing or payment state (R7).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, hostname, platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import {
  formatPairingCode,
  normalizePairingCode,
  type CompanionClaimResult,
  type CompanionPrivilege,
  type CompanionTiming,
} from "@hapi/protocol/companion";
import { delay } from "@/utils/time";
import { CompanionLifetime, type LifetimeAction } from "./lifetime";
import {
  CompanionHttpError,
  HelperClient,
  checkServerUrl,
} from "./helperClient";
import {
  DEFAULT_PORT_BASE,
  PORT_RANGE,
  RUN_DIR_PREFIX,
  childCount,
  createRunDir,
  findSshd,
  findTailnetAddress,
  isAllowedListenAddress,
  killTree,
  listProcesses,
  pickPort,
  startInstance,
  startWatchdog,
  writeCaKey,
  writeHostKey,
  writeInstanceFiles,
  type SshdInstance,
  type Watchdog,
} from "./privateSshd";
import { confirmKeyFingerprint } from "./sshKeys";

export type StartOptions = {
  server: string;
  listen?: string;
  portBase?: number;
  sshd?: string;
  approveForPairing: boolean;
  /** Accept the CA without the interactive comparison (required without a TTY). */
  yes: boolean;
};

type Out = (line: string) => void;
const out: Out = line => process.stdout.write(`${line}\n`);
const err: Out = line => process.stderr.write(`${line}\n`);

/** `admin` when the account is root or in an administrator group. */
export function localPrivilege(
  groups: readonly string[],
  uid: number
): CompanionPrivilege {
  if (uid === 0) return "admin";
  return groups.some(g => g === "admin" || g === "sudo" || g === "wheel")
    ? "admin"
    : "user";
}

function currentGroups(): string[] {
  const res = spawnSync("id", ["-Gn"], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim().split(/\s+/) : [];
}

async function askYesNo(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  return new Promise(resolve => {
    const onData = (data: Buffer) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(data.toString().trim()));
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function formatTime(ms: number | null): string {
  if (ms === null) return "-";
  return new Date(ms).toLocaleTimeString();
}

/** Run the helper until Stop. Resolves with the process exit code. */
export async function runCompanionStart(
  options: StartOptions
): Promise<number> {
  // ── Preflight: every refusal happens before anything is created ──────────
  const os = platform();
  if (os === "win32") {
    err(
      "Native Windows is not qualified for the companion yet (see the hardware companion guide)."
    );
    return 2;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid === 0) {
    err(
      "Refusing to run as root. Run the companion as the account you want to grant; give that account device access locally (for example the dialout group) instead."
    );
    return 2;
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && !options.yes) {
    err(
      "Pairing needs a terminal to compare the CA fingerprint. Run it in a terminal, or pass --yes to skip the comparison (only over a channel you trust)."
    );
    return 2;
  }
  const sshd = findSshd({ platform: os, override: options.sshd });
  if (!sshd.ok) {
    err(sshd.message);
    return 2;
  }
  // Stop, session end, expiry and the crash watchdog all find processes with
  // `ps`. Without a working `ps` they would kill nothing and say nothing.
  if (!listProcesses().some(row => row.pid === process.pid)) {
    err(
      "`ps -ww -A -o pid= -o ppid= -o args=` does not list this process here. The companion needs it to remove its sshd on Stop and after a crash; install procps."
    );
    return 2;
  }
  const listenAddress = options.listen ?? findTailnetAddress();
  if (!listenAddress) {
    err(
      "No tailnet address found on this machine. Join the same Tailscale tailnet as your VM, or pass --listen <tailnet address>."
    );
    return 2;
  }
  if (!isAllowedListenAddress(listenAddress)) {
    err(
      `--listen ${listenAddress} is not a tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) or loopback address; the companion never listens anywhere else.`
    );
    return 2;
  }
  const portBase = options.portBase ?? DEFAULT_PORT_BASE;
  if (
    !Number.isInteger(portBase) ||
    portBase < 1024 ||
    portBase + PORT_RANGE > 65536
  ) {
    err("--port must be an integer from 1024 to 65520");
    return 2;
  }
  const server = await checkServerUrl(options.server);
  if (!server.ok) {
    err(server.message);
    return 2;
  }
  const user = userInfo().username;
  const privilege = localPrivilege(currentGroups(), uid);

  // ── Run directory, host key, watchdog (before any sshd) ──────────────────
  const runDir = createRunDir();
  let watchdog: Watchdog | null = null;
  const removeRunDir = () => rmSync(runDir, { recursive: true, force: true });
  try {
    watchdog = startWatchdog(runDir);
  } catch (error) {
    removeRunDir();
    err(
      `Could not start the watchdog: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }
  const { publicKeyLine } = writeHostKey(runDir);
  writeFileSync(
    join(runDir, "helper.json"),
    JSON.stringify({
      pid: process.pid,
      server: server.url,
      startedAt: Date.now(),
      listenAddress,
      user,
    }),
    { mode: 0o600 }
  );

  const client = new HelperClient(server.url);
  const instances = new Map<string, SshdInstance>();
  /** Bumped by every start and every kill of a principal (see startFor). */
  const startGeneration = new Map<string, number>();
  let nextIndex = 1;
  let token: string | null = null;
  let exiting = false;
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>(resolve => {
    finish = resolve;
  });

  /** Kill every instance, end the pairing if asked, remove the run directory. */
  const shutdown = async (
    code: number,
    endPairing: boolean,
    message: string
  ) => {
    if (exiting) return;
    exiting = true;
    if (message) out(message);
    await Promise.all(
      [...instances.values()].map(i =>
        i.child.pid ? killTree(i.child.pid) : undefined
      )
    );
    instances.clear();
    if (endPairing && token) {
      try {
        await client.end(token);
      } catch {
        // Best effort: the server ends a silent pairing on its own (stale).
      }
    }
    removeRunDir();
    // Closing our end of the pipe lets the watchdog find nothing and exit.
    watchdog?.child.stdin?.destroy();
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
    finish(code);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown(0, true, `\nStopping (${signal})…`));
  }

  // ── Pairing ──────────────────────────────────────────────────────────────
  let paired: Extract<CompanionClaimResult, { status: "paired" }> | null = null;
  try {
    const request = await client.createPairRequest({
      hostKey: publicKeyLine,
      localUser: user,
      hostname: hostname().slice(0, 253),
      os,
      arch: arch(),
      privilege,
      listenAddress,
    });
    const code = formatPairingCode(
      normalizePairingCode(request.code) ?? request.code
    );
    // Show the fingerprint of OUR key, and stop if the server saw another one.
    const hostKeyFingerprint = await confirmKeyFingerprint(
      publicKeyLine,
      request.hostKeyFingerprint
    );
    out("");
    out(`  Pairing code:              ${code}`);
    out(`  This machine's host key:   ${hostKeyFingerprint}`);
    out("");
    out("  On the VM, in a Hapimatic session or its terminal, run:");
    out(`      hapi companion pair ${code}`);
    out("  and check that it shows the same host-key fingerprint.");
    out("");
    out(
      `  Waiting for confirmation (the code expires at ${formatTime(request.expiresAt)})…`
    );
    while (!paired) {
      if (exiting) return done;
      const claim = await client.claim(request.requestId, request.pollSecret);
      if (claim.status === "paired") paired = claim;
      else await delay(2000);
    }
  } catch (error) {
    await shutdown(1, false, `Pairing failed: ${describe(error)}`);
    return done;
  }

  if (!paired) return done;
  const pairingId = paired.pairingId;
  // Show the fingerprint of the CA key we are about to trust, computed here.
  let caFingerprint: string;
  try {
    caFingerprint = await confirmKeyFingerprint(
      paired.caPublicKey,
      paired.caFingerprint
    );
  } catch (error) {
    token = paired.token;
    await shutdown(
      1,
      true,
      `The VM's CA key does not match its fingerprint (${describe(error)}); the pairing was ended.`
    );
    return done;
  }
  out("");
  out(`  Paired. The VM's CA fingerprint is: ${caFingerprint}`);
  if (!options.yes) {
    const same = await askYesNo(
      "  Does `hapi companion pair` on the VM show this CA fingerprint?"
    );
    if (!same) {
      token = paired.token;
      await shutdown(
        1,
        true,
        "CA fingerprint not confirmed; the pairing was ended."
      );
      return done;
    }
  }
  token = paired.token;
  writeCaKey(runDir, paired.caPublicKey);
  const timing: CompanionTiming = paired.timing;

  // ── Lifetime ─────────────────────────────────────────────────────────────
  const lifetime = new CompanionLifetime({
    timing,
    now: () => Date.now(),
    autoApprove: options.approveForPairing,
  });

  const render = () => {
    if (exiting) return;
    const rows = listProcesses();
    const lines = [
      "",
      `── hapi companion · ${server.url} · pairing ${pairingId}`,
      `   account ${user} (${privilege === "admin" ? "administrator" : "standard user"}) · listening on ${listenAddress} ports ${portBase}-${portBase + PORT_RANGE - 1}`,
    ];
    const principals = lifetime.snapshot();
    if (principals.length === 0)
      lines.push("   no cloud session has asked to connect");
    for (const p of principals) {
      const inst = instances.get(p.principal);
      const live = inst?.child.pid ? childCount(rows, inst.child.pid) : 0;
      const label = `"${p.sessionLabel}" (${p.principal})`;
      if (p.state === "waiting") {
        lines.push(`   [waiting]  ${label} — press a to approve, d to deny`);
      } else if (p.state === "denied") {
        lines.push(`   [denied]   ${label}`);
      } else {
        const where = inst ? `port ${inst.port}` : "starting";
        const sources = inst?.sources.length
          ? ` from ${inst.sources.join(", ")}`
          : "";
        lines.push(
          `   [approved] ${label} · ${where} · until ${formatTime(p.validUntil)} · ${live} connection(s)${sources}`
        );
      }
    }
    lines.push(
      options.approveForPairing
        ? "   approve-for-pairing is ON · keys: s stop"
        : "   keys: a approve · d deny · s stop"
    );
    out(lines.join("\n"));
    try {
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({ pairingId, principals, updatedAt: Date.now() }),
        { mode: 0o600 }
      );
    } catch {
      // the run directory is going away
    }
  };

  const apply = async (actions: LifetimeAction[]) => {
    let changed = false;
    for (const action of actions) {
      changed = true;
      if (action.kind === "prompt") {
        process.stdout.write("\x07");
      } else if (action.kind === "start-instance") {
        await startFor(action.principal);
      } else if (action.kind === "kill-instance") {
        // Invalidate a start still in flight for this principal (startFor).
        startGeneration.set(
          action.principal,
          (startGeneration.get(action.principal) ?? 0) + 1
        );
        const inst = instances.get(action.principal);
        instances.delete(action.principal);
        if (inst?.child.pid) await killTree(inst.child.pid);
        out(
          `   ${action.principal}: access removed (${action.reason === "expired" ? "authorization expired" : "the cloud session ended"})`
        );
      } else {
        const r = action.reason;
        const message =
          r.kind === "stop"
            ? "Stopped. Bridge-owned access is removed; commands already run on this machine are not undone."
            : r.kind === "stale"
              ? "Lost contact with the VM for too long (network loss or sleep). Everything was torn down; run `hapi companion start` to pair again."
              : `The VM ended this pairing (${r.detail}). Everything was torn down.`;
        await shutdown(r.exitCode, r.kind === "stop", message);
        return;
      }
    }
    if (changed) render();
  };

  const startFor = async (principal: string) => {
    const generation = (startGeneration.get(principal) ?? 0) + 1;
    startGeneration.set(principal, generation);
    const used = new Set([...instances.values()].map(i => i.port));
    const port = await pickPort(listenAddress, portBase, used);
    if (port === null) {
      out(
        `   ${principal}: no free port in ${portBase}-${portBase + PORT_RANGE - 1}`
      );
      return;
    }
    const index = nextIndex++;
    const paths = writeInstanceFiles(
      { runDir, index, listenAddress, port, user },
      principal
    );
    try {
      const instance = await startInstance({
        sshdPath: sshd.path,
        configPath: paths.config,
        principal,
        index,
        port,
      });
      // A kill can arrive during the start (up to 3 s) and find nothing to
      // stop; whatever this start produced must then go too.
      if (
        exiting ||
        lifetime.ended ||
        startGeneration.get(principal) !== generation ||
        !lifetime.isApproved(principal)
      ) {
        if (instance.child.pid) await killTree(instance.child.pid);
        return;
      }
      instances.set(principal, instance);
    } catch (error) {
      out(`   ${principal}: sshd did not start: ${describe(error)}`);
    }
  };

  // Keys: a approve, d deny, s/q stop, Ctrl-C stop.
  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on(
      "keypress",
      (_s: string, key: { name?: string; ctrl?: boolean }) => {
        if (exiting) return;
        if (
          (key.ctrl && key.name === "c") ||
          key.name === "s" ||
          key.name === "q"
        ) {
          void apply(lifetime.stop());
          return;
        }
        if (key.name === "a" || key.name === "d") {
          const waiting = lifetime.oldestWaiting();
          if (waiting) {
            void apply(
              lifetime.decide(
                waiting.principal,
                key.name === "a" ? "approve" : "deny"
              )
            );
          }
        }
      }
    );
  }

  const heartbeat = async () => {
    if (exiting || !token) return;
    const rows = listProcesses();
    try {
      const result = await client.heartbeat(token, {
        decisions: lifetime.takeDecisionsForHeartbeat(),
        instances: [...instances.values()]
          .filter(i => !i.exited)
          .map(i => ({
            principal: i.principal,
            port: i.port,
            liveConnections: i.child.pid ? childCount(rows, i.child.pid) : 0,
            sources: i.sources,
          })),
      });
      await apply(lifetime.onHeartbeatOk(result.principals));
    } catch (error) {
      if (
        error instanceof CompanionHttpError &&
        (error.status === 401 || error.status === 410)
      ) {
        await apply(lifetime.onPairingGone(error.message));
      } else {
        await apply(lifetime.onHeartbeatFailed());
      }
    }
    if (!exiting)
      setTimeout(() => void heartbeat(), timing.heartbeatIntervalMs);
  };

  const tick = async () => {
    if (exiting) return;
    await apply(lifetime.tick());
    if (!exiting) setTimeout(() => void tick(), 1000);
  };

  render();
  void heartbeat();
  void tick();
  return done;
}

function describe(error: unknown): string {
  if (error instanceof CompanionHttpError)
    return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

// ── stop / status (from another terminal) ──────────────────────────────────

type RunInfo = {
  runDir: string;
  pid: number;
  server: string;
  listenAddress: string;
  state: unknown;
};

/** The current user's run directories that hold a helper.json. */
export function findRuns(base: string = tmpdir()): RunInfo[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const runs: RunInfo[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(base);
  } catch {
    return runs;
  }
  for (const name of entries) {
    if (!name.startsWith(RUN_DIR_PREFIX)) continue;
    const runDir = join(base, name);
    try {
      if (uid >= 0 && statSync(runDir).uid !== uid) continue;
      const helper = JSON.parse(
        readFileSync(join(runDir, "helper.json"), "utf8")
      ) as {
        pid?: unknown;
        server?: unknown;
        listenAddress?: unknown;
      };
      if (typeof helper.pid !== "number") continue;
      const statePath = join(runDir, "state.json");
      runs.push({
        runDir,
        pid: helper.pid,
        server: String(helper.server ?? ""),
        listenAddress: String(helper.listenAddress ?? ""),
        state: existsSync(statePath)
          ? JSON.parse(readFileSync(statePath, "utf8"))
          : null,
      });
    } catch {
      // not a complete run directory
    }
  }
  return runs;
}

/** True when `pid` is alive and its command line is a companion helper. */
function isHelperProcess(pid: number): boolean {
  const row = listProcesses().find(r => r.pid === pid);
  return Boolean(row && /\bcompanion\b/.test(row.args));
}

export async function runCompanionStop(): Promise<number> {
  const runs = findRuns().filter(r => isHelperProcess(r.pid));
  if (runs.length === 0) {
    out("No companion helper is running for this account.");
    return 0;
  }
  for (const run of runs) {
    try {
      process.kill(run.pid, "SIGTERM");
    } catch {
      continue;
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && existsSync(run.runDir)) await delay(200);
    if (existsSync(run.runDir) && isHelperProcess(run.pid)) {
      // It did not stop in time: kill it; the watchdog then removes everything.
      try {
        process.kill(run.pid, "SIGKILL");
      } catch {
        // gone
      }
      const after = Date.now() + 5_000;
      while (Date.now() < after && existsSync(run.runDir)) await delay(200);
    }
    out(
      existsSync(run.runDir)
        ? `Helper ${run.pid}: stop requested; its run directory is still present.`
        : `Helper ${run.pid}: stopped.`
    );
  }
  return 0;
}

export function runCompanionStatus(): number {
  const runs = findRuns();
  const live = runs.filter(r => isHelperProcess(r.pid));
  if (live.length === 0) {
    out("No companion helper is running for this account.");
    return 0;
  }
  for (const run of live) {
    out(
      `Helper ${run.pid} · ${run.server} · listening on ${run.listenAddress}`
    );
    out(JSON.stringify(run.state, null, 2));
  }
  return 0;
}
