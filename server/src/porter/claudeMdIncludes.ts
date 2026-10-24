// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md `@`-include destination policy for the Configuration Porter import
 * (issue #4143). Split out of `importArchive.ts` (#2077 max-lines) as a pure
 * module so the rule is unit-testable on its own.
 *
 * 🔴 Why this exists: an include is planned as a WHOLE-FILE write under
 * `<claudeDir>`. Without a destination rule, an archive could list
 * `settings.json` (or `.claude.json`, `.config.json`, …) as a CLAUDE.md include
 * and land that entire file — outside the key-wise `mergeSettings` /
 * `importMcpServers` merges, the F5 `PORTABLE_SETTINGS_KEYS` allowlist, and the
 * #2565 values-visible review. Wherever the target file does not already exist,
 * that write needs no conflict and no prompt — and `.config.json` almost never
 * exists, so it is exposed on nearly every destination, not only a fresh one.
 *
 * The files an include could otherwise reach, and why each is reserved:
 * `settings.json` (hooks, `apiKeyHelper`, `statusLine` commands),
 * `settings.local.json` (hooks, `enabledPlugins` — read as project-local
 * settings when a session's project root is `$HOME`), `.claude.json` (global
 * config — user-scope MCP servers and project trust — inside the config root
 * whenever it is redirected), `.config.json` (Claude Code's legacy global-config
 * path, which REPLACES `.claude.json` whenever it exists), `.credentials.json`
 * (OAuth credentials), and any hook or statusline script. Every one of them is
 * non-markdown.
 *
 * So the rule is an ALLOWLIST on the resolved destination, not a denylist of
 * those names: an include may only write a top-level `*.md` sibling of
 * CLAUDE.md, or (#4156) a `*.md` file under `claude-includes/`. A config file
 * Claude Code adds later is excluded with no code change here — the denylist
 * that names the obvious three would have missed `.config.json`.
 *
 * #4156: a NESTED include (`@docs/guide.md`) lands at
 * `claude-includes/docs/guide.md` and its CLAUDE.md reference is rewritten to
 * match ({@link rewriteIncludeRefs}). The namespace is one folder no Claude
 * Code feature reads, so the allowlist stays fail-closed: keeping the nested
 * path as written would put a `.md` file in `commands/`, `agents/` or `rules/`,
 * which Claude Code loads as a command, an agent or a rule — and so would any
 * folder with such a meaning that a later Claude Code release adds.
 *
 * A skipped include is never staged and never written. It is reported to the
 * operator as a plan `omissions[]` entry, one per include with a unique
 * `surface`, and also in `policySkips`, which the import panel renders as its
 * "Refused by import policy" list.
 */
import { relative } from "node:path";
import {
  CLAUDE_INCLUDES_DIR,
  CLAUDE_MD_INCLUDE_LINE_PATTERN,
  type Omission,
} from "@hapi/protocol/porter";

/** Why a CLAUDE.md include is not imported (#4143, #4156, #5202). */
export type IncludeSkipReason =
  | "not-regular-file"
  | "absolute-or-home"
  | "dot-segment"
  | "outside-include-area"
  | "not-markdown"
  | "shadows-claude-md"
  | "duplicate-destination";

/** The include namespace as a path prefix (`claude-includes/`). */
const NAMESPACE = `${CLAUDE_INCLUDES_DIR}/`;

/**
 * Folded destination key. Case-insensitive filesystems alias `RULES.md` and
 * `rules.md`, and normalizing ones (APFS, HFS+) alias the NFC and NFD
 * spellings of `é.md` — so first-claim-wins compares NFC-normalized,
 * lower-cased keys everywhere, and the plan never depends on the filesystem.
 */
export function includeKey(destRel: string): string {
  return destRel.normalize("NFC").toLowerCase();
}

/**
 * Is `destRel` inside the include area: one top-level segment, or a path under
 * `claude-includes/` with no dot-leading segment? A `\` anywhere is outside: on
 * a POSIX host it is not a separator, so the name would be one odd segment.
 */
function inIncludeArea(destRel: string): boolean {
  if (destRel.includes("\\")) return false;
  if (!destRel.includes("/")) return true;
  if (!destRel.startsWith(NAMESPACE)) return false;
  return destRel
    .slice(NAMESPACE.length)
    .split("/")
    .every(s => s.length > 0 && !s.startsWith("."));
}

/**
 * #5202 (U11): the first dot-leading segment of a path under
 * `claude-includes/`, or `undefined`. Top-level names are not checked here:
 * a top-level `.md` sibling may start with a dot.
 */
function dotLeadingSegment(destRel: string): string | undefined {
  if (!destRel.startsWith(NAMESPACE)) return undefined;
  return destRel
    .slice(NAMESPACE.length)
    .split("/")
    .find(s => s.startsWith("."));
}

/**
 * Classify an include by its RESOLVED destination — the absolute path
 * `assertSafeEntry` returned — never by the raw archive string, because
 * `resolve()` has already collapsed spellings such as `settings.json/` to
 * `settings.json`.
 *
 * The checks run in a fixed order, so the reason stays specific: a dot-leading
 * name under `claude-includes/` (`dot-segment`, #5202), the area
 * (`outside-include-area`), then `.md` (so `claude-includes/hooks/x.sh` is
 * `not-markdown`), then a basename of `CLAUDE.md` at any depth, then a
 * duplicate of a destination already claimed.
 *
 * `claimed` holds the folded keys of includes already planned; the caller adds
 * each accepted destination to it.
 */
export function classifyClaudeMdInclude(
  claudeDir: string,
  destPath: string,
  claimed: ReadonlySet<string>
):
  | { ok: true; destRel: string }
  | { ok: false; destRel: string; reason: IncludeSkipReason } {
  const destRel = relative(claudeDir, destPath);
  if (!destRel.includes("\\") && dotLeadingSegment(destRel) !== undefined) {
    return { ok: false, destRel, reason: "dot-segment" };
  }
  if (!inIncludeArea(destRel)) {
    return { ok: false, destRel, reason: "outside-include-area" };
  }
  if (!/\.md$/i.test(destRel)) {
    return { ok: false, destRel, reason: "not-markdown" };
  }
  const base = destRel.slice(destRel.lastIndexOf("/") + 1);
  if (includeKey(base) === "claude.md") {
    return { ok: false, destRel, reason: "shadows-claude-md" };
  }
  if (claimed.has(includeKey(destRel))) {
    return { ok: false, destRel, reason: "duplicate-destination" };
  }
  return { ok: true, destRel };
}

/**
 * #4156: an include's reference and destination from its archive member path.
 * `ref` is the include as CLAUDE.md names it: the member path without the
 * exporter's `claude-includes/` folder (or, for a hand-built archive with a
 * nested `claudeMd.path`, without CLAUDE.md's own folder) and without a
 * trailing `/`. `rel` is the config-root path to plan: a top-level `ref` as
 * is, a `ref` already under `claude-includes/` as is (an export of an imported
 * config re-imports with no second prefix), and any other nested `ref` under
 * `claude-includes/`. `rel` keeps the member's raw spelling, so containment
 * sees every `..` left after those prefixes are stripped and refuses the
 * archive. A `..` inside a stripped `claudeMd.path` folder goes with the
 * folder; the destination it leaves is still inside the config root.
 */
export function includeDestination(
  archivePath: string,
  mdDir: string
): { ref: string; rel: string } {
  let raw = archivePath.startsWith(NAMESPACE)
    ? archivePath.slice(NAMESPACE.length)
    : archivePath;
  if (mdDir !== "." && raw.startsWith(mdDir + "/")) {
    raw = raw.slice(mdDir.length + 1);
  }
  let end = raw.length; // a loop, not /\/+$/, which backtracks on a long run
  while (end > 0 && raw[end - 1] === "/") end--;
  const ref = raw.slice(0, end);
  const keep = !ref.includes("/") || ref.startsWith(NAMESPACE);
  return { ref, rel: keep ? raw : NAMESPACE + raw };
}

/**
 * One `@`-include token, from the exporter's grammar constant with its `^`
 * dropped (the rewrite is position-independent), preceded by the start of the
 * text or whitespace — Claude Code's own import rule, `(?:^|\s)@…`.
 */
const INCLUDE_TOKEN = new RegExp(
  `(?<=^|\\s)${CLAUDE_MD_INCLUDE_LINE_PATTERN.replace(/^\^/, "")}`,
  "g"
);

/**
 * A fence line's start: up to 3 spaces, then 3+ backticks or tildes. Nothing
 * follows the run in the pattern, so a failed match cannot backtrack through
 * it (a `(.*)$` tail did: a long run then a mid-line `\r` took seconds).
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The refs a rewrite changed, so a caller can report the ones it did not. */
type Hits = Set<string> | undefined;

function rewriteText(
  text: string,
  rewrites: ReadonlyMap<string, string>,
  hits: Hits
): string {
  return text.replace(INCLUDE_TOKEN, token => {
    const to = rewrites.get(token.slice(1));
    if (to === undefined) return token;
    hits?.add(token.slice(1));
    return `@${to}`;
  });
}

/** Length of the backtick run that starts at `at`. */
function backtickRun(s: string, at: number): number {
  let n = 0;
  while (s[at + n] === "`") n++;
  return n;
}

/**
 * Rewrite one line outside its code spans. A span opens on a backtick run and
 * closes on the next run of the same length; a run with no such closer is
 * literal text. Linear: the runs are collected once, and each length keeps a
 * cursor into its runs that only moves forward.
 */
function rewriteLine(
  line: string,
  rewrites: ReadonlyMap<string, string>,
  hits: Hits
): string {
  const runs: Array<[start: number, length: number]> = [];
  for (let i = 0; i < line.length; ) {
    const n = line[i] === "`" ? backtickRun(line, i) : 0;
    if (n > 0) runs.push([i, n]);
    i += Math.max(1, n);
  }
  const byLength = new Map<number, number[]>();
  runs.forEach(([, n], r) => {
    const list = byLength.get(n);
    if (list) list.push(r);
    else byLength.set(n, [r]);
  });
  const cursor = new Map<number, number>();
  let out = "";
  let from = 0;
  for (let r = 0; r < runs.length; r++) {
    const [start, n] = runs[r];
    const list = byLength.get(n) ?? [];
    let c = cursor.get(n) ?? 0;
    while (c < list.length && list[c] <= r) c++;
    cursor.set(n, c);
    if (c >= list.length) continue; // no closer: literal backticks
    const close = list[c];
    out += rewriteText(line.slice(from, start), rewrites, hits);
    out += line.slice(start, runs[close][0] + n);
    from = runs[close][0] + n;
    r = close; // resume after the closing run
  }
  return out + rewriteText(line.slice(from), rewrites, hits);
}

/**
 * #4156: replace each whole `@<ref>` token named in `rewrites` with
 * `@<destination>`, anywhere on a line, except inside a top-level fenced block
 * (```` ``` ```` or `~~~`, opened with at most 3 spaces) or a code span closed on
 * the same line — Claude Code does not import from those. A longer token
 * (`@docs/x.md.bak`) is a different reference and stays. The scanner is
 * minimal: it still rewrites inside an indented code block, a fence nested in
 * a list or blockquote, or a span that wraps a line (example text only, since
 * every target is a planned destination), and a fence it opens where CommonMark
 * would not (one left open in a list item) leaves later references as written.
 * `hits`, when given, collects each ref the rewrite changed at least once.
 */
export function rewriteIncludeRefs(
  text: string,
  rewrites: ReadonlyMap<string, string>,
  hits?: Set<string>
): string {
  let open: string | null = null;
  return text
    .split("\n")
    .map(line => {
      const bare = line.replace(/\r$/, "");
      const fence = FENCE.exec(bare);
      const run = fence?.[1] ?? "";
      const rest = fence ? bare.slice(fence[0].length) : "";
      if (open !== null) {
        const closes =
          run[0] === open[0] && run.length >= open.length && !rest.trim();
        if (closes) open = null;
        return line;
      }
      // A backtick fence's info string has no backtick (CommonMark).
      if (fence && !(run[0] === "`" && rest.includes("`"))) {
        open = run;
        return line;
      }
      return rewriteLine(line, rewrites, hits);
    })
    .join("\n");
}

/**
 * #5202 (U16): the largest CLAUDE.md whose include references the import
 * rewrites. The rewrite is synchronous and linear (about 0.1 s per MiB on an
 * ms1-class host); a real CLAUDE.md is a few KiB, so anything past 1 MiB gets a
 * notice with the edits to make by hand instead of a request-blocking scan.
 */
export const CLAUDE_MD_REWRITE_MAX_BYTES = 1024 * 1024;

/**
 * #5202 (U16): CLAUDE.md is over {@link CLAUDE_MD_REWRITE_MAX_BYTES}, so its
 * nested include references were left as written; the notice lists each edit.
 */
export function claudeMdTooLargeNotice(
  rewrites: ReadonlyMap<string, string>
): Omission {
  const edits = [...rewrites].map(([ref, to]) => `@${ref} → @${to}`);
  return {
    surface: "CLAUDE.md",
    reason: `CLAUDE.md is larger than 1 MiB, so its include references were not rewritten: point each one at claude-includes/ by hand (${edits.join(", ")})`,
  };
}

/** A UTF-8 byte order mark as it reads through a `latin1` view. */
const LATIN1_BOM = "\u00ef\u00bb\u00bf";

/**
 * #4156: CLAUDE.md's bytes with its nested include references rewritten, or
 * `undefined` when they would not change. Every include token and every
 * destination is ASCII, so a CLAUDE.md that is not valid UTF-8 (one byte saved
 * in Windows-1252 is enough) is rewritten over a `latin1` view: each byte maps
 * to one character and back, so every other byte is kept exactly. A UTF-8 byte
 * order mark is set aside first, because Claude Code reads it as whitespace
 * before a first-line `@` while the `latin1` view would not. `hits` collects
 * the refs that were rewritten (see {@link rewriteIncludeRefs}).
 */
export function rewriteClaudeMd(
  data: Buffer,
  rewrites: ReadonlyMap<string, string>,
  hits?: Set<string>
): Buffer | undefined {
  if (rewrites.size === 0) return undefined;
  const utf8 = data.toString("utf8");
  if (Buffer.from(utf8, "utf8").equals(data)) {
    const out = rewriteIncludeRefs(utf8, rewrites, hits);
    return out === utf8 ? undefined : Buffer.from(out, "utf8");
  }
  const text = data.toString("latin1");
  const bom = text.startsWith(LATIN1_BOM) ? LATIN1_BOM : "";
  const out = bom + rewriteIncludeRefs(text.slice(bom.length), rewrites, hits);
  return out === text ? undefined : Buffer.from(out, "latin1");
}

/**
 * #4156: a nested include the plan lands under `claude-includes/` whose
 * CLAUDE.md reference the rewrite did not change (it sits in a code block, or
 * in a form the scanner skips). It is a notice, not a policy refusal: the file
 * is imported, and (#5202 U10) the operator is told the exact edit to make.
 */
export function includeUnrewrittenNotice(
  archivePath: string,
  ref: string,
  destRel: string
): Omission {
  return {
    surface: `CLAUDE.md include ${archivePath}`,
    reason: `imported to ${destRel}, but CLAUDE.md has no @${ref} reference outside a code block for the import to point there: add "@${destRel}" to CLAUDE.md where it referenced @${ref}`,
  };
}

/**
 * #5202 (U12): a nested include the commit wrote under `claude-includes/`
 * while it did not write the rewritten CLAUDE.md (the operator kept their own,
 * or left CLAUDE.md out), so nothing yet references the file where it landed.
 */
export function includeUnreferencedNotice(
  archivePath: string,
  ref: string,
  destRel: string
): Omission {
  return {
    surface: `CLAUDE.md include ${archivePath}`,
    reason: `imported to ${destRel}, but CLAUDE.md was not replaced: add "@${destRel}" to your CLAUDE.md where it referenced @${ref}`,
  };
}

/**
 * The operator-facing plan warning for a skipped include. `surface` names the
 * include's archive path, so it is unique among the warnings this importer adds
 * (exact-duplicate include paths are collapsed first). It is NOT unique across
 * the whole `omissions` list: the exporter records every missing include under
 * the one surface `claudeMd.include`, and a hand-built manifest can carry any
 * surface at all.
 */
export function includeSkipOmission(
  archivePath: string,
  destRel: string,
  reason: IncludeSkipReason
): Omission {
  const area = `not imported: a CLAUDE.md include may only write a top-level .md file or a .md file under ${NAMESPACE} (this one would write ${destRel})`;
  const dot = dotLeadingSegment(destRel) ?? "";
  const dotKind = destRel.endsWith(`/${dot}`) ? "file name" : "folder";
  const text: Record<IncludeSkipReason, string> = {
    "not-regular-file":
      "not imported: the archive member is not a regular file (a link, directory, or special entry)",
    "absolute-or-home":
      'not imported: an include path starting with "/" or "~" is not a path inside the config folder',
    "dot-segment": `not imported: a CLAUDE.md include may not write a dot-leading ${dotKind} (${dot} in ${destRel})`,
    "outside-include-area": area,
    "not-markdown": area,
    "shadows-claude-md":
      "not imported: an include named CLAUDE.md would replace CLAUDE.md or be read as one",
    "duplicate-destination": `not imported: another include already writes ${destRel}`,
  };
  return { surface: `CLAUDE.md include ${archivePath}`, reason: text[reason] };
}
