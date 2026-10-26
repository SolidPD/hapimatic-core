// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The backup policy as the first-run backup step (#4791) states it — the ONE
 * place the app's backup copy lives.
 *
 * Every figure comes from the infrastructure that makes the backups, and
 * `backupPolicyCopy.test.ts` reads those files and fails when a figure here no
 * longer matches them. Change a source, and the test tells you which line of copy
 * to update. The one claim read from a document rather than from code is "the
 * bucket holds ciphertext only" (`README-backups-monitoring.md`).
 *
 * Sources (repo root):
 * - `infrastructure/cloud-vm/backup.timer.example` — `OnCalendar=*-*-* 03:00:00`,
 *   `RandomizedDelaySec=1800`, `Persistent=true`. The timer says "local time" and
 *   nothing in provisioning sets a timezone, so the copy names none.
 * - `infrastructure/cloud-vm/backup.sh` — `WEEKLY_DAY:-7` (`date +%u`, 7 = Sunday),
 *   the default `BACKUP_SETS`, and the `db` set: a `sqlite3 .backup` snapshot of
 *   the stores in `DB_SET_STORES` (hapi.db, telemetry.db, provisioner-audit.sqlite
 *   — #4534), so those files are never copied raw. scorecard.db is excluded and
 *   snapshotted nowhere until #4225 removes it.
 * - `infrastructure/cloud-vm/backup-exclude.list` — `.credentials.json` is never
 *   in any set. That is all the copy claims: Hapimatic's account store
 *   (`~/.hapimatic-private/accounts/`) IS in the default set, and holds a copied
 *   token on operator VMs and on instances set up before in-VM sign-in
 *   (`docs/cloud-consent-data-handling.md`, "What is backed up").
 * - `scripts/lib/provision-helpers.sh` — the bucket lifecycle rules each VM gets
 *   at provisioning: `daily/` objects deleted after 8 days, `weekly/` after 29.
 *   The buckets are versioned and keep a deleted object's previous version for 30
 *   more days, but a restore reads current objects only, so the copy says how long
 *   a copy "can be restored", not when it is erased.
 * - `infrastructure/cloud-vm/README-backups-monitoring.md` — every set is
 *   `age`-encrypted on the VM before upload, so the bucket holds ciphertext only.
 * - `infrastructure/cloud-vm/restore-backup.sh` — a restore reads the identity
 *   file as-is (`age -d -i`).
 */

/** The facts the copy is built from; the test binds each one to its source. */
export const BACKUP_POLICY_FACTS = {
  /** `backup.timer.example` `OnCalendar=*-*-* 03:00:00`. */
  nightlyHour: 3,
  /** `backup.timer.example` `RandomizedDelaySec=1800`. */
  jitterMinutes: 30,
  /** `backup.timer.example` `Persistent=true` — a missed run catches up. */
  catchesUp: true,
  /** `backup.sh` `WEEKLY_DAY:-7`, `date +%u` → 7 = Sunday. */
  weeklyDay: "Sunday",
  /** `provision-helpers.sh` `timeAmount:8` on the `daily/` prefix. */
  dailyRetentionDays: 8,
  /** `provision-helpers.sh` `timeAmount:29` on the `weekly/` prefix. */
  weeklyRetentionDays: 29,
  /** `backup.sh` default `BACKUP_SETS` — the folders under your home folder. */
  folders: ["~/.hapimatic-private", "~/.claude", "~/projects"],
} as const;

const f = BACKUP_POLICY_FACTS;
const folderList = `${f.folders.slice(0, -1).join(", ")} and ${f.folders.at(-1)}`;

/** One line per policy question, in the order the step shows them. */
export const BACKUP_POLICY_LINES = {
  what:
    `Your Hapimatic databases, plus the ${folderList} folders. ` +
    "Your Claude credentials files (.credentials.json) are never backed up.",
  when:
    `Every night at about ${f.nightlyHour}:00 on the server's clock, plus up to ` +
    `${f.jitterMinutes} minutes; a missed night runs when the server is back. ` +
    `Each ${f.weeklyDay}'s copy is also kept as a weekly copy.`,
  howLong:
    `Nightly copies can be restored for ${f.dailyRetentionDays} days and ` +
    `weekly copies for ${f.weeklyRetentionDays} days.`,
  where:
    "Each copy is encrypted on this instance before it is uploaded to Oracle " +
    "Cloud Object Storage, so the storage holds only encrypted data.",
  loss:
    "Without your backup key, nobody can restore your existing backups, " +
    "including us. There is no recovery.",
} as const;

/** The short version the step shows up front; Learn more holds the full lines. */
export const BACKUP_POLICY_SUMMARY =
  `Backed up every night at about ${f.nightlyHour}:00 on the server's clock, ` +
  `with a weekly copy each ${f.weeklyDay}. Nightly copies can be restored for ` +
  `${f.dailyRetentionDays} days and weekly copies for ${f.weeklyRetentionDays} ` +
  "days, all encrypted before they leave this instance.";

/** The labels the step shows beside each policy line. */
export const BACKUP_POLICY_LABELS: Record<
  keyof typeof BACKUP_POLICY_LINES,
  string
> = {
  what: "What",
  when: "When",
  howLong: "How long",
  where: "Where",
  loss: "If you lose the key",
};

/** The Learn more note about the saved file (restore reads it as-is). */
export const BACKUP_KEY_FILE_NOTE =
  "A restore reads the key file exactly as you saved it, so keep the whole " +
  "file, including its first comment line.";

/**
 * The skip line (#4791 R4, LC4 verbatim; re-anchored to Preferences when #4906
 * retired the Keys page). Nothing is acknowledged on skip, so the reveal there
 * still works.
 */
export const BACKUP_SKIP_LINE =
  "You can save it later in Settings → Preferences → Backup Key.";

/** The Model C passphrase page (the gateway's, linked — never called). */
export const BACKUP_PASSPHRASE_URL = "https://hapimatic.com/backup-passphrase";

/** Public FAQ section with the same policy (docs/guide/faq.md `#backups`). */
export const BACKUP_POLICY_DOCS_URL =
  "https://hapimatic.com/docs/guide/faq#backups";

/**
 * Model C variant (#4791 R5). Hedged on purpose: the status cannot tell a
 * passphrase-protected VM from a VM whose pending key file vanished, so the copy
 * asserts nothing about which one this is (#4849 adds the custody marker). The
 * last sentence follows `NO_RECOVERY_WARNING` in
 * `gateway/src/lib/backupPassphraseCopy.ts` (the web cannot import gateway code).
 */
export const BACKUP_NO_KEY_COPY = {
  heading: "No backup key to save here",
  lead:
    "This instance has no backup key to save here. If you set a backup " +
    "passphrase on hapimatic.com, it protects your backups.",
  noRecovery:
    "There is no recovery. If you forget that passphrase, all existing " +
    "backups become permanently unrecoverable.",
  link: "Manage backup passphrase",
} as const;
