// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the top-level script an executable setting runs
 * (issue #4173).
 *
 * `statusLine.command` and `apiKeyHelper` are exported as VALUES (#2565 F5),
 * but the file such a value runs — RP1's `$HOME/.claude/statusline-command.sh`
 * — was never carried, so an import wrote a setting that runs a missing file.
 * Every export surface now carries `~/.claude/<name>` into the archive folder
 * {@link SETTINGS_SCRIPTS_DIR} when `<name>` is a TOP-LEVEL file with a script
 * extension that one of those two values names, and records an omission for
 * everything else. The importer writes such a file only at the exact path an
 * imported value names, under a dedicated planned kind (`settings-script`).
 *
 * ONE RULE, FIVE CONSUMERS. The bash exporter and the extraction prompt's
 * Step 11 block run the jq rendering (`./settingsScriptShell`), the PowerShell
 * exporter the .NET rendering (`./settingsScriptPowerShell`), and the importer
 * and the tests this TypeScript reference. Every one reads the patterns,
 * reasons and name rule below. A few structural steps are written once per
 * dialect (the `/dev/` and quote handling, the `statusLine.command` shape, the
 * PowerShell key list), and the parity tests run every dialect over one shared
 * table to catch drift. The patterns use only the regex subset jq
 * (Oniguruma), .NET and JavaScript agree on: explicit ASCII case classes and
 * never an IgnoreCase flag (.NET IgnoreCase folds U+212A Kelvin and U+017F
 * long s onto ASCII letters, and jq's `"i"` is Unicode-aware), and `[ \t\r\n]`
 * rather than `\s` (the three disagree on Unicode whitespace).
 *
 * A reference is LEXICAL: the rule finds `$HOME/.claude/<rel>`,
 * `${HOME}/.claude/<rel>` or `~/.claude/<rel>` anywhere in the command (after an
 * interpreter, in quotes, with arguments) and never interprets shell quoting.
 *
 * NODE-FREE (R7): like every non-test module under `shared/src/porter`, this
 * file only holds constants and pure functions (the web bundles it).
 */
import {
  ARCHIVE_CREDENTIAL_OMISSION_REASON,
  ARCHIVE_LINK_UNCHECKED_OMISSION_REASON,
  DIMENSION_DIRS,
  SECRET_TOKEN_PREFIX_GROUP,
} from "./exportShared";
import {
  EXECUTABLE_SETTINGS_KEYS,
  credentialPathPart,
  type ExecutableSettingsKey,
} from "./manifest";

/** The archive folder that carries the scripts (`settings-scripts/<name>`). */
export const SETTINGS_SCRIPTS_DIR = "settings-scripts";

/** The file extensions that make a top-level file a carried script. */
export const SETTINGS_SCRIPT_EXTENSIONS = [
  "sh",
  "bash",
  "zsh",
  "fish",
  "py",
  "js",
  "mjs",
  "cjs",
  "ts",
  "rb",
  "pl",
  "ps1",
] as const;

/** `sh` → `[sS][hH]`: each ASCII letter as an explicit two-case class. */
function asciiCaseClass(word: string): string {
  return [...word]
    .map(c => (/^[a-z]$/.test(c) ? `[${c}${c.toUpperCase()}]` : c))
    .join("");
}

const EXTENSION_GROUP =
  SETTINGS_SCRIPT_EXTENSIONS.map(asciiCaseClass).join("|");

/**
 * A script name: at least one character, a dot, then a listed extension in any
 * ASCII case. Canonical (jq and JavaScript) form; the .NET form is
 * {@link SETTINGS_SCRIPT_NAME_PATTERN_DOTNET}.
 */
export const SETTINGS_SCRIPT_NAME_PATTERN = `^.+\\.(${EXTENSION_GROUP})$`;

/**
 * The .NET rendering of {@link SETTINGS_SCRIPT_NAME_PATTERN}: `\z` instead of
 * `$` (a .NET `$` also matches before a trailing newline, so `x.sh<LF>` would
 * pass) and `(?s)` so `.` crosses a newline, as the bash glob's `?` and `*` do.
 */
export const SETTINGS_SCRIPT_NAME_PATTERN_DOTNET = `(?s)^.+\\.(${EXTENSION_GROUP})\\z`;

/**
 * The bash `case` form of the same name rule, for a link target's final name:
 * `?*.[sS][hH]|?*.[bB][aA][sS][hH]|…`. A glob matches the whole string, so
 * `x.sh<LF>` fails; the leading `?` needs one character before the dot, like
 * the regex's `.+`.
 */
export function settingsScriptCaseGlob(): string {
  return SETTINGS_SCRIPT_EXTENSIONS.map(e => `?*.${asciiCaseClass(e)}`).join(
    "|"
  );
}

/**
 * A config-root reference in a command. Group 1 is the home spelling, group 2
 * the `<rel>` (jq `.captures[1]`, .NET `Groups[2]`, JavaScript `m[2]`). The `~`
 * spelling needs a word boundary before it (start, whitespace, a quote or `=`),
 * because a shell expands `~` only at the start of a word.
 */
export const SETTINGS_SCRIPT_REF_PATTERN =
  '(\\$HOME|\\$\\{HOME\\}|(?<![^ \\t\\r\\n"\\x27=])~)/\\.claude/([A-Za-z0-9._@%+/-]+)';

/** A word that IS a config-root reference (never reported as "outside"). */
export const SETTINGS_SCRIPT_REF_START_PATTERN =
  "^(\\$HOME|\\$\\{HOME\\}|~)/\\.claude/";

/** How a command splits into words for the outside-reference rule. */
export const SETTINGS_SCRIPT_WORD_SPLIT_PATTERN = "[ \\t\\r\\n]+";

/**
 * A word that names a file outside the config root: absolute, home-relative,
 * `./` or `../` relative, or a Windows drive path. Config-root references and
 * `/dev/...` are excluded by the extractor.
 */
export const SETTINGS_SCRIPT_OUTSIDE_START_PATTERN =
  "^(/|~/|\\$HOME/|\\$\\{HOME\\}/|\\./|\\.\\./|[A-Za-z]:[\\\\/])";

/**
 * The folders whose own export carries a file (#4160 sections and `hooks`), so a
 * reference into one is not carried by this channel.
 */
export const SETTINGS_SCRIPT_SECTION_FOLDERS: readonly string[] = [
  ...DIMENSION_DIRS,
  "hooks",
];

/**
 * A known credential-prefix token in a script's bytes (D2): the shared
 * prefixes at a word boundary, then a token body of 16 or more characters.
 * Uses only the ERE subset `grep -E`, .NET and JavaScript share (no `\s`, no
 * lookaround).
 */
export const SETTINGS_SCRIPT_CREDENTIAL_PATTERN = `(^|[^A-Za-z0-9_])(${SECRET_TOKEN_PREFIX_GROUP})[A-Za-z0-9_.-]{16,}`;

/**
 * The one prefix every settings-script omission surface starts with, so the
 * Step 11 block can replace the model-written ones by `startswith`.
 */
export const SETTINGS_SCRIPT_SURFACE_PREFIX = "settings script: ";

/** The omission surface for one `(key, reference)`. */
export function settingsScriptSurface(
  key: ExecutableSettingsKey,
  ref: string
): string {
  return `${SETTINGS_SCRIPT_SURFACE_PREFIX}${key} runs ${ref}`;
}

/**
 * The exporters' omission reasons. ASCII, with no quote, `$`, backslash or
 * backtick, so each embeds verbatim in a single-quoted bash or PowerShell
 * literal (the #4154 rule). A credential-bearing name, and a link chain that
 * passes through one (PM ruling B1), reuse the #4172 reasons.
 */
export const SETTINGS_SCRIPT_SKIP_REASONS = {
  notCanonical:
    "not exported: a script reference must be a plain path inside the config root (no . or .. segment, no doubled /)",
  notTopLevel:
    "not exported: only a script directly inside the config root is carried (this one is in a subfolder)",
  notScript: `not exported: only a file named with a script extension is carried (${SETTINGS_SCRIPT_EXTENSIONS.join(", ")})`,
  credentialName: ARCHIVE_CREDENTIAL_OMISSION_REASON,
  notFound: "not exported: the referenced file does not exist",
  notRegularFile: "not exported: the reference is not a regular file",
  linkTargetNotScript:
    "not exported: the reference is a symbolic link whose target is not a script file",
  linkThroughCredential: ARCHIVE_CREDENTIAL_OMISSION_REASON,
  linkUnchecked: ARCHIVE_LINK_UNCHECKED_OMISSION_REASON,
  unreadable: "not exported: the script could not be read",
  looksLikeCredential:
    "not exported: the script appears to contain a credential, so recreate it on the destination",
  sectionNotStaged:
    "not exported: the script is inside a folder whose export excludes it",
  outsideConfigRoot:
    "not exported: the command runs a file outside the Claude config root, so make sure it exists on the destination",
} as const;

/** The name-only verdict for a `<rel>` (the filesystem checks live in each exporter). */
export type SettingsScriptNameVerdict =
  | "ok"
  | "notCanonical"
  | "section"
  | "notTopLevel"
  | "credentialName"
  | "notScript";

/** Every verdict a reference can get: the name verdicts plus `outside`. */
export type SettingsScriptRefVerdict = SettingsScriptNameVerdict | "outside";

/** One reference an executable setting value makes. */
export type SettingsScriptRef =
  | {
      key: ExecutableSettingsKey;
      ref: string;
      rel: string;
      verdict: SettingsScriptNameVerdict;
    }
  | { key: ExecutableSettingsKey; ref: string; verdict: "outside" };

/**
 * Classify a reference's `<rel>`, in the order every dialect applies:
 * non-canonical; inside a section folder; in any other subfolder; a
 * credential-bearing name (#4172's rule); not a script name; otherwise `ok`.
 */
export function classifySettingsScriptRef(
  rel: string
): SettingsScriptNameVerdict {
  const wrapped = `/${rel}/`;
  if (
    wrapped.includes("//") ||
    wrapped.includes("/./") ||
    wrapped.includes("/../")
  ) {
    return "notCanonical";
  }
  const segs = rel.split("/");
  if (segs.length >= 2) {
    return SETTINGS_SCRIPT_SECTION_FOLDERS.includes(segs[0])
      ? "section"
      : "notTopLevel";
  }
  if (credentialPathPart(rel) !== null) return "credentialName";
  if (!new RegExp(SETTINGS_SCRIPT_NAME_PATTERN).test(rel)) return "notScript";
  return "ok";
}

/**
 * The command string an executable setting carries, or `null`: `apiKeyHelper`
 * when it is a string, `statusLine.command` when `statusLine` is an object and
 * `command` a string.
 */
export function executableSettingCommand(
  settings: Record<string, unknown>,
  key: ExecutableSettingsKey
): string | null {
  const v = settings[key];
  if (key === "apiKeyHelper") return typeof v === "string" ? v : null;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const command = (v as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

/** Codepoint order, as jq sorts strings. */
function byCodepoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i].codePointAt(0) ?? 0) - (y[i].codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Strip one leading and one trailing `'` or `"`. */
function stripQuotes(word: string): string {
  return word.replace(/^["']/, "").replace(/["']$/, "");
}

/**
 * Every reference the two executable values make, key by key in
 * {@link EXECUTABLE_SETTINGS_KEYS} order. Per key: each config-root reference
 * (unique by the whole match, sorted), then each word that names a file
 * outside the config root (unique, sorted). This is the reference the jq and
 * .NET renderings are tested against.
 */
export function collectSettingsScriptRefs(
  settings: Record<string, unknown>
): SettingsScriptRef[] {
  const out: SettingsScriptRef[] = [];
  const refStart = new RegExp(SETTINGS_SCRIPT_REF_START_PATTERN);
  const outsideStart = new RegExp(SETTINGS_SCRIPT_OUTSIDE_START_PATTERN);
  for (const key of EXECUTABLE_SETTINGS_KEYS) {
    const command = executableSettingCommand(settings, key);
    if (command === null) continue;
    const refs = new Map<string, string>();
    for (const m of command.matchAll(
      new RegExp(SETTINGS_SCRIPT_REF_PATTERN, "g")
    )) {
      if (!refs.has(m[0])) refs.set(m[0], m[2]);
    }
    for (const ref of [...refs.keys()].sort(byCodepoint)) {
      const rel = refs.get(ref) as string;
      out.push({ key, ref, rel, verdict: classifySettingsScriptRef(rel) });
    }
    const outside = new Set<string>();
    for (const raw of command.split(
      new RegExp(SETTINGS_SCRIPT_WORD_SPLIT_PATTERN)
    )) {
      if (raw.length === 0) continue;
      const word = stripQuotes(raw);
      if (
        outsideStart.test(word) &&
        !refStart.test(word) &&
        !word.startsWith("/dev/")
      ) {
        outside.add(word);
      }
    }
    for (const ref of [...outside].sort(byCodepoint)) {
      out.push({ key, ref, verdict: "outside" });
    }
  }
  return out;
}

/**
 * D3: rewrite the literal `<L>/.claude/` prefix to `$HOME/.claude/` in the two
 * executable values, for each source home literal `L`. Changes nothing else in
 * either value and never adds a key (a `statusLine` without a string `command`
 * is returned as is). Returns a new object. The bash exporter does the same
 * with a literal split/join and the PowerShell exporter with a literal replace;
 * on Windows PowerShell also matches the backslash and `%USERPROFILE%`
 * spellings, with an escaped case-insensitive replace this reference does not
 * model.
 */
export function normalizeExecutableSettings(
  settings: Record<string, unknown>,
  homeLiterals: readonly string[]
): Record<string, unknown> {
  const swap = (value: string): string =>
    homeLiterals.reduce(
      (v, home) => v.split(`${home}/.claude/`).join("$HOME/.claude/"),
      value
    );
  const out: Record<string, unknown> = { ...settings };
  if (typeof out.apiKeyHelper === "string") {
    out.apiKeyHelper = swap(out.apiKeyHelper);
  }
  const statusLine = out.statusLine;
  if (
    statusLine !== null &&
    typeof statusLine === "object" &&
    !Array.isArray(statusLine) &&
    typeof (statusLine as Record<string, unknown>).command === "string"
  ) {
    const sl = statusLine as Record<string, unknown>;
    out.statusLine = { ...sl, command: swap(sl.command as string) };
  }
  return out;
}

/**
 * D4: is a carried settings script held — not written — given the
 * `<settings.json>#<key>` gates whose overwrite would let it land? Held iff it
 * has a gate and none of them is chosen for overwrite. The importer's commit
 * and the web review both read this one rule.
 */
export function settingsScriptGateHolds(
  gatedBy: readonly string[] | undefined,
  overwrite: ReadonlySet<string>
): boolean {
  const gate = gatedBy ?? [];
  return gate.length > 0 && !gate.some(k => overwrite.has(k));
}
