// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where each planned import file may land — the Configuration Porter's
 * destination policy for EVERY file producer (issue #4160). A pure module, like
 * `./claudeMdIncludes` (#4143), so the rule is unit-testable on its own.
 *
 * 🔴 Why this exists: the import plans each archive member as a WHOLE-FILE
 * write to `<claudeDir>/<archive path>`. Containment (`assertSafeEntry`) keeps
 * that write under the config root, but nothing tied a manifest section entry
 * to its own folder, so a `rules` or `outputStyles` entry whose `path` was
 * `settings.json` or `.config.json` planted that whole file — outside the
 * key-wise `mergeSettings` / `importMcpServers` merges, the F5
 * `PORTABLE_SETTINGS_KEYS` allowlist, and the #2565 values-visible review.
 *
 * The rule is an ALLOWLIST keyed by the planned item's kind, not a denylist of
 * reserved names: a section item may only write strictly inside its section's
 * folder, CLAUDE.md only to `CLAUDE.md`, and a CLAUDE.md include only to a
 * top-level `*.md` sibling or a `*.md` under `claude-includes/` (#4143's rule,
 * extended by #4156, reused). Every reserved config file
 * (`settings.json`, `settings.local.json`, `.claude.json`, `.config.json`,
 * `.credentials.json`) is top-level and non-markdown, so none is reachable — and
 * a name denylist could not be applied at depth anyway, because an honest skill
 * may carry its own `skills/<name>/settings.json` data file.
 *
 * Classification uses the RESOLVED destination (the absolute path
 * `assertSafeEntry` returned), never the raw archive string, because tar member
 * paths are not normalised: `./settings.json`, `settings.json/` and (on POSIX)
 * `rules\settings.json` all resolve to a top-level file.
 *
 * #4173: the one kind that is neither a section folder nor an exact name is a
 * `settings-script`, the top-level script an imported `statusLine.command` or
 * `apiKeyHelper` runs. It is bounded by a positive name allowlist (a top-level
 * file with a script extension, `classifySettingsScriptRef`), so no reserved
 * config file is reachable, AND by the set of scripts the imported values name,
 * which the caller passes in {@link DestinationContext}; with no set it fails
 * closed.
 */
import { relative, sep } from "node:path";
import {
  classifySettingsScriptRef,
  credentialPathPart,
  type Omission,
} from "@hapi/protocol/porter";
import { PathEscapeError } from "./archiveContainment";
import { classifyClaudeMdInclude } from "./claudeMdIncludes";
import type { PlannedFileItem, PlannedItemKind } from "./importArchive";

/**
 * Manifest section field → the folder its files land in. These are the
 * archive-layout folder names (config-porter-archive.md § "Archive layout");
 * `plannedDestinations.test.ts` pins them against the exporter's
 * `DIMENSION_FIELD` so a renamed folder fails loudly instead of drifting.
 */
export const SECTION_FOLDER = {
  skills: "skills",
  agents: "agents",
  commands: "commands",
  rules: "rules",
  outputStyles: "output-styles",
  hookSupport: "hooks",
} as const;
export type SectionField = keyof typeof SECTION_FOLDER;

type DestinationRule =
  | { folder: string }
  | { exact: "CLAUDE.md" }
  | { include: true }
  | { settingsScript: true };

/** Every planned kind's allowed destination — a new kind will not compile without one. */
const KIND_DESTINATION: Record<PlannedItemKind, DestinationRule> = {
  skill: { folder: SECTION_FOLDER.skills },
  agent: { folder: SECTION_FOLDER.agents },
  command: { folder: SECTION_FOLDER.commands },
  rule: { folder: SECTION_FOLDER.rules },
  "output-style": { folder: SECTION_FOLDER.outputStyles },
  "hook-lib": { folder: SECTION_FOLDER.hookSupport },
  "hook-file": { folder: SECTION_FOLDER.hookSupport },
  "claude-md": { exact: "CLAUDE.md" },
  "claude-md-include": { include: true },
  "settings-script": { settingsScript: true },
};

/**
 * What a destination rule may need beyond the item itself. #4173:
 * `settingsScriptRels` is the set of top-level script names the IMPORTED
 * executable values run. The backstop's caller computes it from the plan's
 * settings with the same `referencedScriptRels` the planner uses, so the
 * backstop refuses a planner that writes a name no imported value runs; the
 * name and credential rules below are re-applied on their own.
 */
export interface DestinationContext {
  settingsScriptRels?: ReadonlySet<string>;
}

/**
 * #4173: a settings script may write only `<config root>/<name>` where `<name>`
 * is in the referenced set, has no separator, and passes the shared name rule
 * (top-level, script extension, not credential-bearing). The name rule keeps
 * `settings.json`, `.claude.json`, `.credentials.json`, `CLAUDE.md` and every
 * other reserved file out even when a hostile value names one.
 */
function settingsScriptDestinationOk(
  destRel: string,
  ctx: DestinationContext | undefined
): boolean {
  return (
    ctx?.settingsScriptRels?.has(destRel) === true &&
    destRel.split(sep).length === 1 &&
    classifySettingsScriptRef(destRel) === "ok"
  );
}

/**
 * Is `destRel` strictly inside `folder` (a file under it, never the folder
 * itself)? Splits on the platform `sep` on purpose — unlike the `/[\\/]/`
 * "not top-level" test in ./claudeMdIncludes, which only has to reject: on
 * POSIX a backslash is an ordinary filename character, so `rules\settings.json`
 * lands as ONE top-level file and must not count as inside `rules/`.
 */
function insideFolder(destRel: string, folder: string): boolean {
  const segs = destRel.split(sep);
  return segs.length >= 2 && segs[0] === folder;
}

/**
 * Classify a planned item's resolved destination against its kind's rule.
 * `destRel` is the config-root-relative destination, for naming and staging.
 */
export function classifyPlannedDestination(
  claudeDir: string,
  kind: PlannedItemKind,
  destPath: string,
  ctx?: DestinationContext
): { ok: boolean; destRel: string } {
  const destRel = relative(claudeDir, destPath);
  const rule = KIND_DESTINATION[kind];
  if ("folder" in rule)
    return { ok: insideFolder(destRel, rule.folder), destRel };
  if ("exact" in rule) return { ok: destRel === rule.exact, destRel };
  if ("settingsScript" in rule) {
    return { ok: settingsScriptDestinationOk(destRel, ctx), destRel };
  }
  return {
    ok: classifyClaudeMdInclude(claudeDir, destPath, new Set()).ok,
    destRel,
  };
}

/**
 * A planned file inside the config root but outside the destination its kind
 * may write (#4160). Still a {@link PathEscapeError} — same `name`, so the
 * route's 400 mapping and the wire `kind` are unchanged — with a message that
 * does not claim the path left the root.
 */
export class PlannedDestinationError extends PathEscapeError {
  constructor(claudeDir: string, destRel: string, kind: PlannedItemKind) {
    super(
      claudeDir,
      destRel,
      `outside the destination a ${kind} item may write`
    );
    this.message =
      `Refusing to write ${JSON.stringify(destRel || ".")} (relative to the ` +
      `config root): a ${kind} item may not be written there.`;
  }
}

/**
 * A planned file whose destination has a credential-bearing path part (issue
 * #4172). Still a {@link PathEscapeError} (same `name` → HTTP 400) with a message
 * naming the part.
 */
export class CredentialNameError extends PathEscapeError {
  constructor(claudeDir: string, destRel: string, part: string) {
    super(claudeDir, destRel, `has a credential-bearing path part (${part})`);
    this.message =
      `Refusing to write ${JSON.stringify(destRel)} (relative to the config ` +
      `root): its path part ${JSON.stringify(part)} is a credential-bearing ` +
      `name, which is never imported.`;
  }
}

/**
 * Kinds whose planned files the credential-name rule covers (#4172). CLAUDE.md
 * and its includes are governed by their own exact / #4143 rules, so an honest
 * `@.env.md` include keeps importing.
 */
const CREDENTIAL_RULE_KINDS: ReadonlySet<PlannedItemKind> = new Set([
  "skill",
  "agent",
  "command",
  "rule",
  "output-style",
  "hook-lib",
  "hook-file",
  // #4173 (the #4172 cross-seam): also refused by its own name rule above.
  "settings-script",
]);

/**
 * The fail-closed backstop over the COMBINED planned file list (every
 * producer). Each producer filters first, so this never fires on an archive
 * today; it refuses the archive (`PlannedDestinationError` → 400) if a
 * producer — or one added later — ever plans a file outside its kind's
 * destination. #4172: it also refuses (`CredentialNameError` → 400) a section
 * or hook file with a credential-bearing path part. `planDimension` skips those
 * first, and `planHookFiles` refuses a credential-named registered hook file
 * before staging it (it has no omission channel); this stays the backstop over
 * every producer. The destination check runs first, so a #4160 refusal is
 * unchanged. #4173: `ctx.settingsScriptRels` bounds the `settings-script` kind;
 * the caller computes it from the plan's settings, independently of the planner.
 */
export function assertPlannedDestinations(
  claudeDir: string,
  files: readonly PlannedFileItem[],
  ctx?: DestinationContext
): void {
  for (const f of files) {
    const v = classifyPlannedDestination(claudeDir, f.kind, f.destPath, ctx);
    if (!v.ok) throw new PlannedDestinationError(claudeDir, v.destRel, f.kind);
    if (CREDENTIAL_RULE_KINDS.has(f.kind)) {
      const part = credentialPathPart(v.destRel);
      if (part !== null)
        throw new CredentialNameError(claudeDir, v.destRel, part);
    }
  }
}

/**
 * The `omissions` surface a skipped section entry is reported under. The one
 * spelling shared by the emitters ({@link sectionSkipOmission},
 * {@link sectionEntryOmission}, {@link sectionUnmatchedOmission}) and the
 * parity report (./commitHooks), which skips an entry only when the plan
 * actually carries this omission for it.
 */
export function sectionSkipSurface(
  field: SectionField,
  entryPath: string
): string {
  return `${field} entry ${entryPath}`;
}

/**
 * A path with its leading `./` and trailing `/` stripped (each repeated): the
 * spelling a tar MEMBER is matched by (#4185), so `./skills/foo/x` and
 * `skills/foo/x/` match the entry `skills/foo`. A member is never rejected
 * here, so a hostile `./skills/foo/../x` still matches `skills/foo` and is
 * refused by `assertSafeEntry`, which runs on the RAW member path.
 *
 * Matching only. Never `path.posix.normalize`, which would fold
 * `rules/../skills/x` into `skills/x`.
 */
export function stripEntrySpelling(p: string): string {
  let s = p;
  while (s.startsWith("./")) s = s.slice(2);
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/**
 * The spelling a section ENTRY path is matched by (#4185):
 * {@link stripEntrySpelling}, so `skills/foo/`, `./skills/foo` and `skills/foo`
 * plan the same members. `null` when nothing is left, or the path has an empty
 * (`//`, a leading `/`), `.` or `..` part: such an entry is reported as an
 * invalid entry path and never used as a prefix. An omission still names the
 * RAW entry spelling. Parts are split on `/` only, the tar separator, so a `\`
 * path is matched as it is, and `assertSafeEntry` (which also splits on `\`)
 * still refuses a member with a `..` part.
 */
export function normalizeEntryPath(p: string): string | null {
  const s = stripEntrySpelling(p);
  if (s === "") return null;
  const parts = s.split("/");
  if (parts.some(part => part === "" || part === "." || part === ".."))
    return null;
  return s;
}

/**
 * The operator-facing plan warning for a section entry whose members were
 * skipped: one per `(section, entry path)`, naming the first destination.
 */
export function sectionSkipOmission(
  field: SectionField,
  entryPath: string,
  firstDestRel: string,
  count: number
): Omission {
  return {
    surface: sectionSkipSurface(field, entryPath),
    reason: outsideFolderReason(field, firstDestRel, count),
  };
}

function moreFiles(count: number): string {
  return count > 1 ? ` and ${count - 1} more file(s)` : "";
}

function outsideFolderReason(
  field: SectionField,
  firstDestRel: string,
  count: number
): string {
  return `not imported: a ${field} entry may only write inside ${SECTION_FOLDER[field]}/ (it would write ${firstDestRel}${moreFiles(count)})`;
}

/**
 * The reason for a section member skipped because its destination has a
 * credential-bearing path part (#4172). Names the first skipped destination and
 * the offending part.
 */
export function credentialSkipReason(
  firstDestRel: string,
  part: string,
  count: number
): string {
  return `not imported: ${firstDestRel} has a credential-bearing path part (${part}); such files are never imported${moreFiles(count)}`;
}

/** First skipped destination + count for one skip cause of one section entry. */
export interface SkipTally {
  first: string;
  count: number;
}

/**
 * The single plan warning for one section entry (#4172). The web list keys each
 * omission on its `surface`, so an entry gets ONE omission even when both
 * causes fire: the #4160 outside-folder reason, the credential reason, or both
 * joined with "; also ".
 */
export function sectionEntryOmission(
  field: SectionField,
  entryPath: string,
  causes: {
    outside?: SkipTally;
    credential?: SkipTally & { part: string };
  }
): Omission {
  const reasons: string[] = [];
  if (causes.outside) {
    reasons.push(
      outsideFolderReason(field, causes.outside.first, causes.outside.count)
    );
  }
  if (causes.credential) {
    const c = causes.credential;
    reasons.push(credentialSkipReason(c.first, c.part, c.count));
  }
  return {
    surface: sectionSkipSurface(field, entryPath),
    reason: reasons.join("; also "),
  };
}

/**
 * The plan warning for a section entry that planned nothing because it matched
 * no FILE member (#4185), or because its path is not a valid entry path
 * ({@link normalizeEntryPath} returned `null`). It carries the same surface as
 * {@link sectionEntryOmission}, so an entry still gets ONE omission, and the
 * post-commit parity (./commitHooks) drops a "missing" result for an entry
 * already reported here. At most one of the two fires per entry: a member
 * skipped for either #4160 or #4172 reason counts as a match.
 */
export function sectionUnmatchedOmission(
  field: SectionField,
  entryPath: string,
  cause: "no-file" | "invalid-path" = "no-file"
): Omission {
  return {
    surface: sectionSkipSurface(field, entryPath),
    reason:
      cause === "invalid-path"
        ? `not imported: this is not a valid entry path (it has an empty, "." or ".." part)`
        : "not imported: no file in the archive matches this entry",
  };
}
