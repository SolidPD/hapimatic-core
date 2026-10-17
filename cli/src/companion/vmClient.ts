// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hapi companion pair|list|revoke|ssh|ssh-config` — the VM side of the
 * companion (issue #4352). Runs on the cloud VM, usually inside a Hapimatic
 * session, and talks to the local Hapimatic server with a JWT minted from the
 * instance's CLI token (`authenticateCli`).
 *
 * `ssh` generates a per-session Ed25519 key in the instance's data directory,
 * asks the server for a short-lived certificate (the bench must approve the
 * session first), and runs `ssh -F <generated config>` with a known-hosts file
 * that holds only the pinned helper host key. The generated config makes `ssh`
 * ignore the VM's own `~/.ssh/config` and agent.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import axios from "axios";
import {
  CompanionCertificateResultSchema,
  CompanionConfirmResultSchema,
  CompanionPairRequestInfoSchema,
  CompanionPairingsListSchema,
  principalForSession,
  type CompanionCertificateResult,
} from "@hapi/protocol/companion";
import { configuration } from "@/configuration";
import { authenticateCli } from "@/commands/cliAuth";
import { delay } from "@/utils/time";
import { generateOpenSshKeyPair } from "./sshKeys";

/** The `Host` alias in the generated ssh config. */
export const BENCH_ALIAS = "hapi-bench";

const out = (line: string) => process.stdout.write(`${line}\n`);

async function api<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const jwt = await authenticateCli();
  try {
    const res = await axios.request<T>({
      method,
      url: `${configuration.serverUrl}${path}`,
      data: body,
      headers: { authorization: `Bearer ${jwt}` },
      timeout: 15_000,
    });
    return res.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const data = error.response.data as
        | { error?: unknown; message?: unknown }
        | undefined;
      const code =
        typeof data?.error === "string"
          ? data.error
          : `http_${error.response.status}`;
      const message =
        typeof data?.message === "string" ? data.message : error.message;
      throw new Error(`${message} (${code})`);
    }
    throw error;
  }
}

async function askYesNo(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  return new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once("data", data => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(data.toString().trim()));
    });
  });
}

/** Confirm a code shown on the bench, after the user compares the host-key fingerprint. */
export async function runCompanionPair(
  code: string,
  yes: boolean
): Promise<number> {
  const info = CompanionPairRequestInfoSchema.parse(
    await api("POST", "/api/companion/pair-requests/lookup", { code })
  );
  out(`Bench machine:  ${info.hostname} (${info.os}/${info.arch})`);
  out(
    `Local account:  ${info.localUser} (${info.privilege === "admin" ? "administrator" : "standard user"})`
  );
  out(`Listens on:     ${info.listenAddress}`);
  out(`Host key:       ${info.hostKeyFingerprint}`);
  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "Compare the host-key fingerprint with the bench, then re-run with --yes.\n"
      );
      return 2;
    }
    if (!(await askYesNo("Does the bench show this host-key fingerprint?"))) {
      out("Not confirmed; nothing was paired.");
      return 1;
    }
  }
  const result = CompanionConfirmResultSchema.parse(
    await api("POST", "/api/companion/pair-requests/confirm", {
      code,
      hostKeyFingerprint: info.hostKeyFingerprint,
    })
  );
  out("");
  out(`Paired (pairing ${result.pairingId}).`);
  out(`CA fingerprint: ${result.caFingerprint}`);
  out("Confirm on the bench that the helper shows the same CA fingerprint.");
  return 0;
}

export async function runCompanionList(): Promise<number> {
  const list = CompanionPairingsListSchema.parse(
    await api("GET", "/api/companion/pairings")
  );
  if (list.pairings.length === 0 && list.pending.length === 0) {
    out("No bench machine is paired.");
    return 0;
  }
  for (const p of list.pairings) {
    out(
      `${p.pairingId}  ${p.state.padEnd(7)}  ${p.localUser}@${p.hostname} (${p.os})  ${p.listenAddress}`
    );
    if (p.endReason) out(`    ended: ${p.endReason}`);
    for (const s of p.principals) {
      const where = s.port ? `port ${s.port}` : "no instance";
      out(
        `    ${s.state.padEnd(9)} "${s.sessionLabel}" · ${where} · ${s.liveConnections} connection(s)${s.sources.length ? ` from ${s.sources.join(", ")}` : ""}`
      );
    }
  }
  for (const r of list.pending) {
    out(
      `pending  ${r.localUser}@${r.hostname} — waiting for its code (expires ${new Date(r.expiresAt).toLocaleTimeString()})`
    );
  }
  return 0;
}

export async function runCompanionRevoke(pairingId: string): Promise<number> {
  await api(
    "DELETE",
    `/api/companion/pairings/${encodeURIComponent(pairingId)}`
  );
  out(
    `Pairing ${pairingId} revoked; the bench helper tears down at its next heartbeat.`
  );
  return 0;
}

export type SshOptions = {
  pairingId?: string;
  session?: string;
  waitSeconds: number;
  sshArgs: string[];
  configOnly: boolean;
};

/** The per-session key directory under the instance's data directory. */
export function sessionKeyDir(baseDir: string, sessionId: string): string {
  return join(baseDir, "companion", "keys", principalForSession(sessionId));
}

/** Create (once) the session's Ed25519 key; returns its public-key line. */
export function ensureSessionKey(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const keyPath = join(dir, "id_ed25519");
  const pubPath = `${keyPath}.pub`;
  if (existsSync(keyPath) && existsSync(pubPath)) {
    return readFileSync(pubPath, "utf8").trim();
  }
  const { privateKey, publicKeyLine } =
    generateOpenSshKeyPair("hapi-companion");
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  writeFileSync(pubPath, `${publicKeyLine}\n`, { mode: 0o600 });
  return publicKeyLine;
}

/** The generated ssh client config; `-F` makes ssh ignore every other config file. */
export function renderClientConfig(
  dir: string,
  cert: Extract<CompanionCertificateResult, { state: "approved" }>
): string {
  return [
    `# Generated by hapi companion for pairing ${cert.pairingId}; refreshed by \`hapi companion ssh-config\`.`,
    `Host ${BENCH_ALIAS}`,
    `  HostName ${cert.host}`,
    `  Port ${cert.port}`,
    `  User ${cert.user}`,
    `  IdentityFile ${join(dir, "id_ed25519")}`,
    `  CertificateFile ${join(dir, "id_ed25519-cert.pub")}`,
    "  IdentitiesOnly yes",
    "  IdentityAgent none",
    `  HostKeyAlias ${BENCH_ALIAS}-${cert.pairingId}`,
    `  UserKnownHostsFile ${join(dir, "known_hosts")}`,
    "  GlobalKnownHostsFile /dev/null",
    "  StrictHostKeyChecking yes",
    "  UpdateHostKeys no",
    "  CheckHostIP no",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  ServerAliveInterval 15",
    "  ServerAliveCountMax 3",
    "",
  ].join("\n");
}

/** Get a certificate (waiting for the bench's approval) and write the ssh files. */
async function prepare(options: SshOptions): Promise<string | null> {
  const session = options.session ?? process.env.HAPI_SESSION_ID;
  if (!session) {
    process.stderr.write(
      "Run this inside a Hapimatic session, or pass --session <id>.\n"
    );
    return null;
  }
  const dir = sessionKeyDir(configuration.happyHomeDir, session);
  const publicKey = ensureSessionKey(dir);
  const deadline = Date.now() + options.waitSeconds * 1000;
  let announced = false;
  for (;;) {
    const result = CompanionCertificateResultSchema.parse(
      await api("POST", "/api/companion/certificates", {
        pairingId: options.pairingId,
        session,
        publicKey,
      })
    );
    if (result.state === "approved") {
      writeFileSync(
        join(dir, "id_ed25519-cert.pub"),
        `${result.certificate}\n`,
        { mode: 0o600 }
      );
      writeFileSync(
        join(dir, "known_hosts"),
        `${BENCH_ALIAS}-${result.pairingId} ${result.hostKey}\n`,
        { mode: 0o600 }
      );
      const configPath = join(dir, "ssh_config");
      writeFileSync(configPath, renderClientConfig(dir, result), {
        mode: 0o600,
      });
      return configPath;
    }
    if (result.state === "denied") {
      process.stderr.write(
        "The bench denied this session. Ask the bench user to restart the helper to try again.\n"
      );
      return null;
    }
    if (!announced) {
      // stderr: `ssh-config` prints only the config path on stdout, so
      // `cfg=$(hapi companion ssh-config)` captures the path alone.
      process.stderr.write(
        `Waiting for the bench to approve this session (${result.principal}). Approve it in the helper's terminal.\n`
      );
      announced = true;
    }
    if (Date.now() >= deadline) {
      process.stderr.write("Timed out waiting for approval on the bench.\n");
      return null;
    }
    await delay(2000);
  }
}

export async function runCompanionSsh(options: SshOptions): Promise<number> {
  const configPath = await prepare(options);
  if (!configPath) return 1;
  if (options.configOnly) {
    out(configPath);
    process.stderr.write(
      [
        `Valid for a few minutes; re-run to refresh. Use it with -F:`,
        `  ssh -F ${configPath} ${BENCH_ALIAS}`,
        `  scp -F ${configPath} ./file ${BENCH_ALIAS}:/tmp/`,
        `  ssh -F ${configPath} -N -L 8080:localhost:80 ${BENCH_ALIAS}`,
        "",
      ].join("\n")
    );
    return 0;
  }
  return new Promise(resolve => {
    const child = spawn(
      "ssh",
      ["-F", configPath, BENCH_ALIAS, ...options.sshArgs],
      {
        stdio: "inherit",
      }
    );
    child.once("error", error => {
      process.stderr.write(`Could not run ssh: ${error.message}\n`);
      resolve(1);
    });
    child.once("exit", code => resolve(code ?? 1));
  });
}
