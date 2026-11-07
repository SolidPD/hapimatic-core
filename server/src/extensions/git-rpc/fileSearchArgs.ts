// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tree-wide file search for the Files tab (#6224 Task 5). Shared by the local
 * route (`routes/git.ts`) and the federation receiver
 * (`web/routes/federation/sessionData.ts`) so the two cannot drift.
 *
 * The query is matched as a literal substring of each file's NAME: every glob
 * metacharacter is escaped, so `a[1]` finds `a[1].txt` instead of reading as a
 * character class, and `a[1` no longer makes ripgrep exit 2 with a glob parse
 * error that the route used to report as "no files match". A query containing
 * `/` is anchored at the session root by ripgrep's glob rules, so
 * `components/Foo` does not find `web/src/components/Foo.tsx` yet (#6353).
 */

export type FileSearchItem = {
  fileName: string;
  filePath: string;
  fullPath: string;
  fileType: "file";
};

export type FileSearchResult =
  | { success: true; files: FileSearchItem[]; truncated: boolean }
  | { success: false; error: string };

// ripgrep glob syntax (globset): `\` escapes the next character.
const GLOB_META = /[\\*?[\]{}!]/g;

export function escapeGlob(text: string): string {
  return text.replace(GLOB_META, ch => `\\${ch}`);
}

/**
 * `hidden` adds hidden files and folders (but never `.git`). Git-ignored
 * folders are not walked: `--no-ignore` would walk `node_modules` and `dist`.
 *
 * #6224: the exclusions come AFTER the query glob, as `--iglob`s. A glob
 * overrides ripgrep's own hidden-file and ignore rules, and a later glob
 * overrides an earlier one. So `*<query>*` listed every hidden path whose name
 * matched: searching `i`, `g` or `t` listed `.git/config` and the object store,
 * and with hidden files off it also listed `.env` and `.gitignore`. `!.git` now
 * always follows the query glob, and `!.*` follows it when hidden files are
 * off. A Git-ignored FILE whose own name matches the query is still listed,
 * for the same reason.
 */
export function buildFileSearchArgs(options: {
  query: string;
  hidden: boolean;
}): string[] {
  const args = ["--files"];
  if (options.hidden) {
    args.push("--hidden");
  }
  if (options.query) {
    args.push("--iglob", `*${escapeGlob(options.query)}*`);
  }
  args.push("--iglob", "!.git");
  if (!options.hidden) {
    args.push("--iglob", "!.*");
  }
  return args;
}

/**
 * Turn ripgrep's `--files` output into search items. Exit 1 means no match.
 * Exit 2 with no output is an error the user must see; exit 2 with output means
 * some folders were unreadable, and the readable matches are still returned.
 */
export function parseFileSearchOutput(
  result: { exitCode?: number; stdout?: string; stderr?: string },
  limit: number
): FileSearchResult {
  const stdout = result.stdout ?? "";
  // Split on newlines only: a file name may start or end with a space, so
  // trimming each line would point the result at a path that does not exist.
  const paths = stdout.split("\n").filter(line => line.length > 0);
  if (result.exitCode === 2 && paths.length === 0) {
    const firstLine = (result.stderr ?? "").split("\n").find(Boolean);
    return {
      success: false,
      error: firstLine
        ? `Search failed: ${firstLine}`
        : "Search failed (ripgrep exit 2)",
    };
  }
  const files = paths.slice(0, limit).map(fullPath => {
    const parts = fullPath.split("/");
    return {
      fileName: parts[parts.length - 1] || fullPath,
      filePath: parts.slice(0, -1).join("/"),
      fullPath,
      fileType: "file" as const,
    };
  });
  return { success: true, files, truncated: paths.length > limit };
}

export function parseHiddenParam(value: string | undefined): boolean {
  return value === "true" || value === "1";
}
