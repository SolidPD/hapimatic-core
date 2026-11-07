// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The docs pointer every session is given (issue #6219): where this machine's
 * Hapimatic documentation is, which version it matches, and where the source of
 * that version is. The Claude system prompt, the Codex developer instructions
 * and the first turn of a Gemini or OpenCode session all append it, independent
 * of the Tier-0 kill-switch (`HAPI_CAPABILITY_TIER0=0` restores the old base
 * prompt; a session must still know where its docs are).
 *
 * The server writes the docs to `<HAPI_HOME>/docs/` at boot
 * (`server/src/support/nodeDocs.ts`); this reads that folder's stamp. The local
 * folder is named only when the stamp's version is the version this binary
 * runs: a failed rewrite can leave an older tree, which must never be labelled
 * as this version. Otherwise (no server on this machine, or a mismatch) the
 * pointer names the public docs site. The text itself comes from the shared
 * contract (`renderDocsPointer`), so every harness gets the same words.
 * `HAPI_DOCS_POINTER=0` turns the pointer off on every harness without a code
 * change (`configuration.docsPointerEnabled`).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  correspondingSourceHref,
  NODE_DOCS_DIR_NAME,
  NODE_DOCS_VERSION_FILE,
  parseDocsStamp,
  PUBLIC_CORE_REPO_URL,
  renderDocsPointer,
  type DocsLocation,
} from "@hapi/protocol";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import { CLI_VERSION } from "@/version";

/** Seams for tests; every default reads the real machine. */
export interface DocsPointerDeps {
  /** `HAPI_HOME` (default: the cli configuration's home dir). */
  homeDir?: string;
  /** The running version (default: `CLI_VERSION`). */
  version?: string;
  /** Read a file as text; throws when it cannot (default: `readFileSync`). */
  readText?: (path: string) => string;
  /** The off switch (default: `configuration.docsPointerEnabled`). */
  enabled?: boolean;
}

/** Where this session's docs are: the local folder when it holds this version. */
export function resolveDocsLocation(deps: DocsPointerDeps = {}): DocsLocation {
  const version = deps.version ?? CLI_VERSION;
  // Resolved as the server resolves it (`server/src/support/nodeDocs.ts`). A
  // relative HAPI_HOME resolves against each process's own working directory,
  // so it can name a folder with no stamp; the pointer then names the site.
  const dir = join(
    resolve(deps.homeDir ?? configuration.happyHomeDir),
    NODE_DOCS_DIR_NAME
  );
  const readText =
    deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
  try {
    const stamp = parseDocsStamp(readText(join(dir, NODE_DOCS_VERSION_FILE)));
    if (stamp && stamp.version === version) {
      return { kind: "local", dir, version };
    }
    logger.debug(
      `[docs-pointer] ${dir} holds ${stamp ? `v${stamp.version}` : "an unreadable stamp"}, not v${version}: naming the public site`
    );
  } catch (err) {
    // No stamp (no server here yet, or an unreadable folder): the public site.
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      logger.debug(`[docs-pointer] cannot read the stamp in ${dir}`, err);
    }
  }
  return { kind: "public", version };
}

/**
 * The pointer text, or "" when `HAPI_DOCS_POINTER` turns it off. Never throws:
 * a session must start even when the docs folder cannot be read, so any
 * failure falls back to the public-site text.
 */
export function buildDocsPointer(deps: DocsPointerDeps = {}): string {
  if (!(deps.enabled ?? configuration.docsPointerEnabled)) return "";
  const version = deps.version ?? CLI_VERSION;
  const href = correspondingSourceHref(PUBLIC_CORE_REPO_URL, version);
  try {
    return renderDocsPointer(resolveDocsLocation(deps), href);
  } catch {
    return renderDocsPointer({ kind: "public", version }, href);
  }
}
