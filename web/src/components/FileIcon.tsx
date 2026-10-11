// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";

/**
 * File-extension → icon color for the file-type glyph.
 *
 * KEPT AS DATA (#3479 · epic #3354, owner ruling F1, mirrors #3434 D2(a)): these
 * are behavior-coupled file-type brand colors keyed by file extension — the
 * canonical brand hex of each language/tooling ecosystem (TypeScript #3178c6,
 * JavaScript #f7df1e, Python #3776ab, Go #0ea5e9, Rust #f97316, …). They mirror an
 * external convention a theme must never re-tint, so a semantic `--file-icon-*` app
 * token would have no legitimate value of its own (its only value would be
 * "whatever the ecosystem's brand is"). Recorded as a permanent inline exception on
 * each literal line below, NOT tokenized — the same value-class the #3434 owner kept
 * as data for `--issue-kind-*` in `IssueStateBadge.tsx`. The `FileIcon.tsx` entry is
 * therefore removed from `scripts/design-tokens-baseline.json`, not left as a
 * grandfathered count. An unknown extension already falls back to a token
 * (`var(--app-hint)`, below).
 */
const EXTENSION_COLORS: Record<string, string> = {
  ts: "#3178c6", // design-tokens-allow: TypeScript brand hex (behavior-coupled file-type color); no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  tsx: "#3178c6", // design-tokens-allow: TypeScript (TSX) brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  js: "#f7df1e", // design-tokens-allow: JavaScript brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  jsx: "#f7df1e", // design-tokens-allow: JavaScript (JSX) brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  json: "#f59e0b", // design-tokens-allow: JSON file-type brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  md: "#64748b", // design-tokens-allow: Markdown file-type brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  mdx: "#64748b", // design-tokens-allow: MDX file-type brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  css: "#2563eb", // design-tokens-allow: CSS brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  scss: "#db2777", // design-tokens-allow: Sass/SCSS brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  html: "#f97316", // design-tokens-allow: HTML brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  yml: "#ef4444", // design-tokens-allow: YAML file-type brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  yaml: "#ef4444", // design-tokens-allow: YAML file-type brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  sh: "#10b981", // design-tokens-allow: shell-script file-type brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  bash: "#10b981", // design-tokens-allow: Bash file-type brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  py: "#3776ab", // design-tokens-allow: Python brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  go: "#0ea5e9", // design-tokens-allow: Go brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
  rs: "#f97316", // design-tokens-allow: Rust brand hex; no semantic app token (#3479 keep decision, mirrors #3434 D2(a))
};

function getFileExtension(fileName: string): string {
  const trimmed = fileName.trim();
  if (trimmed.startsWith(".") && trimmed.indexOf(".", 1) === -1) {
    return trimmed.slice(1).toLowerCase();
  }
  const parts = trimmed.split(".");
  if (parts.length <= 1) return "";
  return parts[parts.length - 1]?.toLowerCase() ?? "";
}

export function FileIcon(props: { fileName: string; size?: number }) {
  const size = props.size ?? 20;
  const color = useMemo(() => {
    const ext = getFileExtension(props.fileName);
    return EXTENSION_COLORS[ext] ?? "var(--app-hint)";
  }, [props.fileName]);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color }}
    >
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
