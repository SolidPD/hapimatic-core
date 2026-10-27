// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Typed errors for the Configuration Porter import core.
 *
 * Extracted from importArchive.ts in #2563 to keep that module under the #2077
 * `max-lines` guardrail. Each error surfaces to the user and guarantees zero
 * bytes were written to `~/.claude`. importArchive.ts re-exports all of these,
 * so the public API is unchanged — consumers may import them from either module.
 * The exception is {@link CommitRollbackError} (#4246): it can be thrown after
 * writes began — it wraps any failure inside runCommit's try, including one in
 * the backup phase before any write — and it is imported from this module only,
 * which spares a line of importArchive.ts's `max-lines` budget.
 */
import {
  SETTINGS_LINK_REASON_TEXT,
  settingsLinkConsequence,
  type SymlinkedSettingsReason,
} from "@hapi/protocol/porter";

/** R1 — manifest version/shape validation failed (rejected whole, zero bytes). */
export class ManifestValidationError extends Error {
  readonly kind: "version_mismatch" | "invalid" | "missing";
  constructor(
    kind: "version_mismatch" | "invalid" | "missing",
    message: string
  ) {
    super(message);
    this.name = "ManifestValidationError";
    this.kind = kind;
  }
}

/** R2 / Task 3 — secrets.age failed to decrypt (wrong recipient/corrupt/missing identity). */
export class SecretDecryptionError extends Error {
  constructor(reason: string) {
    super(`Secret decryption failed: ${reason}. No secret was imported.`);
    this.name = "SecretDecryptionError";
  }
}

/** F4 — the archive carries UNENCRYPTED secrets; refuse to import plaintext. */
export class PlaintextSecretsError extends Error {
  constructor(detail: string) {
    super(
      `Refusing import: ${detail}. Secrets must arrive encrypted to this ` +
        `instance's age recipient (secrets.age), never as plaintext.`
    );
    this.name = "PlaintextSecretsError";
  }
}

/** D1 — data dir and destination config root are on different filesystems. */
export class SameFilesystemError extends Error {
  constructor(dataDir: string, destRoot: string) {
    super(
      `Refusing import: the data dir (${dataDir}) and the destination config ` +
        `root (${destRoot}) are on different filesystems, so the atomic ` +
        `backup/rename guarantees do not hold. Co-locate them or move HAPI_HOME.`
    );
    this.name = "SameFilesystemError";
  }
}

/**
 * #3590 (K4/D9) — the commit was asked to import an archive whose dynamic-loader
 * registries reference hook modules that resolve to NO hook script (neither in
 * the archive nor at the destination) AND at least one hook survives the
 * selection, but the request did not acknowledge every missing name. The
 * fail-loud belt: rather than silently ship a registry that points at absent
 * hooks (the class this issue fixes), the commit refuses with a typed 4xx. The
 * escape hatch is `acknowledgeMissingHooks` (name each missing module) or
 * deselecting every hook — NEVER a silent import.
 */
export class RegistryDriftError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Refusing import: ${missing.length} hook module(s) referenced by the ` +
        `archive's dynamic-loader registry resolve to no hook file, in the ` +
        `archive or at the destination: ${missing.join(", ")}. Acknowledge each ` +
        `missing name (acknowledgeMissingHooks) to import anyway, or deselect ` +
        `every hook.`
    );
    this.name = "RegistryDriftError";
    this.missing = missing;
  }
}

/** Why a symlinked `settings.json` cannot be written through (#4146); one
 * shared source with the web (#4288), re-exported for existing importers. */
export type { SymlinkedSettingsReason };

/**
 * #4146 (D14) — the destination `settings.json` is a symlink the merge must not
 * write through: its target is outside the config root, dangling, looping, or
 * not a regular file. A merge that writes would replace the LINK with a regular
 * file, silently detaching whatever it pointed at (a dotfiles copy, or a #1562
 * account-config bridge link, which the bridge then refuses to re-create). The
 * commit refuses BEFORE any write; the escape hatch is
 * `acknowledgeSymlinkedSettings` set to this exact `target` string, which
 * replaces the link on purpose. A link re-pointed after the refusal is not
 * acknowledged.
 */
export class SymlinkedSettingsError extends Error {
  readonly linkPath: string;
  readonly target: string;
  readonly reason: SymlinkedSettingsReason;
  constructor(
    linkPath: string,
    target: string,
    reason: SymlinkedSettingsReason
  ) {
    super(
      `Refusing import: ${linkPath} is a symlink to ${target}, and ` +
        `${SETTINGS_LINK_REASON_TEXT[reason]}. If the settings merge writes, it ` +
        `replaces the link with a regular file, and ` +
        `${settingsLinkConsequence(reason, target)}. To replace the link anyway, re-commit with ` +
        `acknowledgeSymlinkedSettings set to "${target}". Otherwise replace the ` +
        `link with a regular file, or import into the config root that holds ` +
        `the link's target.`
    );
    this.name = "SymlinkedSettingsError";
    this.linkPath = linkPath;
    this.target = target;
    this.reason = reason;
  }
}

/**
 * commitImport called on a plan whose staging dir no longer exists (expired).
 * #5787: the message names no path — the dir holds the staging handle — so the
 * dir is kept as a property ({@link StagingExpiredError.stagingDir}), which
 * only tests read; nothing logs or returns it.
 */
export class StagingExpiredError extends Error {
  readonly stagingDir: string;
  constructor(stagingDir: string) {
    super(
      `Import plan expired: its staging dir no longer exists ` +
        `(a server restart or TTL sweep cleared it). Re-run the plan step.`
    );
    this.name = "StagingExpiredError";
    this.stagingDir = stagingDir;
  }
}

/**
 * RC-4 (#2806) — an `isolatedDest` that fails the machine-path denylist. This is
 * the FIRST isolated-destination blocker, independent of filesystem: it rejects
 * `/tmp`/tmpfs, `~/.config`, `/etc`, `.ssh`, and the rest of {@link isSafeMachinePath}'s
 * blacklist, so a same-machine import can never redirect config writes into a
 * sensitive or ephemeral system path.
 */
export class IsolatedDestUnsafeError extends Error {
  constructor(isolatedDest: string) {
    super(
      `Refusing import: the isolated destination (${isolatedDest}) is a ` +
        `denylisted system or sensitive path (e.g. /tmp, ~/.config, /etc, .ssh). ` +
        `Choose a throwaway dir outside the denylist.`
    );
    this.name = "IsolatedDestUnsafeError";
  }
}

/**
 * RC-6 (#2806) — an `isolatedDest` inside `dataDir/porter-staging` or
 * `dataDir/porter-backup`. Those subtrees are reaped by `sweepExpiredPorterDirs`
 * on a 30-minute TTL, so an isolated destination placed there would be silently
 * deleted out from under a same-machine instance.
 */
export class IsolatedDestReapedError extends Error {
  constructor(isolatedDest: string, reapedRoot: string) {
    super(
      `Refusing import: the isolated destination (${isolatedDest}) is inside ` +
        `${reapedRoot}, which the porter TTL sweep reaps every 30 minutes. ` +
        `Choose a dir outside the porter-staging / porter-backup subtrees.`
    );
    this.name = "IsolatedDestReapedError";
  }
}

/**
 * A7 (#2806) — `isolatedDest` was combined with an explicit `claudeDir` or
 * `hostConfigPath`. These are mutually-exclusive destination selectors; rather
 * than silently pick a precedence, fail loud so the caller passes exactly one.
 */
export class IsolatedDestConflictError extends Error {
  constructor() {
    super(
      `Refusing import: isolatedDest is mutually exclusive with an explicit ` +
        `claudeDir or hostConfigPath. Pass only one destination selector.`
    );
    this.name = "IsolatedDestConflictError";
  }
}

/**
 * #4246 — runCommit's rollback wrap. `cause` is the original failure; `partial`
 * is true when some files could not be restored. The commit route classifies a
 * CLEAN rollback by its `cause`, so a typed refusal keeps its status; a PARTIAL
 * rollback stays 500, because files may be left inconsistent.
 */
export class CommitRollbackError extends Error {
  readonly partial: boolean;
  constructor(message: string, opts: { cause: unknown; partial: boolean }) {
    super(message, { cause: opts.cause });
    this.name = "CommitRollbackError";
    this.partial = opts.partial;
  }
}
