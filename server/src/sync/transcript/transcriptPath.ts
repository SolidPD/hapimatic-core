// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server-side transcript path resolver (issue #1665, epic #1662 — Sub C).
 *
 * Resolves the on-disk locations the finalize-time transcript parser reads:
 *   - `main`         = `<cfg>/projects/<slug>/<ccSessionId>.jsonl`
 *   - `subagentsDir` = `<cfg>/projects/<slug>/<ccSessionId>/subagents`
 *
 * where `slug = resolve(workingDirectory).replace(/[^a-zA-Z0-9]/g, "-")` and
 * `cfg` follows the same precedence as the cli's `getProjectPath`:
 * `configDir ?? CLAUDE_CONFIG_DIR ?? ~/.claude`.
 *
 * **Why reimplement instead of import (Key Decision 1 / Fable D2):** the server
 * package depends ONLY on `@hapi/protocol` — never on `cli` — so it cannot import
 * `cli/src/claude/utils/path.ts` `getProjectPath`. The cli's session scanner is the
 * live-relay extraction path; this resolver feeds the independent finalize-batch
 * parser. They are deliberately separate latency classes; the ~6 lines of slug
 * logic are reimplemented here rather than promoting the cli helper to `shared/`.
 *
 * **Account isolation (#1573):** account-bound sessions write their transcript under
 * the account config dir, NOT host `~/.claude/projects`. The finalize seam already
 * carries the turn's resolved `transcriptPath` (set at open by the cli turnReporter,
 * which resolved it against the correct account configDir), so the PREFERRED path is
 * to trust that `transcriptPath` and only DERIVE the sibling `subagentsDir` from it.
 * The `workingDirectory` + `configDir` fallback reconstructs both paths when no
 * stored `transcriptPath` is available.
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ResolveTranscriptPathsInput {
  /** Claude Code session id — names both the `<id>.jsonl` main file and the
   *  sibling `<id>/subagents` directory. Required. */
  ccSessionId: string;
  /**
   * The turn row's stored `transcript_path` (or the finalize event's). When
   * present this is the authoritative MAIN transcript path; `subagentsDir` is
   * derived from its directory + `ccSessionId`. Preferred over reconstruction.
   */
  transcriptPath?: string;
  /** Session working directory — only needed for the reconstruction fallback. */
  workingDirectory?: string;
  /** Account config dir under isolation (#1573); falls back to env then ~/.claude. */
  configDir?: string;
}

export interface ResolvedTranscriptPaths {
  /** `<cfg>/projects/<slug>/<ccSessionId>.jsonl` (or the provided `transcriptPath`). */
  main: string;
  /** `<cfg>/projects/<slug>/<ccSessionId>/subagents`. */
  subagentsDir: string;
}

/**
 * Resolve the main transcript file + its sibling `subagents` directory.
 *
 * Prefers an explicit `transcriptPath` (the turn's stored value); otherwise
 * reconstructs both from `workingDirectory` + the config-dir precedence chain.
 * Throws when neither a `transcriptPath` nor a `workingDirectory` is available —
 * the caller (`parseTurn`) wraps this in its fail-open try/catch (R12).
 */
export function resolveTranscriptPaths(
  input: ResolveTranscriptPathsInput
): ResolvedTranscriptPaths {
  const { ccSessionId, transcriptPath, workingDirectory, configDir } = input;

  if (!ccSessionId) {
    throw new Error("resolveTranscriptPaths: ccSessionId is required");
  }

  if (transcriptPath) {
    // Preferred: trust the stored path for `main`; the subagents dir is the
    // session-id-named sibling of the project directory the main file lives in.
    return {
      main: transcriptPath,
      subagentsDir: join(dirname(transcriptPath), ccSessionId, "subagents"),
    };
  }

  if (!workingDirectory) {
    throw new Error(
      "resolveTranscriptPaths: need transcriptPath or workingDirectory to resolve"
    );
  }

  const slug = resolve(workingDirectory).replace(/[^a-zA-Z0-9]/g, "-");
  const claudeConfigDir =
    configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const projectDir = join(claudeConfigDir, "projects", slug);

  return {
    main: join(projectDir, `${ccSessionId}.jsonl`),
    subagentsDir: join(projectDir, ccSessionId, "subagents"),
  };
}
