// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings, type Settings } from "./settings";

/**
 * Per-VM backup `age` identity — one-time authenticated reveal + consume
 * (issue #2507, epic #2493).
 *
 * This module mirrors the CODE SHAPE of `porterAgeKeys.ts` but INVERTS its
 * lifecycle. The porter identity is instance-held and retained forever; the
 * backup identity is USER-held and must ESCAPE the VM exactly once, then be
 * deleted from the VM — because backups exist for disaster recovery *after* the
 * VM is destroyed and re-provisioned, so an identity that only ever lived on the
 * VM would make every off-VM backup permanently undecryptable on VM loss. The
 * one-time reveal IS that escape mechanism.
 *
 * Custody split (do NOT conflate the two keypairs):
 * - `porterAgeKeys` — instance-held, never leaves the process, stored (secret +
 *   public) in `settings.porterAgeKeys`.
 * - backup identity (here) — user-held; the SECRET lives ONLY in a transient
 *   file at `~/.config/hapimatic/age-identity.pending.txt` (0600) that the VM's
 *   provisioning keygen wrote (KD-1 = A: born on the VM, never on RP1); it is
 *   served to the authenticated user once and shredded from the VM on ack.
 *   settings.json holds ONLY the non-secret `{ revealed, recipient }` marker
 *   (see `settings.ts` — the secret is deliberately NOT in settings.json because
 *   settings.json is inside the nightly backup set).
 *
 * 🔴 The SECRET identity is NEVER logged, never returned in an error message, and
 *    never persisted to settings.json. It crosses the wire exactly once, in the
 *    single successful reveal response body.
 *
 * DISPOSITION under ADR-0005 Model C (issue #2509, ruling 4a): this reveal-once
 * path is RETAINED, scoped to (a) the gateway-bearing host — whose `gateway-db`
 * set deliberately stays Model A with an operator-held identity, breaking the
 * circular-DR loop (finding 2509-a) — and (b) VMs provisioned before Model-C
 * enrollment. A Model-C-enrolled user VM never has a pending identity here (the
 * keypair is born on the GATEWAY at passphrase enrollment and stored only
 * passphrase+KMS-wrapped), so `getBackupIdentityStatus` naturally reports
 * nothing to reveal. Do not remove this module: it is the break-glass mechanism
 * ruling 4a depends on (docs/internal/decisions/adr-0005-*.md).
 */

/**
 * File locations this module reads/writes. Injected (rather than hard-coded) so
 * tests can point at a temp dir instead of the real `~/.config/hapimatic/`.
 * On a live cloud VM the server runs as the `hapimatic` user, so
 * {@link defaultBackupIdentityPaths} resolves these under that user's home.
 */
export type BackupIdentityPaths = {
  /** settings.json — holds the non-secret `{ revealed, recipient }` marker only. */
  settingsFile: string;
  /** The transient secret identity the VM keygen wrote (0600); shredded on ack. */
  pendingIdentityFile: string;
  /** The public `age1…` recipient the VM keygen wrote (0644). */
  recipientFile: string;
};

/**
 * Resolve the production paths from a settings file. The pending identity and
 * recipient live under `~/.config/hapimatic/` — deliberately NOT under HAPI_HOME
 * / next to settings.json — because `~/.config/hapimatic/` is not one of the
 * backup sets (`backup.sh:108` backs up `.hapimatic-private .claude projects`),
 * so a pending identity there is never captured by a nightly backup before the
 * user acknowledges it.
 */
export function defaultBackupIdentityPaths(
  settingsFile: string
): BackupIdentityPaths {
  const configDir = join(homedir(), ".config", "hapimatic");
  return {
    settingsFile,
    pendingIdentityFile: join(configDir, "age-identity.pending.txt"),
    recipientFile: join(configDir, "age-recipient.txt"),
  };
}

/** Non-secret status of the backup identity — safe to return over the HTTP API. */
export type BackupIdentityStatus = {
  /** An unacknowledged identity is present on the VM and available to reveal. */
  present: boolean;
  /** The identity was revealed AND acknowledged (and thus deleted from the VM). */
  revealed: boolean;
  /** The public `age1…` recipient, or null if not yet generated. Never the secret. */
  recipient: string | null;
};

/**
 * The reveal outcome. A discriminated union rather than a thrown error, so the
 * SECRET identity can never accidentally ride an exception message (a thrown
 * `Error(identity)` would be logged by the global error handler).
 */
export type RevealResult =
  | { status: "revealed"; identity: string }
  | { status: "gone" } // already acknowledged → the route returns 410
  | { status: "none" }; // nothing pending, never generated → the route returns 404

/** Read the public recipient file; null if absent or empty. Never throws. */
async function readRecipient(recipientFile: string): Promise<string | null> {
  try {
    const raw = (await readFile(recipientFile, "utf8")).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Non-secret status of the backup identity.
 *
 * 🔴 R6 invariant: the PENDING FILE's existence — not the settings marker — is
 * the authoritative "unacknowledged" signal, because {@link acknowledgeBackupIdentity}
 * is the ONLY thing that deletes it. A disaster-recovery re-provision that mints a
 * fresh keypair writes a fresh pending file, which forces `present:true` /
 * `revealed:false` even if a stale `{ revealed:true }` marker somehow survived — so
 * a new keypair ALWAYS surfaces a fresh reveal and never silently auto-acknowledges
 * (which would leave those new backups undecryptable).
 */
export async function getBackupIdentityStatus(
  paths: BackupIdentityPaths
): Promise<BackupIdentityStatus> {
  const settings = await readSettings(paths.settingsFile);
  const marker = settings?.backupAgeIdentity;
  const pendingExists = existsSync(paths.pendingIdentityFile);
  const revealed = !pendingExists && marker?.revealed === true;
  const recipient =
    marker?.recipient ?? (await readRecipient(paths.recipientFile));
  return { present: pendingExists, revealed, recipient };
}

/**
 * Serve the secret identity while it is still pending (present and not yet
 * acknowledged). Repeatable UNTIL acknowledgement — so a user who navigates away
 * before saving can re-open the reveal; {@link acknowledgeBackupIdentity} is the
 * one-way point of no return. Returns the FULL age identity file (comment header +
 * `AGE-SECRET-KEY-1…` line) so the user can save it and later decrypt with
 * `age -i <saved-file>` / restore-backup.sh's `AGE_IDENTITY`.
 *
 * 🔴 The secret is returned ONLY via the `{ status:"revealed", identity }` value —
 *    never logged, never placed in an error.
 */
export async function revealBackupIdentityOnce(
  paths: BackupIdentityPaths
): Promise<RevealResult> {
  if (existsSync(paths.pendingIdentityFile)) {
    const identity = (await readFile(paths.pendingIdentityFile, "utf8")).trim();
    // A zero-byte pending file is a broken generation — treat as "none" (a
    // 404 the UI can surface), never as an empty successful reveal.
    if (identity.length > 0) return { status: "revealed", identity };
    return { status: "none" };
  }
  // No pending file: distinguish acknowledged-and-deleted (gone → 410) from
  // never-generated (none → 404) via the persisted marker.
  const settings = await readSettings(paths.settingsFile);
  if (settings?.backupAgeIdentity?.revealed === true) return { status: "gone" };
  return { status: "none" };
}

/**
 * Acknowledge the reveal: shred + delete the transient identity from the VM and
 * persist the non-secret `{ revealed:true, recipient }` marker so it can never be
 * re-served (R4). Idempotent — safe to call again after the file is already gone
 * (a double-click or retry).
 */
export async function acknowledgeBackupIdentity(
  paths: BackupIdentityPaths
): Promise<void> {
  const settings = await readSettings(paths.settingsFile);
  // Refuse to overwrite an unparseable settings file — clobbering it would strand
  // the porter identity and every other at-rest secret (mirrors apiKeys.ts).
  if (settings === null) {
    throw new Error("Settings file is unreadable; refusing to overwrite");
  }
  // Persist the PUBLIC recipient in the marker: prefer an existing marker value,
  // else the on-disk recipient file. Never derived from the secret identity here.
  const recipient =
    settings.backupAgeIdentity?.recipient ??
    (await readRecipient(paths.recipientFile));
  await shredAndRemove(paths.pendingIdentityFile);
  const next: Settings = {
    ...settings,
    backupAgeIdentity: { revealed: true, ...(recipient ? { recipient } : {}) },
  };
  await writeSettings(paths.settingsFile, next);
}

/**
 * Best-effort shred: overwrite the file with zeros of the same length, then
 * remove it. This is NOT a cryptographic-erasure guarantee on a journaling / CoW
 * filesystem (the write may land in a new block), but it shrinks the window in
 * which the raw key sits in a recoverable inode after unlink. Idempotent — a
 * missing / unstattable file is a no-op, then `rm --force` completes cleanly.
 */
async function shredAndRemove(file: string): Promise<void> {
  try {
    const info = await stat(file);
    if (info.isFile() && info.size > 0) {
      await writeFile(file, Buffer.alloc(info.size, 0));
    }
  } catch {
    // Already gone / unstattable — nothing to overwrite.
  }
  await rm(file, { force: true });
}
