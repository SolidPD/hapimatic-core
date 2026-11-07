// SPDX-License-Identifier: AGPL-3.0-only
import type { GitFileStatus, GitStatusFiles } from "@/types/api";

export type GitFileEntryV2 = {
  path: string;
  index: string;
  workingDir: string;
  from?: string;
};

export type GitBranchInfo = {
  oid?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
};

export type GitStatusSummaryV2 = {
  files: GitFileEntryV2[];
  notAdded: string[];
  ignored: string[];
  branch: GitBranchInfo;
  /** #6224: change lines no pattern could read. Each still counts as a change. */
  unparsed: string[];
};

export type DiffFileStat = {
  file: string;
  changes: number;
  insertions: number;
  deletions: number;
  binary: boolean;
};

export type DiffSummary = {
  files: DiffFileStat[];
  insertions: number;
  deletions: number;
  changes: number;
  changed: number;
};

// #6224: every line pattern carries the `s` (dotAll) flag. Without it `.` does
// not match U+2028 / U+2029, so a file name holding one dropped its whole line.
const BRANCH_OID_REGEX = /^# branch\.oid (.+)$/s;
const BRANCH_HEAD_REGEX = /^# branch\.head (.+)$/s;
const BRANCH_UPSTREAM_REGEX = /^# branch\.upstream (.+)$/s;
const BRANCH_AB_REGEX = /^# branch\.ab \+(\d+) -(\d+)$/s;

const ORDINARY_CHANGE_REGEX =
  /^1 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (.+)$/s;
const RENAME_COPY_REGEX =
  /^2 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([RC])(\d{1,3}) (.+)\t(.+)$/s;
const UNMERGED_REGEX =
  /^u (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.+)$/s;
const UNTRACKED_REGEX = /^\? (.+)$/s;
const IGNORED_REGEX = /^! (.+)$/s;

const NUMSTAT_REGEX = /^(\d+|-)\t(\d+|-)\t(.*)$/;

export function parseStatusSummaryV2(statusOutput: string): GitStatusSummaryV2 {
  // #6224: no trim(). A trailing space is part of the last path, and an empty
  // line is the only thing to drop.
  const lines = statusOutput.split("\n").filter(line => line.length > 0);

  const result: GitStatusSummaryV2 = {
    files: [],
    notAdded: [],
    ignored: [],
    branch: {},
    unparsed: [],
  };

  for (const line of lines) {
    if (line.startsWith("# branch.oid ")) {
      const match = BRANCH_OID_REGEX.exec(line);
      if (match) result.branch.oid = match[1];
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const match = BRANCH_HEAD_REGEX.exec(line);
      if (match) result.branch.head = match[1];
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      const match = BRANCH_UPSTREAM_REGEX.exec(line);
      if (match) result.branch.upstream = match[1];
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = BRANCH_AB_REGEX.exec(line);
      if (match) {
        result.branch.ahead = parseInt(match[1], 10);
        result.branch.behind = parseInt(match[2], 10);
      }
      continue;
    }

    if (line.startsWith("1 ")) {
      const match = ORDINARY_CHANGE_REGEX.exec(line);
      const entry = match ? parseOrdinaryChange(match) : null;
      if (entry) result.files.push(entry);
      else result.unparsed.push(line);
      continue;
    }

    if (line.startsWith("2 ")) {
      const match = RENAME_COPY_REGEX.exec(line);
      const entry = match ? parseRenameCopy(match) : null;
      if (entry) result.files.push(entry);
      else result.unparsed.push(line);
      continue;
    }

    if (line.startsWith("u ")) {
      const match = UNMERGED_REGEX.exec(line);
      const entry = match ? parseUnmerged(match) : null;
      if (entry) result.files.push(entry);
      else result.unparsed.push(line);
      continue;
    }

    if (line.startsWith("? ")) {
      const match = UNTRACKED_REGEX.exec(line);
      if (match) result.notAdded.push(match[1]);
      else result.unparsed.push(line);
      continue;
    }

    if (line.startsWith("! ")) {
      const match = IGNORED_REGEX.exec(line);
      if (match) result.ignored.push(match[1]);
      continue;
    }

    // A header git adds later (`# stash …`) is not a change; anything else is a
    // change line in a form this parser does not know, and must still count.
    if (!line.startsWith("# ")) {
      result.unparsed.push(line);
    }
  }

  return result;
}

export function parseNumStat(numStatOutput: string): DiffSummary {
  const lines = numStatOutput
    .trim()
    .split("\n")
    .filter(line => line.length > 0);

  const result: DiffSummary = {
    files: [],
    insertions: 0,
    deletions: 0,
    changes: 0,
    changed: 0,
  };

  for (const line of lines) {
    const match = NUMSTAT_REGEX.exec(line);
    if (!match) continue;
    const insertionsStr = match[1];
    const deletionsStr = match[2];
    const file = match[3];

    const isBinary = insertionsStr === "-" || deletionsStr === "-";
    const insertions = isBinary ? 0 : parseInt(insertionsStr, 10);
    const deletions = isBinary ? 0 : parseInt(deletionsStr, 10);
    const changes = insertions + deletions;

    result.files.push({
      file,
      changes,
      insertions,
      deletions,
      binary: isBinary,
    });
    result.insertions += insertions;
    result.deletions += deletions;
    result.changes += changes;
    result.changed += 1;
  }

  return result;
}

/**
 * The stats for a `git status` path. Status keeps git's quoting while
 * `createDiffStatsMap` keys a rename by its decoded paths, so a quoted path
 * is looked up both ways.
 */
function diffStatsFor(
  stats: Record<string, { added: number; removed: number; binary: boolean }>,
  path: string
): { added: number; removed: number; binary: boolean } {
  return (
    stats[path] ??
    stats[unquoteGitPath(path)] ?? { added: 0, removed: 0, binary: false }
  );
}

export function createDiffStatsMap(
  summary: DiffSummary
): Record<string, { added: number; removed: number; binary: boolean }> {
  const stats: Record<
    string,
    { added: number; removed: number; binary: boolean }
  > = {};

  for (const file of summary.files) {
    const paths = normalizeNumstatPath(file.file);
    const stat = {
      added: file.insertions,
      removed: file.deletions,
      binary: file.binary,
    };
    stats[file.file] = stat;
    if (paths.newPath && paths.newPath !== file.file) {
      stats[paths.newPath] = stat;
    }
    if (
      paths.oldPath &&
      paths.oldPath !== file.file &&
      paths.oldPath !== paths.newPath
    ) {
      stats[paths.oldPath] = stat;
    }
  }

  return stats;
}

export function getCurrentBranchV2(summary: GitStatusSummaryV2): string | null {
  const head = summary.branch.head;
  if (!head || head === "(detached)" || head === "(initial)") return null;
  return head;
}

export function buildGitStatusFiles(
  statusOutput: string,
  unstagedDiffOutput: string,
  stagedDiffOutput: string
): GitStatusFiles {
  const statusSummary = parseStatusSummaryV2(statusOutput);
  const branchName = getCurrentBranchV2(statusSummary);

  const unstagedDiff = parseNumStat(unstagedDiffOutput);
  const stagedDiff = parseNumStat(stagedDiffOutput);
  const unstagedStats = createDiffStatsMap(unstagedDiff);
  const stagedStats = createDiffStatsMap(stagedDiff);

  const stagedFiles: GitFileStatus[] = [];
  const unstagedFiles: GitFileStatus[] = [];

  for (const file of statusSummary.files) {
    // #6224: open and show the decoded path, never git's quoted form.
    const displayPath = unquoteGitPath(file.path);
    const oldPath =
      file.from === undefined ? undefined : unquoteGitPath(file.from);
    const parts = displayPath.split("/");
    const fileName = parts[parts.length - 1] || displayPath;
    const filePath = parts.slice(0, -1).join("/");

    if (file.index !== " " && file.index !== "." && file.index !== "?") {
      const status = getFileStatus(file.index);
      const stats = diffStatsFor(stagedStats, file.path);
      stagedFiles.push({
        fileName,
        filePath,
        fullPath: displayPath,
        status,
        isStaged: true,
        linesAdded: stats.added,
        linesRemoved: stats.removed,
        oldPath,
      });
    }

    if (file.workingDir !== " " && file.workingDir !== ".") {
      const status = getFileStatus(file.workingDir);
      const stats = diffStatsFor(unstagedStats, file.path);
      unstagedFiles.push({
        fileName,
        filePath,
        fullPath: displayPath,
        status,
        isStaged: false,
        linesAdded: stats.added,
        linesRemoved: stats.removed,
        oldPath,
      });
    }
  }

  for (const untrackedPath of statusSummary.notAdded) {
    const decoded = unquoteGitPath(untrackedPath);
    // #6224: with --untracked-files=all git lists every untracked file, so a
    // trailing `/` means a folder git does not descend into: a nested repository.
    // It used to be skipped, so a folder whose only change was one read as clean.
    const isDirectory = decoded.endsWith("/");
    const cleanPath = isDirectory ? decoded.slice(0, -1) : decoded;
    const parts = cleanPath.split("/");
    const fileName = parts[parts.length - 1] || cleanPath;
    const filePath = parts.slice(0, -1).join("/");

    unstagedFiles.push({
      fileName: isDirectory ? `${fileName}/` : fileName,
      filePath,
      fullPath: cleanPath,
      status: "untracked",
      isStaged: false,
      linesAdded: 0,
      linesRemoved: 0,
      ...(isDirectory ? { isDirectory: true } : {}),
    });
  }

  // #6224: a change line this parser could not read still counts, so Changes
  // never reads as clean while git reported something.
  for (const line of statusSummary.unparsed) {
    unstagedFiles.push({
      fileName: "Unreadable status line",
      filePath: line,
      fullPath: "",
      status: "unknown",
      isStaged: false,
      linesAdded: 0,
      linesRemoved: 0,
    });
  }

  return {
    stagedFiles,
    unstagedFiles,
    branch: branchName,
    totalStaged: stagedFiles.length,
    totalUnstaged: unstagedFiles.length,
  };
}

function parseOrdinaryChange(matches: string[]): GitFileEntryV2 | null {
  if (!matches[1] || !matches[2] || !matches[9]) return null;
  return {
    index: matches[1],
    workingDir: matches[2],
    path: matches[9],
  };
}

// Porcelain v2 writes a rename as `<path><TAB><origPath>`: the NEW path comes
// first (#6224 — these were swapped, so a renamed file showed its old name).
function parseRenameCopy(matches: string[]): GitFileEntryV2 | null {
  if (!matches[1] || !matches[2] || !matches[11] || !matches[12]) return null;
  return {
    index: matches[1],
    workingDir: matches[2],
    path: matches[11],
    from: matches[12],
  };
}

function parseUnmerged(matches: string[]): GitFileEntryV2 | null {
  if (!matches[1] || !matches[2] || !matches[11]) return null;
  return {
    index: matches[1],
    workingDir: matches[2],
    path: matches[11],
  };
}

function getFileStatus(statusChar: string): GitFileStatus["status"] {
  switch (statusChar) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "?":
      return "untracked";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
}

/** A path git quoted (`core.quotePath`): `"..."` with C-style escapes. */
const QUOTED_GIT_PATH = /^"(?:[^"\\]|\\.)*"$/;

const GIT_PATH_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * Undo git's path quoting: a path with a non-ASCII byte, a control character,
 * `"` or `\` comes back as `"a/\303\274.txt"` (octal UTF-8 bytes). Any other
 * text is returned unchanged.
 */
export function unquoteGitPath(path: string): string {
  if (!QUOTED_GIT_PATH.test(path)) return path;
  const chars = Array.from(path.slice(1, -1));
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    if (ch !== "\\") {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const octal = chars.slice(i + 1, i + 4).join("");
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const code = GIT_PATH_ESCAPES[chars[i + 1] ?? ""];
    if (code !== undefined) {
      bytes.push(code);
      i += 1;
      continue;
    }
    bytes.push(92);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const BRACED_RENAME = /\{([^{}]+?)\s*=>\s*([^{}]+?)\}/g;

/**
 * The paths of one `git diff --numstat` entry. A rename comes back as
 * `old => new` or, when the paths share a prefix or suffix, as
 * `dir/{old => new}/file`, where either side of the braces can be empty
 * (`a/{ => b}/z.ts` is `a/z.ts` → `a/b/z.ts`). A quoted path (see
 * `unquoteGitPath`) is decoded; git quotes each side of a rename on its own
 * and never uses the braced form for one.
 */
export function normalizeNumstatPath(rawPath: string): {
  newPath: string;
  oldPath?: string;
} {
  const trimmed = rawPath.trim();
  if (QUOTED_GIT_PATH.test(trimmed)) {
    return { newPath: unquoteGitPath(trimmed) };
  }

  // A brace in a file name (`src{a}.ts => src{b}.ts`) is not this form.
  if (/\{[^{}]+?\s*=>\s*[^{}]+?\}/.test(trimmed)) {
    // An empty side leaves `a//z.ts` (or a leading `/`): collapse it.
    const tidy = (path: string): string =>
      path.replace(/\/{2,}/g, "/").replace(/^\//, "");
    const newPath = tidy(
      trimmed.replace(BRACED_RENAME, (_, oldPart: string, newPart: string) =>
        newPart.trim()
      )
    );
    const oldPath = tidy(
      trimmed.replace(BRACED_RENAME, (_, oldPart: string) => oldPart.trim())
    );
    return { newPath, oldPath };
  }

  if (trimmed.includes("=>")) {
    const parts = trimmed.split(/\s*=>\s*/);
    const oldPath = parts[0]?.trim();
    const newPath = parts[parts.length - 1]?.trim();
    if (newPath) {
      return {
        newPath: unquoteGitPath(newPath),
        oldPath: oldPath === undefined ? undefined : unquoteGitPath(oldPath),
      };
    }
  }

  return { newPath: trimmed };
}
