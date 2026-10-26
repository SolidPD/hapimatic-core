// SPDX-License-Identifier: AGPL-3.0-only
import {
  Decrypter,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";
import { readSettingsOrThrow, writeSettings, type Settings } from "./settings";

/**
 * The instance-held Configuration Porter age keypair (issue #2341, epic #2339).
 *
 * `recipient` is the PUBLIC `age1…` key; `identity` is the SECRET
 * `AGE-SECRET-KEY-1…` key. Callers OUTSIDE this module must never receive the
 * full object — the R1 guarantee ("the identity never leaves the instance") is
 * enforced by MODULE SHAPE: this type is produced only by the module-private
 * {@link getOrCreatePorterAgeKeys} and {@link readPorterAgeKeys}, and the
 * exported surface is limited to {@link getPorterRecipient} /
 * {@link readPorterRecipient} (the public half only), {@link ensurePorterAgeKeys}
 * (a status, never key material) and {@link decryptPorterArchive} (uses the
 * identity strictly in-process, never returning or logging it).
 *
 * #5170: no request path generates the keypair. `web/server.ts` calls
 * {@link ensurePorterAgeKeys} before the server listens, on an exposed instance
 * only; the recipient routes and {@link decryptPorterArchive} read it
 * read-only. {@link getPorterRecipient} (generate-on-first-call) remains for
 * tests, and `web/porterExposure.test.ts` keeps both generating calls out of
 * every other module.
 */
export type PorterAgeKeys = {
  recipient: string;
  identity: string;
};

/**
 * Per-`settingsFile` in-flight generation promise (concurrency guard).
 *
 * Two concurrent first-touch requests on a brand-new instance would otherwise
 * EACH generate a distinct keypair, and the last `writeSettings` to land would
 * strand the other — leaving a caller holding a published `recipient` whose
 * matching `identity` is no longer on disk. Archives encrypted to that stranded
 * recipient then become permanently undecryptable, which is one of the two
 * named catastrophic failure modes for this issue. Sharing the in-flight promise
 * makes the generate-once atomic per settings file. The entry is cleared once
 * resolved, so subsequent calls re-read the persisted keypair from disk
 * (preserving generate-once / read-back semantics for tests and steady state).
 *
 * This targets the porter-specific dual-keygen race only. The broader
 * read-whole/modify/write-whole race on settings.json (shared by every
 * `getOrCreateSettingsValue` writer) is a pre-existing codebase property and is
 * out of scope here.
 */
const inflight = new Map<string, Promise<PorterAgeKeys>>();

/**
 * Generate-once / persist / read-back of the instance porter keypair, stored
 * under the dedicated `porterAgeKeys` key in settings.json (R1, R7). Mirrors the
 * `getOrCreateVapidKeys` lifecycle (`server/src/config/vapidKeys.ts`) but is
 * hand-rolled async because age key generation is asynchronous and
 * `getOrCreateSettingsValue`'s `generate` callback is synchronous, so it cannot
 * host the keygen.
 *
 * MODULE-PRIVATE by design: the returned object carries the SECRET identity, so
 * exporting it would let an external caller obtain the identity and defeat R1.
 * External code uses {@link getPorterRecipient} or {@link decryptPorterArchive}.
 *
 * D3/R7 — persisted under the `porterAgeKeys` settings key, deliberately NOT at
 * `~/.config/hapimatic/age-recipient.txt` (the provisioning reconcile surface),
 * so the porter key can never clobber, or be clobbered by, the provisioning
 * backup recipient. Owner-only permissions (dir `0700`, file `0600`) come from
 * `writeSettings`; this module adds no bespoke permission handling.
 */
async function getOrCreatePorterAgeKeys(
  settingsFile: string
): Promise<PorterAgeKeys> {
  const pending = inflight.get(settingsFile);
  if (pending) return pending;

  const task = (async (): Promise<PorterAgeKeys> => {
    const settings: Settings = await readSettingsOrThrow(settingsFile);
    if (settings.porterAgeKeys?.recipient && settings.porterAgeKeys?.identity) {
      return {
        recipient: settings.porterAgeKeys.recipient,
        identity: settings.porterAgeKeys.identity,
      };
    }
    // R3 wire-compatibility: use generateX25519Identity (NOT generateIdentity),
    // so the published recipient is always a classic `age1…` X25519 key. The
    // source machine encrypts to it with the system `age` CLI, whose classic
    // builds do not understand the post-quantum `age1pq1…` recipients that a
    // future generateIdentity() is documented to possibly emit.
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const keys: PorterAgeKeys = { recipient, identity };
    settings.porterAgeKeys = keys;
    await writeSettings(settingsFile, settings);
    return keys;
  })();

  inflight.set(settingsFile, task);
  try {
    return await task;
  } finally {
    inflight.delete(settingsFile);
  }
}

/**
 * The persisted keypair, or `null` when either half is missing — a recipient
 * with no identity behind it would publish a key nothing can decrypt (see
 * {@link inflight}). Never writes.
 */
async function readPorterAgeKeys(
  settingsFile: string
): Promise<PorterAgeKeys | null> {
  const settings = await readSettingsOrThrow(settingsFile);
  const keys = settings.porterAgeKeys;
  if (keys?.recipient && keys?.identity) {
    return { recipient: keys.recipient, identity: keys.identity };
  }
  return null;
}

/**
 * The instance's PUBLIC `age1…` recipient, or `null` when no keypair exists.
 * Read-only: the recipient routes use this so no request writes
 * `settings.json` (#5170).
 */
export async function readPorterRecipient(
  settingsFile: string
): Promise<string | null> {
  const keys = await readPorterAgeKeys(settingsFile);
  return keys?.recipient ?? null;
}

/**
 * Generate the keypair if it is missing (#5170). Policy-free — the caller
 * decides whether Porter is exposed. Reads the file back after generating and
 * throws when the pair did not persist (another process's settings write can
 * drop it), so a loss is reported rather than silent. Returns a status only.
 */
export async function ensurePorterAgeKeys(
  settingsFile: string
): Promise<"present" | "generated"> {
  if (await readPorterAgeKeys(settingsFile)) return "present";
  await getOrCreatePorterAgeKeys(settingsFile);
  if (!(await readPorterAgeKeys(settingsFile))) {
    throw new Error("The Porter keypair did not persist to settings.json");
  }
  return "generated";
}

/**
 * The instance's PUBLIC `age1…` recipient key (R2). Generates the keypair on
 * first call (see {@link getOrCreatePorterAgeKeys}) and returns ONLY the public
 * half — the secret identity is never exposed through this accessor. Sub C
 * (#2342) reads this via `GET /api/porter/recipient` to embed the recipient in
 * the generated extraction prompt.
 */
export async function getPorterRecipient(
  settingsFile: string
): Promise<string> {
  const keys = await getOrCreatePorterAgeKeys(settingsFile);
  return keys.recipient;
}

/** {@link decryptPorterArchive}'s error when this instance has no keypair. */
export const PORTER_KEY_MISSING =
  "This instance has no Configuration Porter key; restart the server to generate it.";

/**
 * Decrypt a porter secrets archive (`secrets.age`) that was encrypted TO this
 * instance's recipient, returning the plaintext bytes IN-PROCESS.
 *
 * This is the only decryption path, and it lives here BY DESIGN: the age
 * identity never leaves this module (R1), so decryption — which needs the
 * identity — must happen here. The plaintext exists only as an in-process
 * buffer; it is NEVER written to disk, and no secret value (identity or
 * plaintext) is ever logged, added to a Sentry breadcrumb, or interpolated into
 * an error message by this function. The underlying `Decrypter`'s errors carry
 * no key material, but they CAN carry archive content: a member that is not
 * age-encrypted fails with `invalid version <its first line>`, which for a
 * plaintext bundle is the secret text itself (#5543). Callers must therefore
 * never surface a thrown message — map it to a fixed reason with
 * `decryptFailureReason` (`../porter/secretBundle`).
 *
 * R4 note: the ENCRYPTION side is a local shell command on the SOURCE machine
 * (`age -r <recipient> -o secrets.age secrets.json`; see
 * `docs/internal/architecture/config-porter-encryption.md`). No model
 * participates in this server-side decrypt — which is exactly why D2 uses a
 * pure-JS age implementation here rather than shelling out to the `age` binary.
 *
 * #5170: reads the keypair read-only. Generating one here could never decrypt
 * anything (nothing was encrypted to a key that did not exist) and was a
 * `settings.json` write reachable from the public upload leg.
 */
export async function decryptPorterArchive(
  settingsFile: string,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const keys = await readPorterAgeKeys(settingsFile);
  if (!keys) {
    throw new Error(PORTER_KEY_MISSING);
  }
  const decrypter = new Decrypter();
  decrypter.addIdentity(keys.identity);
  return decrypter.decrypt(ciphertext, "uint8array");
}
