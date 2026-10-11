// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-VM backup age identity types (issue #2507, epic #2493).
 *
 * The `status` surface is non-secret. The revealed `identity` is the ONLY secret
 * value and is returned exactly once, from `POST /api/backup/identity/reveal` —
 * it is never cached in TanStack Query (treated as fire-once) and never appears
 * in `status`.
 */

/** Non-secret status of the backup identity (`GET /api/backup/identity/status`). */
export type BackupIdentityStatus = {
  /** An unacknowledged identity is present on the VM and available to reveal. */
  present: boolean;
  /** The identity was revealed AND acknowledged (and thus deleted from the VM). */
  revealed: boolean;
  /** The public `age1…` recipient, or null if not yet generated. Never the secret. */
  recipient: string | null;
};

/** The one-time reveal response (`POST /api/backup/identity/reveal`). */
export type BackupIdentityRevealResponse = {
  /** The full age identity file (comment header + `AGE-SECRET-KEY-1…` line). */
  identity: string;
};
