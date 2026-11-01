// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — cross-emitter shared constants (epic #3445 Sub B,
 * issue #3447, K7).
 *
 * The bash exporter ({@link buildExportScript}, `exportScript.ts`) and the
 * Windows-native PowerShell twin ({@link buildExportScriptPowerShell},
 * `exportScriptPowerShell.ts`) are SIBLING emitters that must produce
 * manifest-EQUIVALENT archives. "Never restate a literal" (the same drift-
 * prevention doctrine `exportScript.ts` applies against the schema modules) now
 * spans two LANGUAGE DIALECTS: the dimension→field map, the settings allowlist,
 * the archive-exclusion patterns, and the secret-detection / marketplace-source
 * regexes were PRIVATE module locals in `exportScript.ts` — restating them in
 * PowerShell would let the two emitters silently disagree on what counts as a
 * secret. They are hoisted here so BOTH emitters cite ONE source [1B#15, K7].
 *
 * DIALECT-NEUTRAL SOURCES + PER-DIALECT ADAPTER. The regex sources are held in
 * canonical (.NET-ready) form: `\s` for whitespace, single-backslash escapes,
 * case-insensitivity expressed by the consumer (jq `; "i"` vs .NET
 * `RegexOptions.IgnoreCase`). {@link toJqRegex} renders a canonical source into
 * the jq (oniguruma) form the bash emitter has always embedded — `\s` →
 * `[[:space:]]` and every backslash doubled for the jq string literal that lives
 * inside a single-quoted bash `jq -c '…'` program. The PowerShell emitter
 * consumes the canonical form verbatim (it IS .NET-ready), so `toJqRegex` is the
 * only adapter needed today; the `.NET` seam is the canonical constant itself.
 *
 * SORT SEMANTICS (consumer-side, not encoded here): jq `keys`/`unique` SORT,
 * while PowerShell object properties are insertion-ordered — so the PowerShell
 * emitter `Sort-Object`s `envNames`/`headerNames`/`skippedSettingsKeys` to match
 * the bash manifest [1B#15].
 *
 * NODE-FREE (R7): like every non-test module under `shared/src/porter`, this file
 * imports no `node:*` builtin — it holds constants + a pure string adapter. The
 * `manifest.test.ts` R7 guard would fail the build if a `node:` import were added.
 */
import {
  ARCHIVE_EXCLUSIONS,
  HOOK_TREE_EXCLUSIONS,
  PORTABLE_DIMENSIONS,
  PORTABLE_SETTINGS_KEYS,
} from "./manifest";

/**
 * The dimension DIRECTORIES the export copies wholesale (junk-pruned) and
 * enumerates into the manifest. `CLAUDE.md` (Step 3) and `settings.json`
 * (Step 7) are special-cased and excluded here.
 */
export const DIMENSION_DIRS = PORTABLE_DIMENSIONS.filter(
  d => d !== "CLAUDE.md" && d !== "settings.json"
);

/**
 * The archive folder every exporter stages CLAUDE.md's `@`-includes under: an
 * include `docs/guide.md` ships as the member `claude-includes/docs/guide.md`.
 * #4156: the importer lands a NESTED include at
 * `<config root>/claude-includes/<include>` and rewrites its CLAUDE.md
 * reference to match, so the folder is also the one place under the config
 * root an include may write below top level. A test pins every exporter's
 * member paths to this spelling.
 */
export const CLAUDE_INCLUDES_DIR = "claude-includes";

/**
 * The tar members a definitions-only archive can carry — NEVER a secrets one.
 * Both exporters tar these; the extraction prompt's Step 11 tars these plus
 * the encrypted secrets member (#4164 `PROMPT_ARCHIVE_MEMBERS`).
 * `settings-scripts` is `SETTINGS_SCRIPTS_DIR` (#4173, `./settingsScripts`),
 * spelled here because that module imports this one; a test pins the two.
 */
export const DEFINITIONS_ARCHIVE_MEMBERS: readonly string[] = [
  "manifest.json",
  ...DIMENSION_DIRS,
  "CLAUDE.md",
  CLAUDE_INCLUDES_DIR,
  "hooks",
  "settings-scripts",
  // #4373: the tenant profile's auto-memory (MEMORY_ARCHIVE_DIR, `./tenantProfile`,
  // spelled here because a full export never stages it; a test pins the two).
  "memory",
];

/** Manifest field name for each dimension DIRECTORY (`output-styles` → `outputStyles`). */
export const DIMENSION_FIELD: Record<string, string> = {
  skills: "skills",
  agents: "agents",
  commands: "commands",
  rules: "rules",
  "output-styles": "outputStyles",
};

/** Allowlisted settings keys the export projects — MINUS `env` (values omitted, R9/D2c). */
export const SETTINGS_KEYS_NO_ENV = PORTABLE_SETTINGS_KEYS.filter(
  k => k !== "env"
);

/**
 * {@link ARCHIVE_EXCLUSIONS} with the trailing `/` stripped — the raw junk
 * patterns both emitters exclude. The bash `tarExcludeFlags()` formatter
 * (`exportScript.ts`) emits a `--exclude` flag pair per pattern; the PowerShell
 * emitter passes them to `tar.exe --exclude` (or a `robocopy /XD`/`/XF` set).
 * Held as the shared pattern list so the two exclusion renderings cannot drift.
 */
export const ARCHIVE_EXCLUSION_PATTERNS = ARCHIVE_EXCLUSIONS.map(raw =>
  raw.replace(/\/$/, "")
);

/**
 * #3590 (K2): the extra `tar --exclude` patterns the whole-`hooks/`-tree stage
 * applies ON TOP OF {@link ARCHIVE_EXCLUSION_PATTERNS}. Rendered from
 * {@link HOOK_TREE_EXCLUSIONS} with the trailing `/` stripped, exactly as
 * `ARCHIVE_EXCLUSION_PATTERNS` is — the bash `tarExcludeFlags(extra)` formatter
 * and the PowerShell `copyTreeExcluding($src,$dst,$extra)` both emit a bare +
 * wildcard-slash-prefixed flag pair per pattern, so the emitters prune the same tree.
 */
export const HOOK_TREE_EXCLUSION_PATTERNS = HOOK_TREE_EXCLUSIONS.map(raw =>
  raw.replace(/\/$/, "")
);

/**
 * The credential KEYWORD alternation shared by the `secret_flag` (bare
 * `--token`) and `secret_kv` (`--token=value`) checks. Dialect-neutral: the
 * alternation + `[_-]?` class render identically in jq (oniguruma) and .NET.
 */
export const SECRET_KEYWORD_GROUP =
  "api[_-]?key|apikey|token|key|secret|password|passwd|pwd|auth|bearer|access[_-]?token";

/**
 * Known credential token PREFIXES (`looks_token`, arm 1). Canonical regex form:
 * `.` is a single-backslash escape (`ya29\.`); {@link toJqRegex} doubles it for
 * the jq string literal. The trailing space in `Bearer ` is intentional.
 */
export const SECRET_TOKEN_PREFIX_GROUP =
  "sk-|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|xox[baprs]-|glpat-|AKIA|ya29\\.|Bearer ";

/** High-entropy token body (`looks_token`, arm 2): 24+ chars of the token alphabet. */
export const SECRET_HIGH_ENTROPY_BODY = "[A-Za-z0-9_+/=.-]{24,}";

/** A URL carrying `userinfo@` — credential-bearing (`is_secret_url`, arm 1). */
export const SECRET_URL_USERINFO_PATTERN = "//[^/@]*@";

/** A URL carrying a query or fragment — might carry a token (`is_secret_url`, arm 2). */
export const SECRET_URL_QUERYFRAG_PATTERN = "[?#]";

/**
 * The three marketplace-`source` validators the bash `valid_source` restates
 * (`owner/repo[#ref]`, an `(https|git|ssh)://` URL, or `git@host:path`).
 * Canonical form uses `\s`; {@link toJqRegex} renders the `[[:space:]]` the jq
 * program embeds. A `source` matching NONE of these is dropped (the destination
 * `PorterManifestSchema` rejects the whole manifest on an invalid descriptor).
 */
export const MARKETPLACE_SOURCE_PATTERNS = [
  "^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*(#[^#]+)?$",
  "^(https?|git|ssh)://[^\\s#]+$",
  "^git@[^\\s:#]+:[^\\s#]+$",
] as const;

/**
 * Render a canonical (.NET-ready) regex source into the jq/oniguruma form the
 * bash emitter embeds inside a single-quoted `jq -c '…'` program:
 *   1. `\s` → `[:space:]` — the POSIX class token jq uses INSIDE a bracket
 *      expression. Every `\s` in the canonical sources above appears inside a
 *      negated class (`[^\s#]`), so the byte-correct jq form is `[^[:space:]#]`
 *      — the bare `[:space:]` (no outer brackets), NOT the standalone
 *      `[[:space:]]`. A source that ever needs a STANDALONE whitespace class
 *      must write `[\s]` (a one-element class) so this rule stays correct.
 *   2. every remaining backslash is doubled — the jq program is a double-quoted
 *      jq string, so `\.` in the regex must be written `\\.` in the program text
 *      for jq to decode it back to `\.`.
 * Byte-for-byte reproduces the literals `exportScript.ts` shipped before the
 * hoist (R5). Order matters: `\s` is expanded BEFORE the backslash-doubling, so
 * the injected `[:space:]` (which has no backslash) is left untouched.
 */
export function toJqRegex(canonical: string): string {
  return canonical.replace(/\\s/g, "[:space:]").replace(/\\/g, "\\\\");
}

/**
 * #4154: the CLAUDE.md `@`-include EXPORT rule, single-sourced for both emitters.
 *
 * Step 3 used to copy every file an `@`-include line named, so `@settings.json`
 * shipped that file's `env` VALUES raw and bypassed Step 7's secrets-free
 * projection (#2342). Both emitters now package an include only when it is a
 * canonical in-tree path whose basename matches `*.md` (any case) and is not
 * `CLAUDE.md` (any case). A symlinked include is packaged only when its final
 * target is a regular `.md` file. Everything else becomes an omission under a
 * per-include surface ({@link CLAUDE_MD_INCLUDE_SURFACE_PREFIX} + the include as
 * written), so the reasons match byte-for-byte across bash and PowerShell (the
 * #3447 equivalence harness deep-equals the two manifests). ASCII only, with no
 * quote, `$`, backslash, or backtick, so each string embeds verbatim in a
 * single-quoted bash or PowerShell literal.
 *
 * #4188: an include is read from the directory of CLAUDE.md's final link
 * target, where Claude Code reads it, not from the config root: in a Hapimatic
 * account-config folder `CLAUDE.md` links to `~/.claude/CLAUDE.md`, and its
 * includes sit beside that target.
 */
export const CLAUDE_MD_INCLUDE_SURFACE_PREFIX = "CLAUDE.md include @";

export const CLAUDE_MD_INCLUDE_SKIP_REASONS = {
  notCanonical:
    "not exported: an include must be a plain path inside the directory of CLAUDE.md (no leading or trailing /, no . or .. segment)",
  notMarkdown:
    "not exported: only .md includes are packaged, so a settings or credential file never rides along",
  shadowsClaudeMd: "not exported: CLAUDE.md itself is packaged on its own",
  notRegularFile: "not exported: the include is not a regular file",
  linkTargetNotMarkdown:
    "not exported: the include is a symbolic link whose target is not a .md file",
} as const;

/**
 * #4164: the legacy omission for an include that does not exist at all. Its
 * surface is shared by every missing include (unlike the per-include surface
 * above); the reason is this prefix + the include as written. Both emitters
 * record it, and the extraction prompt's Step 3 names it.
 */
export const CLAUDE_MD_INCLUDE_NOT_FOUND_SURFACE = "claudeMd.include";
export const CLAUDE_MD_INCLUDE_NOT_FOUND_REASON_PREFIX =
  "referenced include not found: ";

/**
 * #4188: the one omission (under {@link CLAUDE_MD_INCLUDE_NOT_FOUND_SURFACE})
 * an exporter records when CLAUDE.md is a regular file through its links, yet
 * the hand walk cannot name that file, so the include base is unknown. In
 * practice that is a backslash in one of its link targets on a host where `/`
 * is the separator, or (PowerShell only) a path its cmdlets cannot read as
 * written, such as a folder named with `::`. CLAUDE.md itself is still
 * packaged; none of its includes is. A broken, cyclic or over-long chain never
 * gets this far: the exporters skip such a CLAUDE.md entirely, with no
 * omission. ASCII, with no quote, `$`, backslash or backtick (it embeds in a
 * single-quoted literal).
 */
export const CLAUDE_MD_INCLUDE_WALK_FAILED_REASON =
  "the link chain of CLAUDE.md could not be followed, so none of its includes was packaged";

/**
 * #4164: what counts as an `@`-include line — `@` at line start, then the
 * include is the longest run of these characters. The bash exporter greps with
 * it, the PowerShell exporter wraps the same class in a capture group, and the
 * extraction prompt tells the model to use it, so all three read the same
 * includes out of one CLAUDE.md.
 */
export const CLAUDE_MD_INCLUDE_LINE_PATTERN = "^@[A-Za-z0-9._/-]+";

/**
 * #4186: the command that lists a CLAUDE.md's `@`-include lines, up to and
 * including the pattern. Callers append the file and `| awk '!seen[$0]++'`.
 * The bash exporter's loop and the extraction prompt's Step 3 both print this
 * one string, so the two commands cannot drift apart.
 *
 * `LC_ALL=C`: under a UTF-8 locale such as `en_US.UTF-8`, GNU grep's
 * `[A-Za-z]` range also matches letters like `é`, so `@café.md` was the
 * include `café.md` on one machine and `caf` on another. In the C locale the
 * range is ASCII only, as it is in the PowerShell exporter's .NET regex. The
 * bash exporter already runs under `export LC_ALL=C` (#4172); the prefix is
 * what pins the prompt's Step 3, which the model runs in its own shell.
 *
 * `-a` (#4195 Task 1, ruling D16): GNU grep treats a file that holds a NUL
 * byte as binary in every locale and prints "binary file matches" instead of
 * the matches, so such a CLAUDE.md lost every include. PowerShell reads it as
 * text.
 */
export const CLAUDE_MD_INCLUDE_GREP = `LC_ALL=C grep -a -oE '${CLAUDE_MD_INCLUDE_LINE_PATTERN}'`;

/**
 * #4164 / #5201: the bash lines that clear the operator's tar and gzip
 * environment before a script's first `tar`. GNU tar reads `TAR_OPTIONS`,
 * bsdtar reads `TAR_READER_OPTIONS` and `TAR_WRITER_OPTIONS`, and gzip reads
 * `GZIP`; any of them changes what the tars write, extract or print. The bash
 * exporter and the extraction prompt's check block both spread these lines, so
 * the two clears cannot drift apart. Safe under `set -eu` when none is set.
 */
export const TAR_ENV_SCRUB_SHELL_LINES: readonly string[] = [
  'for _v in "${!TAR_@}"; do unset "$_v"; done',
  "unset GZIP",
];

/**
 * #4172: the omission reason every export surface records for a file or folder
 * it did not package because its name is credential-bearing
 * (`ARCHIVE_CREDENTIAL_NAMES` / `ARCHIVE_CREDENTIAL_PREFIXES`). The surface is
 * the staging-relative path. ASCII, with no quote, `$`, backslash or backtick,
 * so it embeds verbatim in a single-quoted bash or PowerShell literal.
 */
export const ARCHIVE_CREDENTIAL_OMISSION_REASON =
  "not exported: a credential-bearing name (.env, .npmrc, .ssh and similar) is never packaged";

/**
 * #4172 (OOS-6): the omission reason both exporters record for a link they
 * refused because its physical target could not be checked for a credential
 * store: its target exists but the check cannot resolve it, it lies more than
 * 40 folder links deep, or its walk reaches `/proc`. The same reason is
 * recorded for a staged link whose path holds a newline and a linked folder
 * holding a newline-named entry (bash reads paths one per line); and, by the
 * PowerShell exporter, for a folder under a linked folder it cannot list (for
 * example, off Windows, a `::` in its path, which the path cmdlets read as a
 * provider qualifier), for a link whose path or target holds `::` off Windows,
 * for a file link whose checked path is not a file (off Windows, a backslash
 * in its target reaches a folder), and, off Windows (where its existence test
 * is true for any link), for a dangling link, which bash records as a broken
 * symlink. ASCII, with no quote, `$`, backslash or backtick, like the reason
 * above.
 */
export const ARCHIVE_LINK_UNCHECKED_OMISSION_REASON =
  "not exported: a link whose target could not be checked for a credential store";

/**
 * #4321 (Item 5): the omission reason both exporters record for a folder link,
 * inside a linked folder, whose target is a folder on its own path or a folder
 * that holds it (`loop -> .`, `up -> ..`), or the config root or a folder above
 * its physical path, wherever the link sits (#5862: the root holds the path
 * that reached the link). The last two also catch another spelling of the
 * folder (#5935: off Windows a bind mount or a case variant is compared by
 * identity; on Windows the text test ignores case). The copy that dereferences
 * the linked folder leaves it out:
 * GNU tar's `-h` would follow it without end (the export hung), and bsdtar
 * would keep it as a link. ASCII, with no quote, `$`, backslash or backtick,
 * like the reasons above.
 */
export const ARCHIVE_LINK_LOOP_OMISSION_REASON =
  "link loop: not exported, its target is a folder that contains it";

/**
 * #5934: the omission reason both exporters record for a link whose physical
 * target lies inside the config root but outside the exported section folders
 * (`skills`, `agents`, `commands`, `rules`, `output-styles`, `hooks`), or in one
 * of them where some part of the path below the folder matches a name its copy
 * excludes (`state`, `.git`, a hook tree's `tests` …), and for a folder link
 * whose target is `hooks/` or below it (a copy through it would skip the hooks
 * tree's exclusions). The normal export never ships such a path (the raw
 * `settings.json` with its `env` values, `history.jsonl`, the shell snapshots),
 * so nothing is copied through the link. It covers a staged link, a link nested
 * in a linked folder, a linked `hooks/` or hook support folder, and a hook script
 * `settings.json` registers that is itself such a link or sits under `hooks/`
 * below a refused folder link (its registration is dropped). ASCII, with no
 * quote, `$`, backslash or backtick, like the reasons above.
 */
export const ARCHIVE_LINK_INTO_ROOT_OMISSION_REASON =
  "not exported: a link to a file or folder inside the config root";

/**
 * #4321 (Item 7) / #5549 (OOS-1): the omission reason both exporters record for
 * a hook support folder (`hooks/lib`, `hooks/_shared`) whose copy failed (the
 * tar that reads it could not read a file or folder in it). What the copy
 * extracted is removed, the hooks-tree copy leaves the folder out, and it gets
 * no `hookSupport` entry. ASCII, like the reasons above.
 */
export const ARCHIVE_HOOK_SUPPORT_COPY_OMISSION_REASON =
  "hook support folder could not be copied";

/**
 * #4321 (Item 7) / #5549 (OOS-1): the omission reason both exporters record when
 * the hooks-tree copy fails (the tar that reads `hooks/` could not read a file
 * or folder in it). Nothing of that copy is extracted; the scripts the
 * registration walk staged and the support folders stay. ASCII, like the
 * reasons above.
 */
export const ARCHIVE_HOOK_TREE_COPY_OMISSION_REASON =
  "hooks folder could not be copied in full";

/**
 * #4172: the omission reason the PowerShell exporter records, off Windows, for
 * a link it would copy in (or an entry under a linked folder) whose path holds
 * a backslash. Its path cmdlets read a backslash there as a folder separator,
 * even with -LiteralPath, so a cmdlet given that path would check or copy a
 * different one (a folder `a\..\..\..\x` in `hooks/` is read as `../../x`,
 * outside the staging folder). The bash exporter reads a backslash as a name
 * byte and never records this. ASCII, with no quote, `$`, backslash or
 * backtick, like the reasons above.
 */
export const ARCHIVE_BACKSLASH_PATH_OMISSION_REASON =
  "not exported: a link, or an entry under a linked folder, whose path holds a backslash, which PowerShell reads as a folder separator off Windows, so it could not be checked";

/**
 * #4172: the omission reason both exporters record for a hook registration
 * whose staged path would land outside the staging folder once its `..` parts
 * are taken (`hooks/../../x`, or on PowerShell off Windows
 * `hooks/a\..\..\..\x`, where a backslash is a separator). That path is built
 * from settings.json, so copying it would write outside the staging folder,
 * onto whatever file sits there. The registration is dropped and the script is
 * not copied for it. The surface is the refused staged path as registered.
 * ASCII, with no quote, `$`, backslash or backtick, like the reasons above.
 */
export const ARCHIVE_HOOK_PATH_ESCAPE_OMISSION_REASON =
  "not exported: a hook registration whose staged path would land outside the staging folder is dropped, and the script is not copied for it";

/**
 * #4172: the omission reason both exporters record, in place of
 * {@link ARCHIVE_HOOK_SLOT_TAKEN_OMISSION_REASON}, when the only thing that
 * stopped the re-staged copy is a hooks/ folder that cannot be listed (no
 * conflicting name was found). ASCII, with no quote, `$`, backslash or
 * backtick, like the reasons above.
 */
export const ARCHIVE_HOOK_SLOT_UNLISTABLE_OMISSION_REASON =
  "not exported: the script of a hook registered outside hooks/ is not copied, because hooks/ cannot be listed to show that its name is free; its registration is kept";

/**
 * #4172: the omission reason both exporters record when a hook path that
 * leaves `hooks/` (inside staging) would be staged as `hooks/<name>`, but a
 * name matching it without regard to case already holds different bytes:
 * staged by an earlier registration, or present in the source `hooks/` folder.
 * The script is not copied, so it never replaces another hook's bytes (first
 * writer wins, as the importer stages hooks) and never adds a case twin. The
 * same bytes are no conflict (one script registered for several events). The
 * registration is kept: its command still names the script's own path. Not
 * recorded when the script ships and is imported at its own path (under a
 * listed, non-dot section entry, with the same bytes). bash folds ASCII
 * letters only, from explicit letter lists (no locale or inherited shell
 * option changes it); PowerShell folds any case; the exact name is always
 * compared through the filesystem's own lookup. A hooks/ that cannot be
 * listed stops the copy too, recorded with
 * {@link ARCHIVE_HOOK_SLOT_UNLISTABLE_OMISSION_REASON}.
 * The surface is the staged path as registered. ASCII, with no quote, `$`,
 * backslash or backtick, like the reasons above.
 */
export const ARCHIVE_HOOK_SLOT_TAKEN_OMISSION_REASON =
  "not exported: the script of a hook registered outside hooks/ is not copied, because another hook with different content already has that name in hooks/; its registration is kept";

/**
 * #5604: the omission reason both exporters record for a registered hook
 * script they cannot read (a mode-000 file, inside or outside hooks/). The
 * copy would stop the whole export, so the script is not copied and its
 * registration is dropped, as for a missing file. The credential refusal is
 * checked first and keeps its own reason. The surface is the staged path as
 * registered (`hooks/<name>`). ASCII, with no quote, `$`, backslash or
 * backtick, like the reasons above.
 */
export const ARCHIVE_HOOK_UNREADABLE_OMISSION_REASON =
  "not exported: the script of a hook registration could not be read, so it is not copied and its registration is dropped";

/** The name-only part of the rule (the filesystem checks live in each emitter). */
export type ClaudeMdIncludeNameVerdict =
  | "ok"
  | "notCanonical"
  | "notMarkdown"
  | "shadowsClaudeMd";

/**
 * Reference classifier for the name-only checks, in the order both emitters
 * apply them. The runtime tests assert each emitter's outcome equals this.
 */
export function classifyClaudeMdIncludeName(
  inc: string
): ClaudeMdIncludeNameVerdict {
  const wrapped = `/${inc}/`;
  if (
    wrapped.includes("//") ||
    wrapped.includes("/./") ||
    wrapped.includes("/../")
  ) {
    return "notCanonical";
  }
  const base = inc.slice(inc.lastIndexOf("/") + 1);
  if (!/\.md$/i.test(base)) return "notMarkdown";
  if (base.toLowerCase() === "claude.md") return "shadowsClaudeMd";
  return "ok";
}

/**
 * #5239: the instance label as it may appear in a script's `#` header comment.
 *
 * The label comes from the operator's `federation.nodeLabel`. A CR or LF in it
 * would end the comment line, so the rest of the label would run as a command
 * when the script is piped into `bash` or `iex`. Bash ends a comment only at LF
 * and PowerShell at CR or LF, so replacing every run of CR/LF with one space
 * keeps the label on its comment line in both dialects.
 */
export function headerCommentLabel(label: string): string {
  return label.replace(/[\r\n]+/g, " ");
}

/**
 * A bash single-quoted string literal for `s` (each `'` becomes `'\''`): the
 * one quoting rule every bash builder in this folder embeds values with.
 */
export function bashSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * A PowerShell single-quoted string literal for `s` (each `'` doubled): the
 * PowerShell twin of {@link bashSingleQuote}.
 */
export function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * #5849: the characters that end a word in a hook command, for the literal
 * source-home step. It rewrites a POSIX home only where a path can start: at the
 * start of the command or right after one of these, optionally through a quote that
 * opens the word. A `/mnt/root/.claude` is not the home of `HOME=/root`, and
 * `"$CLAUDE_PROJECT_DIR"/.claude` under `HOME=/` is not either: that quote closes
 * a word. It leaves any other position as written, because a wrong rewrite corrupts
 * the command; bash's `/home/<user>` rule then runs at any position. `:` and `=` are here for `PYTHONPATH=/a:/root/.claude/lib`, so a
 * remote or container path equal to the home is rewritten too
 * (`scp box:/root/.claude/x`); no text test can tell the two apart.
 */
const HOOK_HOME_WORD_BREAKS = " \t\n\r=:;&|(<>,";

/** #5849: the quotes that can open a word in a hook command. */
const HOOK_HOME_OPEN_QUOTES = "\"'`";

/**
 * #5849: what the bash literal rewrite writes, swapped for the token right after
 * the shipped `/home/<user>` sed rule. It holds a `/` so that rule, whose `<user>`
 * is `[^/ ]+`, cannot read across it: written as the token straight away,
 * `cd /home/alice;/home/alice/.claude/x.sh` would lose its `/home/alice;`. A
 * command that already spells this text has it read as the marker.
 */
export const HOOK_HOME_MARKER = "@HAPI-HOME/TOKEN@";

/** A jq string literal with no `'`, so a program needs no shell escaping. */
function jqLiteral(s: string): string {
  return JSON.stringify(s).replace(/'/g, "\\u0027");
}

/**
 * #5849: the jq program that rewrites `$n` (the literal home plus `/.claude`) in
 * `$c` to {@link HOOK_HOME_MARKER}, with jq's literal `split`: no regex escaping
 * of a home path (see `settingsScriptNormalizeJq`). The text accumulated so far
 * decides each occurrence, against {@link HOOK_HOME_WORD_BREAKS} and
 * {@link HOOK_HOME_OPEN_QUOTES}.
 */
export function hookHomeMarkerJq(): string {
  const breaks = jqLiteral(HOOK_HOME_WORD_BREAKS);
  const quotes = jqLiteral(HOOK_HOME_OPEN_QUOTES);
  return (
    `def brk: . as $e | $e == "" or (${breaks} | contains($e)); ` +
    `($c | split($n)) as $p | reduce $p[1:][] as $x ($p[0]; . as $a | $a[-1:] as $l | $a + ` +
    `(if ($l | brk) or ((${quotes} | contains($l)) and ($a[-2:-1] | brk)) then ` +
    `"${HOOK_HOME_MARKER}" else $n end) + $x)`
  );
}

/** #5849: the same test as {@link hookHomeMarkerJq}, as a .NET lookbehind. */
export function hookHomeLeadRegex(): string {
  const breaks = HOOK_HOME_WORD_BREAKS.replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `(?<=(?:^|[${breaks}])[${HOOK_HOME_OPEN_QUOTES}]?)`;
}

/**
 * #6034: the start of the `hooks` omission both exporters record for a hook
 * registration whose JSON shape they cannot read. The rest names the part by its
 * path in settings.json and what it is not: `hooks.PreToolUse[1].hooks is not a
 * list` (indices from 0).
 */
export const HOOK_REGISTRATION_SHAPE_OMISSION_PREFIX =
  "not exported: a hook registration in settings.json could not be read: ";

/**
 * #6034: the jq program the bash exporter reads hook registrations with. It
 * checks the type at every level, so a valid JSON file never makes it fail: each
 * registration it can read is one `{event, command, matcher?}` row, and each part
 * it cannot read is one `{omit: <reason>}` row, so the parts beside it are kept.
 * jq still exits non-zero for a file that is not valid JSON or cannot be read.
 * Settings that are not an object, a null `hooks` or event, a block with no
 * `hooks` and an entry with no `command` give no row. Before #6034 a null event
 * failed the whole read; it now reads like an empty list, which Windows
 * PowerShell 5.1 can turn one into. The PowerShell twin applies the same checks
 * with the same reasons.
 */
export function hookRegistrationReaderJq(): string {
  const prefix = jqLiteral(HOOK_REGISTRATION_SHAPE_OMISSION_PREFIX);
  return (
    `def bad($p; $k): {omit: (${prefix} + $p + " is not " + $k)}; ` +
    `if type != "object" or .hooks == null then empty ` +
    `elif (.hooks | type) != "object" then bad("hooks"; "an object") ` +
    `else .hooks | to_entries[] as $e | ("hooks." + $e.key) as $ep ` +
    `| if $e.value == null then empty ` +
    `elif ($e.value | type) != "array" then bad($ep; "a list") ` +
    `else $e.value | to_entries[] as $b ` +
    `| ($ep + "[" + ($b.key | tostring) + "]") as $bp | $b.value as $blk ` +
    `| if ($blk | type) != "object" then bad($bp; "an object") ` +
    `elif $blk.hooks == null then empty ` +
    `elif ($blk.hooks | type) != "array" then bad($bp + ".hooks"; "a list") ` +
    `else $blk.hooks | to_entries[] as $h ` +
    `| ($bp + ".hooks[" + ($h.key | tostring) + "]") as $hp ` +
    `| if ($h.value | type) != "object" then bad($hp; "an object") ` +
    `elif $h.value.command == null then empty ` +
    `elif ($h.value.command | type) != "string" then bad($hp + ".command"; "a string") ` +
    `else {event: $e.key, command: $h.value.command} ` +
    `+ (if ($blk.matcher // "") != "" then {matcher: $blk.matcher} else {} end) ` +
    `end end end end`
  );
}

/**
 * #5239: the self-upload URL both emitters embed, or `undefined` when the
 * input is not an http(s) URL.
 *
 * The URL is built from `webappUrl` / `federation.selfUrl`, or, when neither is
 * set, from the requesting client's own `X-Forwarded-Host` / `X-Forwarded-Proto`
 * (`porterKey.ts` `deriveInstanceProvenance`). Anything that does not parse, or
 * whose scheme is not http/https, gets the legacy Download/Copy script with no
 * upload step — the same fallback the serving route uses when it has no origin.
 * The parsed `href` is returned, so the script carries the URL that was checked.
 *
 * Parsing is a gate, not an escape: a WHATWG URL host may still contain `'`,
 * `$`, `(` and `)`, so each emitter quotes the result for its own dialect.
 */
export function validUploadUrl(
  uploadUrl: string | undefined
): string | undefined {
  if (!uploadUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    return undefined;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? parsed.href
    : undefined;
}

/**
 * #5985: the `sh` script both exporters run (bash through `/bin/sh -c`, the
 * PowerShell twin off Windows through `'…' | & '/bin/sh'`) to ask whether a
 * link target that the text and `-ef` parent tests do not place inside the
 * config root is nonetheless the same file (one device and inode) as an entry
 * below it: a bind mount of a folder inside the root (`~/.claude/projects`
 * bound at `/mnt/proj`), renamed or not, or a file under one. Inputs travel in
 * the environment: `HAPI_PORTER_EF_T` (the target's physical path),
 * `HAPI_PORTER_EF_A` (`CONFIG_ROOT_PHYS`) and `HAPI_PORTER_EF_S` (a set-file
 * path in the exporter's `$WORK`). Output: nothing (not held: ship), one in-root
 * path per line (the entries that are the same file; each caller maps them
 * through its own section test, and refuses when any is refused), or `?` (the
 * check cannot answer: refuse). The status is normally 0, but a redirect that
 * fails (an unwritable `$WORK`, for example) makes `sh` exit non-zero with no
 * output, so each caller treats a non-zero status as `?` (bash `|| return 0`,
 * PowerShell's `$LASTEXITCODE` check): removing that check fails open.
 *
 * Once per run it lists the inode number of every entry below the root with
 * `find … -exec ls -di {} +`: `ls` stats each operand, so a mount point inside
 * the root reports its mounted root (`ls -iRA` does not list the root itself,
 * and some `ls` versions take `-i` from `readdir`). The listing is complete
 * unless it reports an error line that does not end in ": No such file or
 * directory" or does not name a path below the root (only an entry a live
 * session removed mid-listing is answered; `find` reports a missing `ls` in the
 * same words, but names `ls`, and a folder whose name holds those words still
 * ends its line in "Permission denied"; under GNU tools a root path with a
 * byte outside printable ASCII (and, in `find`'s lines, a `'` or `\`) is
 * escaped in those lines, so there a vanished entry counts as an error too,
 * #6090), fails with no message, or is
 * cut short (on a full disk `mawk` reports the write failure and still exits 0,
 * so the list must end with the line `e` that `awk`'s END writes). An
 * incomplete listing answers `?` for every link, so a root holding a folder the
 * user cannot search refuses every link outside the root (a bind source below
 * that folder cannot be ruled out). Each lookup takes the target and every
 * folder above it, so a file created after the listing is still found through
 * the folder the bind mounts. A number match (or a lookup that fails or prints
 * nothing) is confirmed live with `find -samefile` and `test -ef` (BSD `find`
 * matches `-samefile` by inode number alone), after #5953's one-entry check
 * that `find` has `-samefile` and `-exec` and `test` has `-ef`; that walk
 * answers `?` when it dies (exit above 1) or fails for any reason other than an
 * entry below the root that vanished. A number match alone is never taken as
 * the same file, because inode numbers repeat across volumes; but where the
 * capability check fails, a number match answers `?`, so on such a host the
 * lookup decides which honest links ship.
 *
 * R2 (the PowerShell embedding): no `'`, `exit`, `&&` or `||`, ASCII only,
 * and `t=` first. A byte-order mark in front turns the first word into a
 * command, so the line opens with `t=;` and assigns `t` again after it: an
 * inherited `t` is never the path checked. One line: the fragments below are
 * joined with spaces.
 */
export const ROOT_HOLDS_SH = [
  "t=; t=$HAPI_PORTER_EF_T; a=$HAPI_PORTER_EF_A; s=$HAPI_PORTER_EF_S; o=;",
  'if [ -z "$t" ]; then o=?; fi; if [ -z "$a" ]; then o=?; fi; if [ -z "$s" ]; then o=?; fi;',
  // The listing, once per run.
  'if [ -z "$o" ]; then if [ ! -f "$s.ok" ]; then if [ ! -f "$s.bad" ];',
  'then { LC_ALL=C find "$a" -exec ls -di {} + 2> "$s.err"; echo $? > "$s.rc"; }',
  '| LC_ALL=C awk "\\$1 ~ /^[0-9]+\\$/ {print \\$1} END {print \\"e\\"}" > "$s"; r=$(cat "$s.rc"); b=0;',
  // Answered: only an entry below the root that vanished mid-listing (grep
  // exits 1 when every line says so; 0 is another error, above 1 no answer).
  'LC_ALL=C grep -v ": No such file or directory\\$" "$s.err" > /dev/null; if [ $? != 1 ]; then b=1; fi;',
  'LC_ALL=C grep -vF "$a/" "$s.err" > /dev/null; if [ $? != 1 ]; then b=1; fi;',
  'if [ "$r" != 0 ]; then if [ ! -s "$s.err" ]; then b=1; fi; fi;',
  // A list cut short lacks the end line.
  'if [ "$(tail -n 1 "$s" 2> /dev/null)" != e ]; then b=1; fi;',
  'if [ "$b" = 1 ]; then : > "$s.bad"; else : > "$s.ok"; fi; fi; fi;',
  'if [ -f "$s.bad" ]; then o=?; fi; fi;',
  // The lookup: the target and every folder above it.
  'if [ -z "$o" ]; then set -- "$t"; p=$t;',
  'while :; do case $p in /) break ;; esac; p=${p%/*}; if [ -z "$p" ]; then p=/; fi; set -- "$@" "$p"; done;',
  'LC_ALL=C ls -di "$@" 2> /dev/null | LC_ALL=C awk "\\$1 ~ /^[0-9]+\\$/ {print \\$1}" > "$s.n"; c=0;',
  'if LC_ALL=C grep -qxF -f "$s.n" "$s"; then c=1; else g=$?; if [ "$g" -gt 1 ]; then c=1; fi; fi;',
  'if [ ! -s "$s.n" ]; then c=1; fi;',
  // A match: #5953's capability check, then the live confirm.
  'if [ "$c" = 1 ]; then k=$(find "$a" -prune -samefile "$a" -exec test {} -ef "$a" \\; -print 2> /dev/null);',
  'if [ "$k" != "$a" ]; then o=?; fi; if [ -z "$o" ];',
  'then m=$(LC_ALL=C find "$a" -samefile "$t" -exec test {} -ef "$t" \\; -print -prune 2> "$s.ferr"); f=$?;',
  'if [ "$f" -gt 1 ]; then o=?; fi; if [ "$f" = 1 ]; then',
  'LC_ALL=C grep -v ": No such file or directory\\$" "$s.ferr" > /dev/null; if [ $? != 1 ]; then o=?; fi;',
  'LC_ALL=C grep -vF "$a/" "$s.ferr" > /dev/null; if [ $? != 1 ]; then o=?; fi;',
  'if [ ! -s "$s.ferr" ]; then o=?; fi; fi; if [ -z "$o" ]; then o=$m; fi; fi; fi; fi;',
  'if [ -n "$o" ]; then printf "%s\\n" "$o"; fi',
].join(" ");
