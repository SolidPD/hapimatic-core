// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Split a unified diff into the old and new text `DiffView` renders. Shared by
 * the Codex diff tool view and the fan-out Experiment view (#4469); moved here
 * unchanged from `extensions/tool-views/views/CodexDiffView.tsx`.
 */
export function parseUnifiedDiff(unifiedDiff: string): {
  oldText: string;
  newText: string;
  fileName?: string;
} {
  const lines = unifiedDiff.split("\n");
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let fileName: string | undefined;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("+++ b/") || line.startsWith("+++ ")) {
      fileName = line.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }

    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode")
    ) {
      continue;
    }

    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("+")) {
      newLines.push(line.substring(1));
    } else if (line.startsWith("-")) {
      oldLines.push(line.substring(1));
    } else if (line.startsWith(" ")) {
      oldLines.push(line.substring(1));
      newLines.push(line.substring(1));
    } else if (line === "\\ No newline at end of file") {
      continue;
    } else if (line === "") {
      oldLines.push("");
      newLines.push("");
    }
  }

  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
    fileName,
  };
}
