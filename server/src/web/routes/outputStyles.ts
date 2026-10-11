// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { WebAppEnv } from "../middleware/auth";

/**
 * Issue #2626 (D): output-style catalog for the Create-page selector.
 *
 * `GET /api/output-styles` → `{ styles: OutputStyleInfo[] }`. Returns the three
 * built-in styles (compiled into the Claude binary — no on-disk file, so their
 * descriptions are hardcoded here from Claude Code's OUTPUT_STYLE_CONFIG) PLUS
 * any custom styles found in `~/.claude/output-styles/*.md` (frontmatter
 * `name`/`description`, with the full file `content` for the "view .md" modal).
 *
 * JWT-authed (mounted with the authed routes) — the selector is a post-login
 * surface. Models 1:1 on `createClaudeModelsRoutes` (a thin catalog route).
 *
 * Custom-style availability across federation nodes is D-out-of-scope: D ships
 * built-ins everywhere (they always resolve on any node) + hub-local customs;
 * cross-node custom distribution is #2627 (E). A spawn naming a style absent on
 * the target node is silently no-op'd by Claude Code (Task 1 spike), so listing
 * a hub-local custom here never crashes a remote spawn.
 */
export interface OutputStyleInfo {
  /** The style name — the value threaded through the spawn wire as `outputStyle`. */
  name: string;
  /** One-line description shown beside the option in the dropdown. */
  description: string;
  /** True for the three compiled-in styles; false for `~/.claude/output-styles/*.md`. */
  builtin: boolean;
  /** For custom styles only: the full `.md` file content (the "view .md" modal). */
  content?: string;
  /**
   * Issue #2627 (Sub-Issue E): true for uploaded custom styles — the Preferences
   * manager renders a delete affordance for these. Absent/undefined for the
   * three built-ins (which can never be deleted).
   */
  deletable?: boolean;
}

/**
 * The three built-in styles, hardcoded because they compile into the Claude
 * binary (there is no on-disk file to enumerate). Descriptions mirror Claude
 * Code's OUTPUT_STYLE_CONFIG (`Explanatory` / `Learning`); `default` has no
 * config entry (it is the ABSENCE of a style modifier), so its description is
 * authored here. `default` is listed so the user sees it in the dropdown, but
 * selecting it makes the selector OMIT the spawn field entirely (R2 fail-open —
 * byte-identical spawn), never send the literal "default".
 */
export const BUILTIN_OUTPUT_STYLES: readonly OutputStyleInfo[] = [
  {
    name: "default",
    description:
      "Claude's standard responses — no added educational commentary or hands-on practice.",
    builtin: true,
  },
  {
    name: "Explanatory",
    description:
      "Claude explains its implementation choices and codebase patterns.",
    builtin: true,
  },
  {
    name: "Learning",
    description:
      "Claude pauses and asks you to write small pieces of code for hands-on practice.",
    builtin: true,
  },
];

/**
 * Minimal, dependency-free frontmatter reader. Extracts `name:` and
 * `description:` from a leading `---\n…\n---` YAML block. Deliberately NOT a
 * full YAML parser — a custom style .md only needs those two scalar keys, and
 * adding `gray-matter` for two regex lookups is not warranted. Values may be
 * bare, single-, or double-quoted.
 */
export function parseStyleFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const read = (key: string): string | undefined => {
    const line = block.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "m"));
    if (!line) return undefined;
    return line[1].replace(/^['"]|['"]$/g, "").trim() || undefined;
  };
  return { name: read("name"), description: read("description") };
}

/**
 * Enumerate custom styles from a directory of `*.md` files. Returns `[]` when
 * the directory does not exist (the common case today — `~/.claude/output-styles/`
 * is absent) or is unreadable. An individual unreadable/garbled file is skipped,
 * not fatal. Pure + injectable for testing.
 */
export function readCustomOutputStyles(stylesDir: string): OutputStyleInfo[] {
  let files: string[];
  try {
    files = readdirSync(stylesDir).filter(f => f.endsWith(".md"));
  } catch {
    // ENOENT (dir absent) or EACCES → no custom styles, just built-ins.
    return [];
  }
  const styles: OutputStyleInfo[] = [];
  for (const file of files.sort()) {
    try {
      const content = readFileSync(join(stylesDir, file), "utf-8");
      const fm = parseStyleFrontmatter(content);
      styles.push({
        name: fm.name ?? file.replace(/\.md$/, ""),
        description: fm.description ?? "",
        builtin: false,
        content,
        // #2627 (E): uploaded customs are user-deletable; the manager UI reads
        // this to render a delete affordance.
        deletable: true,
      });
    } catch {
      // Skip a single unreadable file rather than failing the whole catalog.
    }
  }
  return styles;
}

/**
 * Build the full catalog: built-ins first, then hub-local customs (de-duplicated
 * by name — a custom style must never shadow a built-in).
 */
export function getOutputStyleCatalog(stylesDir?: string): {
  styles: OutputStyleInfo[];
} {
  const dir = stylesDir ?? join(homedir(), ".claude", "output-styles");
  const builtinNames = new Set(BUILTIN_OUTPUT_STYLES.map(s => s.name));
  const custom = readCustomOutputStyles(dir).filter(
    s => !builtinNames.has(s.name)
  );
  return { styles: [...BUILTIN_OUTPUT_STYLES, ...custom] };
}

export function createOutputStylesRoutes(options?: {
  stylesDir?: string;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/output-styles",
    cataloged(
      defineCapability({
        id: "model-permission.output-styles-list",
        domain: "model-permission",
        surface: "rest",
        description: "List the output styles installed on this node.",
        whenToUse: "When the user opens the output-style picker.",
        invocation: { kind: "rest", method: "GET", path: "/api/output-styles" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      return c.json(getOutputStyleCatalog(options?.stylesDir));
    }
  );

  return app;
}
