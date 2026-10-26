// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, readFile, readdir, readlink, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  REPAIRABLE_FILE_DIMS,
  USER_SCOPE_CONFIG_DIMS,
} from "@hapi/protocol/accountConfigDims";
import type { AccountVisibility } from "@hapi/protocol/porter";
// #5601: the wire shapes live in @hapi/protocol/porter (importWire.ts).
export type { AccountVisibility } from "@hapi/protocol/porter";

/**
 * Post-import visibility verification (#3246) — a READ-ONLY server-side probe
 * that answers "written ≠ visible": after `commitImport` writes the imported
 * config dimensions to the destination `claudeDir`, did each isolated per-account
 * config dir actually SEE them via the #1562 symlink bridge?
 *
 * ─── LOCKSTEP (read this before editing) ──────────────────────────────────────
 * This module is a READ-ONLY re-implementation of the per-dim classification in
 * `provisionUserScopeConfigDir` (`cli/src/accounts/accountConfigDir.ts`). The
 * server package structurally does NOT import `cli/` (server → @hapi/protocol
 * only; precedents: `server/src/accounts/usageService.ts`,
 * `server/src/federation/capabilityDetector.ts`), so the classification is
 * mirrored here by comment, NOT imported. The dimension LIST is single-sourced
 * from `@hapi/protocol/accountConfigDims` (lifted by #3246) so both sides never
 * disagree on WHICH dims exist; `REPAIRABLE_FILE_DIMS` (#4681) is single-sourced
 * there too. If the bridge's per-dim `lstat`/`readlink`/`stat`/byte-compare
 * semantics change, update this file in lockstep.
 *
 * ─── PROBE ≠ MUTATE ───────────────────────────────────────────────────────────
 * The bridge collapses "correct existing symlink", "newly created", and
 * "re-pointed" all into `linked` because it is about to ACT. This probe runs a
 * moment BEFORE the next spawn's provisioning and reports the CURRENT state, so
 * it distinguishes:
 *   - correct symlink now                 → `visible`  (bridge no-ops)
 *   - dst absent (host source present)    → `pending`  (bridge links next spawn; its `existing === null` branch)
 *   - wrong-target symlink                → `pending`  (bridge RE-POINTS next spawn; its `isSymbolicLink()` branch — self-healing)
 *   - REAL regular file at a repairable file dim, byte-identical to the host source
 *                                         → `pending`  (bridge restores the link next spawn; #4681)
 *   - any other REAL file/dir at dst      → `orphaned` (bridge REFUSES to clobber; isolation degraded)
 *   - host source absent                  → `absent`
 * `orphaned` means "isolation degraded — the session falls back to the host dir"
 * (per the #1574 fallback the imported skills ARE still visible from the host
 * `~/.claude`), NOT "skills not visible". `pending` is the NORMAL first-import
 * state and is NEVER a warning.
 *
 * Zero side effects: `lstat`/`stat`/`readdir`/`readlink`/`readFile` only — no
 * `symlink`/`unlink`/`mkdir`. Probing must NEVER clobber a real skills dir (that guard is data-loss
 * protection; the fix VERIFIES + SURFACES the orphan, it does not "fix" it).
 */

/**
 * Classify one dim for one account dir, mirroring `provisionUserScopeConfigDir`'s
 * per-dim `lstat`/`readlink` logic (read-only). The symlink-target comparison is
 * the SAME exact-string compare the bridge does (`readlink(dst) ===
 * join(hostClaudeDir, dim)`) — deliberately NOT `realpath`, so a functionally-
 * equivalent-but-textually-different link reads exactly as the bridge would treat
 * it.
 */
async function classifyDim(
  accountDir: string,
  hostClaudeDir: string,
  dim: string
): Promise<"visible" | "pending" | "orphaned" | "absent"> {
  const src = join(hostClaudeDir, dim);
  const dst = join(accountDir, dim);

  // Host source must exist; a legitimately-absent dim is `absent` (bridge: skipped).
  const srcExists = await lstat(src).then(
    () => true,
    () => false
  );
  if (!srcExists) return "absent";

  const existing = await lstat(dst).then(
    s => s,
    () => null
  );
  if (existing === null) return "pending"; // bridge creates the link next spawn
  if (existing.isSymbolicLink()) {
    const tgt = await readlink(dst).catch(() => null);
    return tgt === src ? "visible" : "pending"; // wrong-target → bridge re-points
  }
  // #4681: a byte-identical copy at a repairable file dim is restored by the
  // bridge at the next spawn, so it is pending, not orphaned.
  if (
    existing.isFile() &&
    (REPAIRABLE_FILE_DIMS as readonly string[]).includes(dim)
  ) {
    const identical = await stat(src)
      .then(async s =>
        s.isFile() ? (await readFile(dst)).equals(await readFile(src)) : false
      )
      .catch(() => false);
    if (identical) return "pending";
  }
  return "orphaned"; // real file/dir — bridge refuses to clobber; isolation degraded
}

/**
 * Enumerate the isolated per-account config dirs under each BASE dir and classify
 * every requested `dims` entry per account. `bases` are the PARENT dirs (from
 * `resolveAccountConfigBases`); each `<base>/<uuid>/` subdirectory is one account
 * (enumeration pattern mirrors `enumerateAccountConfigFiles`, but WITHOUT the
 * `.claude.json` gate — the visibility question is about the dim symlinks, so a
 * provisioned-but-not-yet-MCP-merged account is still probed). A missing base is
 * skipped silently (best-effort, never fatal).
 *
 * `dims` should be the IMPORTED bridge dims (see {@link deriveImportedBridgeDims})
 * so the probe reports on what THIS import wrote, not the full bridge surface.
 * `hostClaudeDir` is the destination the import actually wrote to (`plan.claudeDir`)
 * — comparing account symlink targets against it also surfaces a wrong
 * `CLAUDE_CONFIG_DIR` (the import wrote somewhere the bridge does not link to).
 */
export async function probeAccountVisibility(
  bases: readonly string[],
  opts: { hostClaudeDir: string; dims: readonly string[] }
): Promise<AccountVisibility[]> {
  const { hostClaudeDir, dims } = opts;
  const out: AccountVisibility[] = [];

  for (const base of bases) {
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue; // base absent — no isolated accounts here
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const accountDir = join(base, e.name);
      const acc: AccountVisibility = {
        account: e.name,
        base,
        visible: [],
        pending: [],
        orphaned: [],
        absent: [],
      };
      for (const dim of dims) {
        const status = await classifyDim(accountDir, hostClaudeDir, dim);
        acc[status].push(dim);
      }
      out.push(acc);
    }
  }
  return out;
}

/**
 * The bridge dims relevant to a porter import's per-account VISIBILITY:
 * `USER_SCOPE_CONFIG_DIMS` minus `plugins` (travels via the separate #2465 install
 * path, never a config-dim write under `<claudeDir>/plugins`) and `projects` (a
 * deliberately SHARED host tree — never per-account isolated). Derived from the
 * single-sourced list so the base authority stays one place; the two exclusions
 * are DEFINITIONAL (the directive's explicit 7-dim probe set), not an accident of
 * porter's current write behavior. Leaves exactly `skills`, `commands`, `agents`,
 * `rules`, `output-styles`, `CLAUDE.md`, `settings.json`.
 */
const PORTER_BRIDGE_PROBE_DIMS = USER_SCOPE_CONFIG_DIMS.filter(
  d => d !== "plugins" && d !== "projects"
);

/**
 * Derive the IMPORTED bridge dims from a commit's `filesWritten` + `settingsMerged`
 * — i.e. `imported ∩ {@link PORTER_BRIDGE_PROBE_DIMS}`, so the probe reports on what
 * THIS import wrote:
 *  - a directory dim (e.g. `skills`) is imported iff some written path is at or
 *    under `<claudeDir>/<dim>`;
 *  - `CLAUDE.md` (a file dim) is imported iff `<claudeDir>/CLAUDE.md` was written;
 *  - `settings.json` is imported iff the settings merge changed it (it never lands
 *    in `filesWritten` — the merge path is separate) OR it was written as a file.
 *
 * `projects`/`plugins` are excluded by definition (see {@link PORTER_BRIDGE_PROBE_DIMS}).
 */
export function deriveImportedBridgeDims(
  filesWritten: readonly string[],
  opts: { claudeDir: string; settingsMerged: boolean }
): string[] {
  const { claudeDir, settingsMerged } = opts;
  const imported: string[] = [];
  for (const dim of PORTER_BRIDGE_PROBE_DIMS) {
    const dimPath = join(claudeDir, dim);
    if (dim === "settings.json") {
      if (settingsMerged || filesWritten.includes(dimPath)) imported.push(dim);
      continue;
    }
    const touched = filesWritten.some(
      p => p === dimPath || p.startsWith(dimPath + sep)
    );
    if (touched) imported.push(dim);
  }
  return imported;
}
