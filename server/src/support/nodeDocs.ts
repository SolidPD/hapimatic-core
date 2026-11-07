// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The node docs (issue #6219): every Hapimatic server writes the documentation
 * of the version it runs to `<HAPI_HOME>/docs/` when it starts, so every
 * session on every node (customer VM, operator node, self-hosted core) can read
 * it from disk, and every session is told where it is
 * (`cli/src/utils/hapimaticDocsPointer.ts`).
 *
 *   <HAPI_HOME>/docs/README.md        generated index, version and source link
 *   <HAPI_HOME>/docs/guide/*.md       the bundled public pages (docsBundle.generated.ts)
 *   <HAPI_HOME>/docs/cloud-*.md
 *   <HAPI_HOME>/docs/extensions/*.md
 *   <HAPI_HOME>/docs/.docs-version    `<version>+<content hash>`, read by the cli
 *
 * Per instance, not per host: prod, dev and worktree instances on one machine
 * each keep the docs of their own binary. The write happens once per stamp
 * change (a new version or new content), into a temporary sibling folder that
 * replaces the old one by rename, so no reader sees a half-written tree and a
 * half-written tree never carries a stamp. The names and the stamp format are
 * the shared contract in `shared/src/nodeDocs.ts`.
 *
 * Pattern: `supportWorkspace.ts` (stamped idempotent write) and
 * `../capabilities/selfKnowledgeBootWriter.ts` (fail-soft boot writer).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  correspondingSourceHref,
  formatDocsStamp,
  NODE_DOCS_DIR_NAME,
  NODE_DOCS_INDEX_FILE,
  NODE_DOCS_VERSION_FILE,
  parseDocsStamp,
  PUBLIC_CORE_REPO_URL,
  PUBLIC_DOCS_URL,
} from "@hapi/protocol";
import { SUPPORT_DOCS, type SupportDoc } from "./docsBundle.generated";
import {
  isPlainRelativePath,
  PRIVATE_DIR_MODE,
  writePrivate,
} from "./supportWorkspace";
import type { ErrorLogger } from "../logging/errorLogger";

/** ErrorLogger category for a failed boot write. */
export const NODE_DOCS_LOG_CATEGORY = "node-docs-boot";

/** Every bundled page path starts with this; it is dropped under `<HAPI_HOME>/docs/`. */
const BUNDLE_PREFIX = `${NODE_DOCS_DIR_NAME}/`;

/** Leftovers of an interrupted write: `.docs-tmp-<pid>-<hex>` and `.docs-old-<pid>-<hex>`. */
const LEFTOVER_RE = /^\.docs-(tmp|old)-\d+-[0-9a-f]{8}$/;

/** The section a page is listed under in the index, by its path under `docs/`. */
const SECTIONS: ReadonlyArray<{
  title: string;
  matches: (rel: string) => boolean;
}> = [
  { title: "User guide", matches: rel => rel.startsWith("guide/") },
  { title: "Hapimatic Cloud", matches: rel => rel.startsWith("cloud-") },
  { title: "Extensions", matches: rel => rel.startsWith("extensions/") },
];

export interface NodeDocsResult {
  /** Absolute path of the docs folder. */
  path: string;
  /** Whether this call wrote the folder (false = already current). */
  written: boolean;
  stamp: string;
}

/** Absolute path of the node docs folder under a data directory. */
export function nodeDocsPath(dataDir: string): string {
  return join(resolve(dataDir), NODE_DOCS_DIR_NAME);
}

/** A bundled page's path under the docs folder (`docs/guide/faq.md` → `guide/faq.md`). */
function relativePath(doc: SupportDoc): string {
  if (!doc.path.startsWith(BUNDLE_PREFIX)) {
    throw new Error(
      `node docs: bundled page path does not start with "${BUNDLE_PREFIX}": ${doc.path}`
    );
  }
  return doc.path.slice(BUNDLE_PREFIX.length);
}

/** The generated `README.md`: version, every page by section, the source link. */
export function renderNodeDocsIndex(
  docs: ReadonlyArray<SupportDoc>,
  version: string
): string {
  const pages = docs.map(doc => ({ rel: relativePath(doc), title: doc.title }));
  const lines: string[] = [
    "# Hapimatic documentation",
    "",
    `These are the Hapimatic user guide and public docs for Hapimatic ${version}. Hapimatic writes them here from its own binary when its server starts, so they match the running version unless that write failed: if the running version is not ${version}, this folder is out of date. They are the same pages as ${PUBLIC_DOCS_URL}.`,
    "",
  ];
  const listed = new Set<string>();
  for (const section of SECTIONS) {
    const inSection = pages.filter(p => section.matches(p.rel));
    if (inSection.length === 0) continue;
    lines.push(`## ${section.title}`, "");
    for (const page of inSection) {
      lines.push(`- [${page.title}](${page.rel})`);
      listed.add(page.rel);
    }
    lines.push("");
  }
  const other = pages.filter(p => !listed.has(p.rel));
  if (other.length > 0) {
    lines.push("## Other pages", "");
    for (const page of other) lines.push(`- [${page.title}](${page.rel})`);
    lines.push("");
  }
  lines.push(
    "## Published online only",
    "",
    `- [Support matrix](${PUBLIC_DOCS_URL}support-matrix): which agents, systems and install types are supported.`,
    `- [Software bill of materials](${PUBLIC_DOCS_URL}sbom): every third-party package and its license.`,
    ""
  );
  const href = correspondingSourceHref(PUBLIC_CORE_REPO_URL, version);
  if (href) {
    lines.push(
      "## Source code",
      "",
      `The source code of this version is at ${href}. Only published releases are tagged \`v<version>\` there: if that tag does not exist, this is a development build, so read the default branch instead.`,
      ""
    );
  }
  lines.push(
    "## Links between pages",
    "",
    "A link such as `/guide/installation` points at `guide/installation.md` in this folder.",
    ""
  );
  return lines.join("\n");
}

/** `<version>+<first 12 hex of sha256 over every page and the index>`. */
export function nodeDocsStamp(
  version: string,
  docs: ReadonlyArray<SupportDoc>,
  index: string
): string {
  const hash = createHash("sha256");
  for (const doc of docs) {
    hash.update(doc.path);
    hash.update("\0");
    hash.update(doc.body);
    hash.update("\0");
  }
  hash.update(index);
  return formatDocsStamp(version, hash.digest("hex").slice(0, 12));
}

/** Remove a folder; a failure is logged and left for a later write to retry. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[node-docs] could not remove ${path}: ${message}`);
  }
}

/** Remove what an interrupted earlier write left beside the docs folder. */
function removeLeftovers(dataRoot: string): void {
  let names: string[];
  try {
    names = readdirSync(dataRoot);
  } catch {
    return;
  }
  for (const name of names) {
    if (LEFTOVER_RE.test(name)) removeQuietly(join(dataRoot, name));
  }
}

/**
 * Write the node docs for `version` unless the folder already holds them.
 * Throws on any failure (the boot wrapper below logs and continues); the
 * previous folder is left in place when the write fails. A `docs` folder with
 * no `.docs-version` was not written by Hapimatic (a `HAPI_HOME` pointed at a
 * folder that already has one), so it is never replaced or deleted.
 */
export function materializeNodeDocs(
  dataDir: string,
  version: string,
  docs: ReadonlyArray<SupportDoc> = SUPPORT_DOCS
): NodeDocsResult {
  const dataRoot = resolve(dataDir);
  const dir = nodeDocsPath(dataDir);

  // Resolve and check every target before anything on disk changes.
  const reserved = new Set([NODE_DOCS_INDEX_FILE, NODE_DOCS_VERSION_FILE]);
  const pages = docs.map(doc => {
    const rel = relativePath(doc);
    // Plain segments only: `..` or `.` would let the containment check below
    // and the write into the temporary folder resolve to different places.
    const target = resolve(dir, rel);
    if (
      !isPlainRelativePath(rel) ||
      !target.startsWith(dir + sep) ||
      reserved.has(rel)
    ) {
      throw new Error(
        `node docs: page path escapes the docs folder: ${doc.path}`
      );
    }
    return { rel, body: doc.body };
  });

  const index = renderNodeDocsIndex(docs, version);
  const stamp = nodeDocsStamp(version, docs, index);
  const stampPath = join(dir, NODE_DOCS_VERSION_FILE);
  if (existsSync(stampPath)) {
    try {
      const current = parseDocsStamp(readFileSync(stampPath, "utf8"));
      if (current && formatDocsStamp(current.version, current.hash) === stamp) {
        return { path: dir, written: false, stamp };
      }
    } catch {
      // Unreadable stamp: rewrite the folder.
    }
  } else if (existsSync(dir)) {
    throw new Error(
      `node docs: ${dir} exists and holds no ${NODE_DOCS_VERSION_FILE}, so Hapimatic did not write it; leaving it untouched`
    );
  }

  mkdirSync(dataRoot, { recursive: true });
  removeLeftovers(dataRoot);
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const tmp = join(dataRoot, `.docs-tmp-${suffix}`);
  const old = join(dataRoot, `.docs-old-${suffix}`);
  let swappedOut = false;
  try {
    mkdirSync(tmp, { mode: PRIVATE_DIR_MODE });
    chmodSync(tmp, PRIVATE_DIR_MODE);
    for (const page of pages) writePrivate(join(tmp, page.rel), page.body);
    writePrivate(join(tmp, NODE_DOCS_INDEX_FILE), index);
    // The stamp goes last: a tree without it is never taken as current.
    writePrivate(join(tmp, NODE_DOCS_VERSION_FILE), `${stamp}\n`);
    if (existsSync(dir)) {
      renameSync(dir, old);
      swappedOut = true;
    }
    renameSync(tmp, dir);
  } catch (err) {
    let restored = true;
    if (swappedOut && !existsSync(dir)) {
      try {
        renameSync(old, dir);
      } catch {
        restored = false;
      }
    }
    removeQuietly(tmp);
    if (!restored) {
      // The previous folder sits at `old` until the next write, which removes
      // it as a leftover: say so instead of claiming it was kept in place.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${message}; the previous docs folder could not be put back and is at ${old} until the next write`,
        { cause: err }
      );
    }
    throw err;
  }
  // The new folder is live; failing to remove the old one is not a failed write.
  removeQuietly(old);
  return { path: dir, written: true, stamp };
}

export interface BootNodeDocsDeps {
  dataDir: string;
  version: string;
  errorLogger?: ErrorLogger | null;
  docs?: ReadonlyArray<SupportDoc>;
}

/**
 * The server-boot call: write the node docs, and on any failure log it and
 * return, because a docs defect must never stop the server (the updater rolls
 * back a unit that crash-loops). Mirrors `writeBootSelfKnowledge`.
 */
export function writeBootNodeDocs(
  deps: BootNodeDocsDeps
): NodeDocsResult | null {
  try {
    const result = materializeNodeDocs(deps.dataDir, deps.version, deps.docs);
    if (result.written) {
      console.log(`[node-docs] wrote ${result.path} (version=${deps.version})`);
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[node-docs] could not write the node docs: ${message}`);
    deps.errorLogger?.error(
      "node docs boot writer: failed to write <HAPI_HOME>/docs (the error says what was left in place)",
      { category: NODE_DOCS_LOG_CATEGORY, context: { error: message } }
    );
    return null;
  }
}
