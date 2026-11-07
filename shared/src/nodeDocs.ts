// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The node docs contract (issue #6219): the one place that names the folder the server
 * writes the bundled documentation into, the stamp that records which version it holds, and
 * the pointer text every session is given.
 *
 * WRITER: the server, at boot (`server/src/support/nodeDocs.ts`), writes
 * `<HAPI_HOME>/docs/` from the docs bundle compiled into the binary, with a `README.md` index
 * and a `.docs-version` stamp.
 * READER: the cli, when it builds a session's instructions (`cli/src/utils/hapimaticDocsPointer.ts`),
 * reads that stamp and names the local folder only when the stamp's version is the running
 * version. Both sides import these names, so neither carries a literal the other could drift
 * from.
 *
 * The pointer text is rendered here, once, because it reaches every harness (Claude's system
 * prompt, Codex's developer instructions, the first turn of a Gemini or OpenCode session) and
 * three hand-kept copies would drift. Pure and browser-safe: no Node imports.
 */

/** The folder under `HAPI_HOME` (default `~/.hapi`) that holds the node docs. */
export const NODE_DOCS_DIR_NAME = "docs";

/** The stamp file inside the node docs folder: `<version>+<12 hex of a content hash>`. */
export const NODE_DOCS_VERSION_FILE = ".docs-version";

/** The generated index at the top of the node docs folder. */
export const NODE_DOCS_INDEX_FILE = "README.md";

/** The public documentation site: the same pages, for the latest release. */
export const PUBLIC_DOCS_URL = "https://hapimatic.com/docs/";

/**
 * Upper bound on the pointer text, in characters, for both variants. The pointer is added to
 * every session on every harness (about 110 tokens), outside the Tier-0 budget the way
 * co-authored credits are, so it carries its own bound (#6219). Raising it is a reviewed
 * decision, not a convenience.
 */
export const DOCS_POINTER_BUDGET_CHARS = 500;

/** A parsed `.docs-version` stamp. */
export interface DocsStamp {
  version: string;
  hash: string;
}

const STAMP_RE = /^(\S+)\+([0-9a-f]{12})$/;

/** The stamp text for a version and the first 12 hex digits of the content hash. */
export function formatDocsStamp(version: string, hash: string): string {
  return `${version}+${hash}`;
}

/** Parse a stamp file's text; `null` for anything that is not a well-formed stamp. */
export function parseDocsStamp(text: string): DocsStamp | null {
  const m = text.trim().match(STAMP_RE);
  if (!m) return null;
  return { version: m[1], hash: m[2] };
}

/** Where a session's documentation is. */
export type DocsLocation =
  | { kind: "local"; dir: string; version: string }
  | { kind: "public"; version: string };

/**
 * The pointer every session is given. `local` names the folder on this machine and the version
 * it matches; `public` names the public site. `sourceHref` is the public core source for the
 * running version (`correspondingSourceHref`), or `null` when no public repo is configured.
 */
export function renderDocsPointer(
  location: DocsLocation,
  sourceHref: string | null
): string {
  // The local folder is rewritten when the server updates, while a session
  // keeps the prompt it started with, so the index (not this text) names the
  // version the folder holds now. The public site describes the latest
  // release, which can differ from the running one.
  const where =
    location.kind === "local"
      ? `Your Hapimatic documentation is on this machine, in \`${location.dir}/\`: the user guide and public docs for Hapimatic v${location.version}, the version this session started on (\`${NODE_DOCS_INDEX_FILE}\` names the version the folder holds now).`
      : `You are running Hapimatic v${location.version}. Your Hapimatic documentation is at ${PUBLIC_DOCS_URL}; it describes the latest release, so when an answer depends on the version, say which one it describes.`;
  const stance =
    "Answer questions about Hapimatic from it and from live checks, directly and completely, without hedging.";
  const source = sourceHref
    ? ` Source code for this version: ${sourceHref}.`
    : "";
  return `${where} ${stance}${source}`;
}
