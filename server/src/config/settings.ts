// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { StoredApiKey } from "@hapi/protocol/schemas";

export interface Settings {
  machineId?: string;
  machineIdConfirmedByServer?: boolean;
  daemonAutoStartWhenRunningHappy?: boolean;
  cliApiToken?: string;
  /** Issue #1955: node-local provider API keys (the secrets-vault store). Holds
   *  plaintext secrets at rest — settings.json is written 0600 (see writeSettings).
   *  Returned only as RedactedApiKey over the HTTP API (never the raw `key`).
   *  Both Settings interfaces (server + CLI) round-trip this field. */
  apiKeys?: StoredApiKey[];
  // #1805: user-settable spawn-concurrency cap. The SERVER is the sole writer
  // of this key (via config/maxConcurrency.ts); the daemon reads it at the
  // spawn gate. Separate interface from the CLI's, but the JSON round-trips
  // because neither side strips unknown keys (KD-2).
  maxConcurrentSessions?: number;
  vapidKeys?: {
    publicKey: string;
    privateKey: string;
  };
  /**
   * Issue #2341 (Config Porter epic #2339, Sub B): the instance-held age keypair
   * used to encrypt secret-bearing porter-manifest fields TO this instance.
   *
   * `identity` is the age SECRET key (`AGE-SECRET-KEY-1…`). It is written at rest
   * in settings.json (0600 — see writeSettings) and MUST NEVER leave the process:
   * `server/src/config/porterAgeKeys.ts` is the only module that reads it, it is
   * never returned over the HTTP API, and it is never logged. Only `recipient`
   * (the public `age1…` key) is published, via `GET /api/porter/recipient`.
   *
   * ⚠️ Custody is INVERTED relative to the provisioning backup keypair: the
   * provisioning identity is user-held OFF the host, while this identity is
   * instance-held. The two must never be conflated — see
   * `docs/internal/architecture/cloud-provisioning.md` (§ two age keypairs) and
   * `docs/internal/architecture/config-porter-encryption.md`.
   */
  porterAgeKeys?: {
    recipient: string;
    identity: string;
  };
  /**
   * Issue #2507: the reveal MARKER for the per-VM backup age identity (cloud-VM
   * custody). ⚠️ Unlike `porterAgeKeys`, this NEVER stores the secret identity —
   * only whether it has been revealed-and-acknowledged, plus the PUBLIC recipient.
   *
   * The transient secret identity lives at `~/.config/hapimatic/age-identity.pending.txt`
   * (0600), is served to the authenticated user exactly once, and is shredded from
   * the VM on acknowledgement (`server/src/config/backupAgeIdentity.ts`). It is
   * deliberately NOT stored here because settings.json is inside the `.hapimatic-private`
   * backup set (`backup.sh:108`) — a pending identity here would be captured by a
   * nightly backup before the user ever saves it, and be circular for disaster recovery.
   *
   * ⚠️ Custody is INVERTED relative to `porterAgeKeys`: the porter identity is
   * instance-held and never leaves the process; this backup identity is user-held
   * and must ESCAPE the VM (it is the sole means of decrypting the user's off-VM
   * backups after the VM is lost + re-provisioned — the one-time reveal IS that
   * escape mechanism). The two keypairs must never be conflated — see
   * `docs/internal/architecture/cloud-provisioning.md` (§ two age keypairs).
   */
  backupAgeIdentity?: {
    revealed: boolean;
    recipient?: string;
  };
  // Server configuration (persisted from environment variables)
  telegramBotToken?: string;
  /** Issue #1003: Google SSO handoff-token shared secret (HS256). */
  googleHandoffSecret?: string;
  webappPort?: number;
  webappUrl?: string;
  corsOrigins?: string[];
  /** Issue #4371: in-app support escalation (non-credential values only — the
   *  channel credentials stay in env). See `resolveSupportChannel`. */
  supportEscalation?: {
    hoursText?: string;
    issueUrl?: string;
    telegramChatId?: string;
    channel?: string;
  };
  /** Federation configuration for distributed cluster */
  federation?: {
    enabled?: boolean;
    role?: "hub" | "node" | "peer";
    nodeId?: string;
    nodeLabel?: string;
    nodes?: Array<{ id: string; label: string; url: string }>;
    pollIntervalMs?: number;
    apiToken?: string;
    selfUrl?: string;
    seedPeers?: string[];
    announceIntervalMs?: number;
    /** Absolute path to vanilla Claude CLI on this node (issue #933) */
    claudePath?: string;
    /** Per-node opt-out for the turn-ledger mirror pull loop (issue #4614). */
    turnMirrorDisabled?: boolean;
  };
}

export function getSettingsFile(dataDir: string): string {
  return join(dataDir, "settings.json");
}

/**
 * Read settings from file, preserving all existing fields.
 * Returns null if file exists but cannot be parsed (to avoid data loss).
 */
export async function readSettings(
  settingsFile: string
): Promise<Settings | null> {
  if (!existsSync(settingsFile)) {
    return {};
  }
  try {
    const content = await readFile(settingsFile, "utf8");
    return JSON.parse(content);
  } catch (error) {
    // Return null to signal parse error - caller should not overwrite
    console.error(`[WARN] Failed to parse ${settingsFile}: ${error}`);
    return null;
  }
}

export async function readSettingsOrThrow(
  settingsFile: string
): Promise<Settings> {
  const settings = await readSettings(settingsFile);
  if (settings === null) {
    throw new Error(
      `Cannot read ${settingsFile}. Please fix or remove the file and restart.`
    );
  }
  return settings;
}

/**
 * Write settings to file atomically (temp file + rename)
 */
export async function writeSettings(
  settingsFile: string,
  settings: Settings
): Promise<void> {
  const dir = dirname(settingsFile);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  // #2623 (PM-authorized in-path fix): a UNIQUE per-write temp filename, matching
  // the codebase's atomic-write convention (accountService/accountStore/
  // mcpConfigStore all use `${path}.tmp.${pid}.${randomUUID()}`). The prior FIXED
  // `settingsFile + ".tmp"` was a concurrent-write hazard: two near-simultaneous
  // writers — e.g. two preference PUTs handled by the SAME server process in one
  // tick — collided on the one temp path, interleaving their writes and producing
  // a TRUNCATED, invalid settings.json (readSettings then fails-to-null and every
  // preference silently fails-to-default). A unique suffix makes each writer's
  // temp independent so the atomic rename always lands a COMPLETE file; the only
  // residual under a race is a benign last-write-wins (accepted for these prefs).
  // pid/timestamp alone are NOT unique enough — same process + same-ms writes
  // would still collide — hence the randomUUID.
  const tmpFile = `${settingsFile}.tmp.${process.pid}.${randomUUID()}`;
  // Issue #1955: settings.json holds provider secrets (apiKeys[], openRouterApiKey,
  // cliApiToken) — write owner-only. The 0600 mode set on the temp file is
  // preserved by rename; the chmod after is umask-defense (mirrors the CLI
  // writer at cli/src/persistence.ts). Closes a latent perms-downgrade where the
  // server's prior mode-less write reset the 0600 the CLI had set.
  await writeFile(tmpFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(tmpFile, settingsFile);
  await chmod(settingsFile, 0o600).catch(() => {});
}

/**
 * Thrown by {@link updateSettings} when `settings.json` exists but cannot be read
 * or parsed (issue #4463 Task 1, the contract #4056 Task 1 specifies). The message
 * is FIXED and built from nothing but the constant text: a JSON parse message can
 * quote file content, and this file holds provider keys and tokens (#4168, #4056 R4).
 * The path rides `settingsFile` for the caller's log line; HTTP bodies stay generic.
 */
export class SettingsUnreadableError extends Error {
  readonly settingsFile: string;

  constructor(settingsFile: string) {
    super("Settings file is unreadable; refusing to overwrite");
    this.name = "SettingsUnreadableError";
    this.settingsFile = settingsFile;
  }
}

/** Per-file tail of the in-process write chain (see {@link updateSettings}). */
const settingsWriteChains = new Map<string, Promise<unknown>>();

/**
 * The one sanctioned read-modify-write of `settings.json` (issue #4463 Task 1;
 * #4056 Task 1 specifies the same helper and #4365 later puts the CLI's
 * cross-process lock inside it).
 *
 * - A missing file reads as `{}`; an unreadable or non-object file throws
 *   {@link SettingsUnreadableError} and writes nothing.
 * - Calls are serialized per file through an in-process promise chain (the
 *   `settingsSyncService.ts` idiom), so two writers never interleave a stale read
 *   with a newer write — the #4463 X5 lost-update class.
 * - `mutate` MUST be synchronous and free of I/O: the chain is held for its whole
 *   run. Network probes and account-store writes happen before or after the call.
 * - When `mutate` returns `current` itself (an unchanged copy — "not found",
 *   "duplicate"), nothing is written, so a refusal leaves the file byte-identical.
 *
 * Resolves to the settings now on disk.
 */
export function updateSettings(
  settingsFile: string,
  mutate: (current: Settings) => Settings
): Promise<Settings> {
  const previous = settingsWriteChains.get(settingsFile) ?? Promise.resolve();
  const run = previous
    .catch(() => {
      // A failed earlier write must not block the ones queued behind it.
    })
    .then(async () => {
      const current = await readSettings(settingsFile);
      if (
        current === null ||
        typeof current !== "object" ||
        Array.isArray(current)
      ) {
        throw new SettingsUnreadableError(settingsFile);
      }
      const next = mutate(current);
      if (next === current) return current;
      await writeSettings(settingsFile, next);
      return next;
    });
  settingsWriteChains.set(settingsFile, run);
  // Drop the map entry once this call is the tail, so idle files hold no promise.
  void run
    .catch(() => {})
    .then(() => {
      if (settingsWriteChains.get(settingsFile) === run) {
        settingsWriteChains.delete(settingsFile);
      }
    });
  return run;
}
