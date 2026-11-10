// SPDX-License-Identifier: AGPL-3.0-only
import { findIssueRefs, type PinIssueRef } from "@hapi/protocol";

// #6453 (R10, KD11): `#12` and `owner/repo#12` in a pin's markdown become links
// the Pins `a` override turns into issue-viewer buttons. A minimal structural
// mdast typing, as `remarkStageReport` does (`StageReportCard.tsx`): the mdast
// types are transitive-only dependencies.

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdastNode[];
  data?: { hProperties?: Record<string, string> } & Record<string, unknown>;
}

/** Nodes whose text is never linked: code, existing links and raw HTML. */
const SKIPPED = new Set([
  "inlineCode",
  "code",
  "link",
  "linkReference",
  "definition",
  "html",
  "image",
  "imageReference",
]);

export const ISSUE_REPO_PROPERTY = "data-issue-repo";
export const ISSUE_NUMBER_PROPERTY = "data-issue-number";

export type RemarkIssueRefsOptions = {
  /** The repository a reference means, or null to leave it as text. */
  resolveRepo: (ref: PinIssueRef) => string | null;
};

function issueLink(text: string, repo: string, number: number): MdastNode {
  return {
    type: "link",
    url: `https://github.com/${repo}/issues/${number}`,
    title: null,
    children: [{ type: "text", value: text }],
    data: {
      hProperties: {
        [ISSUE_REPO_PROPERTY]: repo,
        [ISSUE_NUMBER_PROPERTY]: String(number),
      },
    },
  };
}

/** One text node as text and link nodes, or null when it holds no reference. */
function splitText(
  value: string,
  resolveRepo: RemarkIssueRefsOptions["resolveRepo"]
): MdastNode[] | null {
  const parts: MdastNode[] = [];
  let at = 0;
  for (const ref of findIssueRefs(value)) {
    const repo = resolveRepo(ref);
    if (repo === null) continue;
    if (ref.start > at) {
      parts.push({ type: "text", value: value.slice(at, ref.start) });
    }
    parts.push(issueLink(value.slice(ref.start, ref.end), repo, ref.number));
    at = ref.end;
  }
  if (parts.length === 0) return null;
  if (at < value.length) parts.push({ type: "text", value: value.slice(at) });
  return parts;
}

function walk(
  node: MdastNode,
  resolveRepo: RemarkIssueRefsOptions["resolveRepo"]
): void {
  const children = node?.children;
  if (!Array.isArray(children)) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (SKIPPED.has(child.type)) continue;
    if (child.type === "text" && typeof child.value === "string") {
      const parts = splitText(child.value, resolveRepo);
      if (parts) {
        children.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
      continue;
    }
    walk(child, resolveRepo);
  }
}

/**
 * The remark plugin: splits each text node at its issue references into text
 * and link nodes. The link carries the repository and number as
 * `data-issue-repo` / `data-issue-number`, and its URL is the issue on GitHub,
 * so a renderer without the override still shows a working link. Never throws.
 * Pass it with its options, `[remarkIssueRefs, { resolveRepo }]`, because
 * unified calls a plugin to get its transformer.
 */
export function remarkIssueRefs(
  options: RemarkIssueRefsOptions
): (tree: MdastNode) => void {
  return (tree: MdastNode): void => {
    walk(tree, options.resolveRepo);
  };
}
