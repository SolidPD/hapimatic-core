// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — schema-version and archive-format constants
 * (epic #2339, Sub-Issue A, issue #2340).
 *
 * This file is the canonical source for the porter manifest's version. An
 * archive's `manifest.json` declares the `schemaVersion` it targets; the import
 * validator (#2343) and the extraction-prompt generator (#2342) both read
 * {@link SUPPORTED_PORTER_SCHEMA_VERSIONS} from here rather than hard-coding a
 * literal string, so "which versions this instance accepts" has ONE authority.
 *
 * Compatibility rule: a MAJOR bump is the compatibility break. The extraction
 * prompt pins the exact schema version it targets, and an archive whose
 * `schemaVersion` is not in {@link SUPPORTED_PORTER_SCHEMA_VERSIONS} is rejected
 * whole at import (R1) — never partially applied. This versioning is the named
 * mitigation for cross-Claude-version extraction drift: a prompt-produced
 * archive that drifts across `claude` releases fails the version check loudly
 * instead of importing an inconsistent subset.
 *
 * Kept zod-only / Node-free (R7) so the whole `@hapi/protocol/porter` module can
 * be bundled for the browser (#2344 validates archives client-side).
 */

/** The current porter manifest schema version. Narrowed via `as const`. */
export const PORTER_SCHEMA_VERSION = "1.0.0" as const;

/** Narrow literal type of {@link PORTER_SCHEMA_VERSION} (`"1.0.0"`). */
export type PorterSchemaVersion = typeof PORTER_SCHEMA_VERSION;

/**
 * The schema versions this instance can import. The import validator (#2343)
 * rejects any `schemaVersion` outside this list with a version-mismatch error
 * BEFORE field validation runs (R1). Widen this tuple only when a new version
 * is genuinely importable — never to paper over a mismatch.
 */
export const SUPPORTED_PORTER_SCHEMA_VERSIONS = ["1.0.0"] as const;

/**
 * A schema version the instance accepts (element of
 * {@link SUPPORTED_PORTER_SCHEMA_VERSIONS}).
 */
export type SupportedPorterSchemaVersion =
  (typeof SUPPORTED_PORTER_SCHEMA_VERSIONS)[number];

/**
 * The archive container format. Decided in the archive-layout doc
 * (`docs/internal/architecture/config-porter-archive.md`): gzip-compressed POSIX
 * tar — universally present for a shell-driven external producer (R5), with
 * consistent symlink/mode semantics for #2343's extraction security tests.
 * Re-exported by the barrel so #2341/#2342/#2343 import it rather than repeating
 * the literal.
 */
export const ARCHIVE_FORMAT = "tar.gz" as const;

/** Narrow literal type of {@link ARCHIVE_FORMAT} (`"tar.gz"`). */
export type ArchiveFormat = typeof ARCHIVE_FORMAT;
