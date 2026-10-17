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
 *   docs/guide/*.md                   the bundled user guide (offline docs)
 *   .support-version                  the materialization stamp
 *
 * Every file is written 0600. The stamp is `<version>+<content hash>`, so the
 * call is idempotent (same stamp → nothing written) and a build that changes
 * the persona or the docs re-materializes even when the release version did
 * not move. A re-materialization removes the old `docs/` tree first, so a page
 * dropped from the guide does not linger.
 *
 * The workspace holds nothing secret: only the persona and the public guide.
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

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

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

function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  writeFileSync(path, text, { mode: FILE_MODE });
  // writeFileSync's mode applies only on create — re-assert on overwrite.
  chmodSync(path, FILE_MODE);
}

/** Resolve a bundled doc path under the workspace, refusing an escape. */
function docTarget(workspace: string, docPath: string): string {
  const target = resolve(workspace, docPath);
  if (!target.startsWith(workspace + sep)) {
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

  mkdirSync(workspace, { recursive: true, mode: DIR_MODE });
  chmodSync(workspace, DIR_MODE);
  rmSync(join(workspace, "docs"), { recursive: true, force: true });

  for (const name of PERSONA_FILE_NAMES) {
    writePrivate(join(workspace, name), content.persona);
  }
  for (const doc of content.docs) {
    writePrivate(docTarget(workspace, doc.path), doc.body);
  }
  // The stamp goes last: an interrupted write leaves no current stamp, so the
  // next call rewrites everything.
  writePrivate(stampPath, `${stamp}\n`);

  return { path: workspace, written: true, stamp };
}
