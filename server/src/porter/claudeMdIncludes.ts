// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md `@`-include destination policy for the Configuration Porter import
 * (issue #4143). Split out of `importArchive.ts` (#2077 max-lines) as a pure
 * module so the rule is unit-testable on its own.
 *
 * 🔴 Why this exists: an include is planned as a WHOLE-FILE write to
 * `<claudeDir>/<basename>`. Without a destination rule, an archive could list
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
 * CLAUDE.md. A config file Claude Code adds later is excluded with no code
 * change here — the denylist that names the obvious three would have missed
 * `.config.json`.
 *
 * A skipped include is never staged and never written. It is reported to the
 * operator as a plan `omissions[]` entry (rendered by the import panel's
 * "Deliberately omitted" list), one per include with a unique `surface`.
 */
import { relative } from "node:path";
import type { Omission } from "@hapi/protocol/porter";

/** Why a CLAUDE.md include is not imported (#4143). */
export type IncludeSkipReason =
  | "not-regular-file"
  | "not-top-level"
  | "not-markdown"
  | "shadows-claude-md"
  | "duplicate-destination";

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
 * Classify an include by its RESOLVED destination — the absolute path
 * `assertSafeEntry` returned — never by the raw archive string, because
 * `basename()` has already collapsed spellings such as
 * `claude-includes/../settings.json` and `settings.json/` to `settings.json`.
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
  if (/[\\/]/.test(destRel)) {
    return { ok: false, destRel, reason: "not-top-level" };
  }
  if (!/\.md$/i.test(destRel)) {
    return { ok: false, destRel, reason: "not-markdown" };
  }
  if (includeKey(destRel) === "claude.md") {
    return { ok: false, destRel, reason: "shadows-claude-md" };
  }
  if (claimed.has(includeKey(destRel))) {
    return { ok: false, destRel, reason: "duplicate-destination" };
  }
  return { ok: true, destRel };
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
  const text: Record<IncludeSkipReason, string> = {
    "not-regular-file":
      "not imported: the archive member is not a regular file (a link, directory, or special entry)",
    "not-top-level": `not imported: a CLAUDE.md include may only write a top-level .md file (this one would write ${destRel})`,
    "not-markdown": `not imported: a CLAUDE.md include may only write a top-level .md file (this one would write ${destRel})`,
    "shadows-claude-md": "not imported: it would replace CLAUDE.md itself",
    "duplicate-destination": `not imported: another include already writes ${destRel}`,
  };
  return { surface: `CLAUDE.md include ${archivePath}`, reason: text[reason] };
}
