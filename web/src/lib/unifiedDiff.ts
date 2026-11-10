// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Split a unified diff into the old and new text `DiffView` renders. Shared by
 * the Codex diff tool view and the fan-out Experiment view (#4469); moved here
 * from `extensions/tool-views/views/CodexDiffView.tsx`.
 *
 * #6449: each hunk's lines are counted from its `@@ -a,b +c,d @@` header (a
 * missing count means 1), and while either count remains a line is classified
 * by its first character only. Before, the `---` / `+++ ` header prefixes were
 * tested first, so a removed line whose content starts with `--` (a SQL or Lua
 * comment) and an added line whose content starts with `++ ` were dropped, and
 * the latter renamed the file. Headers are now recognized only between hunks,
 * or where a `--- ` / `+++ ` pair followed by a hunk header shows the previous
 * hunk's header overcounted its lines. A hunk whose header cannot be parsed
 * falls back to the previous behavior.
 * `splitUnifiedDiff` returns one old/new pair per file for the Pins evidence.
 */

export type UnifiedDiffFile = {
  oldText: string;
  newText: string;
  fileName?: string;
};

type FileLines = {
  oldLines: string[];
  newLines: string[];
  /** The `+++` path, `b/` stripped. */
  newName?: string;
  /** The `---` path, `a/` stripped (names a deleted file). */
  oldName?: string;
};

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const NO_NEWLINE = "\\ No newline at end of file";

function headerPath(line: string, marker: "---" | "+++"): string {
  const prefix = marker === "+++" ? /^\+\+\+ (b\/)?/ : /^--- (a\/)?/;
  // A non-git diff may append a tab and a timestamp to the path.
  return line.replace(prefix, "").split("\t")[0] ?? "";
}

/** The file has a line or a header name, so it is a file of its own. */
function hasContent(file: FileLines): boolean {
  return (
    file.oldLines.length > 0 ||
    file.newLines.length > 0 ||
    file.newName !== undefined ||
    file.oldName !== undefined
  );
}

/**
 * Whether the `--- ` line at `i`, inside a counted hunk, is the next file's
 * header (the hunk's header overcounted its lines). That takes a `+++ ` line
 * and then a hunk header after it; no hunk line starts with `@@`. When the
 * counts end exactly on the pair (one removed and one added line left), the
 * pair could also be a removed `-- x` and an added `++ y`, so it is a header
 * only if both lines name the same file, or one side is `/dev/null`, as a
 * real header does.
 */
function isOvercountedHeader(
  lines: readonly string[],
  i: number,
  oldLeft: number,
  newLeft: number
): boolean {
  const line = lines[i] ?? "";
  const next = lines[i + 1] ?? "";
  if (
    !line.startsWith("--- ") ||
    !next.startsWith("+++ ") ||
    !HUNK_HEADER.test(lines[i + 2] ?? "")
  ) {
    return false;
  }
  if (oldLeft !== 1 || newLeft !== 1) return true;
  const oldPath = headerPath(line, "---");
  const newPath = headerPath(next, "+++");
  return (
    oldPath === newPath || oldPath === "/dev/null" || newPath === "/dev/null"
  );
}

function fileName(file: FileLines): string | undefined {
  if (file.newName && file.newName !== "/dev/null") return file.newName;
  if (file.oldName && file.oldName !== "/dev/null") return file.oldName;
  return file.newName;
}

/**
 * Walk the lines once, starting a new file at a `diff --git ` line or at a
 * `--- ` line directly followed by `+++ `, but only between hunks — never
 * inside a counted hunk, where such a line is content.
 */
function walkFiles(lines: readonly string[]): FileLines[] {
  const files: FileLines[] = [];
  let current: FileLines | null = null;
  const file = (): FileLines => {
    if (!current) {
      current = { oldLines: [], newLines: [] };
      files.push(current);
    }
    return current;
  };
  const startFile = () => {
    const prev = current;
    if (prev && hasContent(prev)) current = null;
    file();
  };

  let oldLeft = 0;
  let newLeft = 0;
  // In a hunk whose header did not parse: the pre-#6449 behavior.
  let legacy = false;
  // The current file has had a hunk, so a stray +/-/space line after the
  // counts ran out belongs to an undercounted hunk.
  let sawHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // The hunk's header overcounted: end the hunk at the next file's header.
    if (
      (oldLeft > 0 || newLeft > 0) &&
      isOvercountedHeader(lines, i, oldLeft, newLeft)
    ) {
      oldLeft = 0;
      newLeft = 0;
    }

    if (oldLeft > 0 || newLeft > 0) {
      const lead = line.charAt(0);
      if (lead === "\\") continue;
      if (lead === "-") {
        file().oldLines.push(line.slice(1));
        oldLeft = Math.max(0, oldLeft - 1);
        continue;
      }
      if (lead === "+") {
        file().newLines.push(line.slice(1));
        newLeft = Math.max(0, newLeft - 1);
        continue;
      }
      if (lead === " " || line === "") {
        const text = line.slice(1);
        file().oldLines.push(text);
        file().newLines.push(text);
        oldLeft = Math.max(0, oldLeft - 1);
        newLeft = Math.max(0, newLeft - 1);
        continue;
      }
      // Not a hunk line: the counts were wrong. End the hunk and read the
      // line as a header below.
      oldLeft = 0;
      newLeft = 0;
    }

    if (line === NO_NEWLINE) continue;

    if (line.startsWith("@@")) {
      const match = HUNK_HEADER.exec(line);
      if (match) {
        oldLeft = match[1] === undefined ? 1 : Number(match[1]);
        newLeft = match[2] === undefined ? 1 : Number(match[2]);
        legacy = false;
      } else {
        legacy = true;
      }
      sawHunk = true;
      file();
      continue;
    }

    if (line.startsWith("diff --git ")) {
      legacy = false;
      sawHunk = false;
      startFile();
      continue;
    }

    if (line.startsWith("+++ ")) {
      file().newName = headerPath(line, "+++");
      continue;
    }

    if (line.startsWith("---")) {
      if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
        // A file boundary for a diff with no `diff --git` lines; within a git
        // diff the `diff --git` line already started this file.
        const cur = current as FileLines | null;
        if (
          cur &&
          (cur.oldLines.length > 0 ||
            cur.newLines.length > 0 ||
            cur.oldName !== undefined)
        ) {
          legacy = false;
          sawHunk = false;
          startFile();
        }
        file().oldName = headerPath(line, "---");
      }
      continue;
    }

    if (
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode")
    ) {
      continue;
    }

    // A hunk whose header undercounted its lines (common in hand- or
    // model-written diffs): keep the extra lines, as the old parser did.
    const undercounted =
      !legacy &&
      sawHunk &&
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "));
    if (!legacy && !undercounted) continue;

    // Legacy hunk (header did not parse), or an undercounted hunk's extra
    // lines: classify as before.
    if (line.startsWith("+")) {
      file().newLines.push(line.substring(1));
    } else if (line.startsWith("-")) {
      file().oldLines.push(line.substring(1));
    } else if (line.startsWith(" ")) {
      file().oldLines.push(line.substring(1));
      file().newLines.push(line.substring(1));
    } else if (line === "" && legacy) {
      file().oldLines.push("");
      file().newLines.push("");
    }
  }
  return files;
}

/** The whole diff as one old/new pair, named after its last file. */
export function parseUnifiedDiff(unifiedDiff: string): UnifiedDiffFile {
  const files = walkFiles(unifiedDiff.split("\n"));
  const oldLines = files.flatMap(f => f.oldLines);
  const newLines = files.flatMap(f => f.newLines);
  const last = files[files.length - 1];
  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
    fileName: last ? fileName(last) : undefined,
  };
}

export const UNIFIED_DIFF_MAX_LINES = 1000;
export const UNIFIED_DIFF_MAX_BYTES = 64 * 1024;

/**
 * One old/new pair per file, for evidence that shows each file on its own.
 * The text is capped first (`maxBytes` of UTF-8, then `maxLines`); a byte cut
 * drops the partial last line, and either cut sets `truncated`.
 */
export function splitUnifiedDiff(
  text: string,
  opts: { maxLines?: number; maxBytes?: number } = {}
): { files: UnifiedDiffFile[]; truncated: boolean } {
  const maxLines = opts.maxLines ?? UNIFIED_DIFF_MAX_LINES;
  const maxBytes = opts.maxBytes ?? UNIFIED_DIFF_MAX_BYTES;
  let truncated = false;
  let capped = text;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > maxBytes) {
    truncated = true;
    capped = new TextDecoder().decode(bytes.subarray(0, maxBytes));
    // Drop the cut line (and any half character left at the cut).
    const lastBreak = capped.lastIndexOf("\n");
    capped = lastBreak === -1 ? "" : capped.slice(0, lastBreak);
  }
  let lines = capped.split("\n");
  if (lines.length > maxLines) {
    truncated = true;
    lines = lines.slice(0, maxLines);
  }
  const files = walkFiles(lines)
    .filter(hasContent)
    .map(f => ({
      oldText: f.oldLines.join("\n"),
      newText: f.newLines.join("\n"),
      fileName: fileName(f),
    }));
  return { files, truncated };
}
