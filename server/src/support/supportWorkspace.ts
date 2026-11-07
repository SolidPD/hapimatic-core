// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The in-app support session's working directory (issue #4371, E6 Sub F).
 *
 * `materializeSupportWorkspace` writes `<dataDir>/support/` (0700):
 *
 *   CLAUDE.md, AGENTS.md, GEMINI.md   the support persona (identical text) —
 *                                     every harness loads its instruction file
 *                                     from the cwd, so no spawn-body field and
 *                                     no protocol change is needed
 *   docs/guide/, docs/cloud-*.md,     the bundled public docs pages (offline)
 *   docs/extensions/
 *   .support-version                  the materialization stamp
 *
 * Every file is written 0600. The stamp is `<version>+<content hash>`, so the
 * call is idempotent (same stamp → nothing written) and a build that changes
 * the persona or the docs re-materializes even when the release version did
 * not move. A re-materialization removes the old `docs/` tree first, so a page
 * dropped from the guide does not linger.
 *
 * The workspace holds nothing secret: only the persona and the public docs.
 *
 * Pattern: the version-stamped materialization of
 * `scripts/lib/provision-helpers.sh` (`push_agent_self_knowledge`).
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  SUPPORT_DOCS,
  SUPPORT_PERSONA,
  type SupportDoc,
} from "./docsBundle.generated";

export const SUPPORT_DIR_NAME = "support";
export const SUPPORT_VERSION_FILE = ".support-version";
export const PERSONA_FILE_NAMES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];

/** Modes for the private trees this module and `nodeDocs.ts` write. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export interface SupportWorkspaceContent {
  persona: string;
  docs: ReadonlyArray<SupportDoc>;
}

export interface MaterializeResult {
  /** Absolute path of the support workspace. */
  path: string;
  /** Whether this call wrote the workspace (false = already current). */
  written: boolean;
  stamp: string;
}

/** Absolute path of the support workspace under a data directory. */
export function supportWorkspacePath(dataDir: string): string {
  return join(resolve(dataDir), SUPPORT_DIR_NAME);
}

/** `<version>+<first 12 hex of sha256(persona, docs)>`. */
export function supportStamp(
  version: string,
  content: SupportWorkspaceContent
): string {
  const hash = createHash("sha256");
  hash.update(content.persona);
  for (const doc of content.docs) {
    hash.update("\0");
    hash.update(doc.path);
    hash.update("\0");
    hash.update(doc.body);
  }
  return `${version}+${hash.digest("hex").slice(0, 12)}`;
}

/** Write a file 0600, creating its parent folders 0700. */
export function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
  writeFileSync(path, text, { mode: PRIVATE_FILE_MODE });
  // writeFileSync's mode applies only on create — re-assert on overwrite.
  chmodSync(path, PRIVATE_FILE_MODE);
}

/**
 * True when every `/`-separated segment of `path` is a plain name: no empty,
 * `.` or `..` segment. Such a path cannot climb out of the folder it is
 * resolved against, or climb out and back in, so a containment check on the
 * resolved path and the write of the same relative path agree on where it
 * lands. Shared by the support workspace and the node docs (#6219).
 */
export function isPlainRelativePath(path: string): boolean {
  return path.split("/").every(s => s !== "" && s !== "." && s !== "..");
}

/**
 * Resolve a bundled doc path under the workspace's `docs/`, refusing an
 * escape. Plain segments only: `docs/../CLAUDE.md` stays inside the workspace
 * yet would overwrite the persona file written before the docs (#6219).
 */
function docTarget(workspace: string, docPath: string): string {
  const target = resolve(workspace, docPath);
  if (
    !isPlainRelativePath(docPath) ||
    !docPath.startsWith("docs/") ||
    !target.startsWith(workspace + sep)
  ) {
    throw new Error(`support doc path escapes the workspace: ${docPath}`);
  }
  return target;
}

export function materializeSupportWorkspace(
  dataDir: string,
  version: string,
  content: SupportWorkspaceContent = {
    persona: SUPPORT_PERSONA,
    docs: SUPPORT_DOCS,
  }
): MaterializeResult {
  const workspace = supportWorkspacePath(dataDir);
  const stamp = supportStamp(version, content);
  const stampPath = join(workspace, SUPPORT_VERSION_FILE);

  if (existsSync(stampPath)) {
    try {
      if (readFileSync(stampPath, "utf8").trim() === stamp) {
        return { path: workspace, written: false, stamp };
      }
    } catch {
      // Unreadable stamp: fall through and rewrite the workspace.
    }
  }

  // Resolve every target before anything on disk changes, so an escaping path
  // throws with the previous workspace intact (#6219).
  const targets = content.docs.map(doc => ({
    target: docTarget(workspace, doc.path),
    body: doc.body,
  }));

  mkdirSync(workspace, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(workspace, PRIVATE_DIR_MODE);
  // Remove the old stamp before the old docs (#6219): the stamp sits outside
  // `docs/`, so if the rewrite below is interrupted a surviving stamp would
  // still match an older binary (after an updater rollback) over a
  // half-written tree.
  rmSync(stampPath, { force: true });
  rmSync(join(workspace, "docs"), { recursive: true, force: true });

  for (const name of PERSONA_FILE_NAMES) {
    writePrivate(join(workspace, name), content.persona);
  }
  for (const { target, body } of targets) {
    writePrivate(target, body);
  }
  // The stamp goes last: an interrupted write leaves no stamp at all, so the
  // next call rewrites everything.
  writePrivate(stampPath, `${stamp}\n`);

  return { path: workspace, written: true, stamp };
}
