// SPDX-License-Identifier: MIT
import { logger } from "@/ui/logger";
import { isolatedConfigPath } from "@/accounts/accountConfigDir";
import { findCanonicalGitRoot } from "./canonicalGitRoot";
import { applyDisabledServerToggle } from "./projectMcpConfig";

/**
 * Canonical name Hapimatic registers its MCP server under in spawned
 * Claude Code sessions. Must match the key in `runClaude.ts`'s `mcpServers`
 * config and the `mcp__hapi__` prefix on `allowedTools`. Imported by the
 * scrub function and by `runClaude.ts` to keep the constant single-sourced.
 */
export const HAPI_MCP_SERVER_NAME = "hapi";

/**
 * Remove HAPI_MCP_SERVER_NAME from
 * `~/.claude.json projects.<canonical-git-root>.disabledMcpServers` so that
 * Hapimatic's `--mcp-config` injection is not silently swallowed by Claude
 * Code's project-config disable filter (issue #1347).
 *
 * **Why this exists**: Claude Code reads `disabledMcpServers` BEFORE
 * performing the MCP handshake. If `"hapi"` appears in that list (typically
 * because of a user `enforce-default-disabled` hook that auto-disables newly
 * detected MCP servers), Claude Code skips the handshake and the HAPI tools
 * (`mcp__hapi__change_title`, `mcp__hapi__image_fetch`) never register —
 * even though we pass `--mcp-config` and `--allowedTools`. The scrub
 * overrides this on every spawn so Hapimatic's tools are always available.
 *
 * **Atomicity (R4)**: delegates to {@link applyDisabledServerToggle} which
 * uses `withFileLock` (cross-process serialization, issue #1100) +
 * per-PID + per-UUID tmp file + rename (atomic).
 *
 * **Idempotency (R3)**: `applyDisabledServerToggle` returns `false` when
 * the desired state already matches; the scrub then returns without
 * writing.
 *
 * **Non-fatal (R5)**: all thrown errors are caught and logged at WARN; the
 * spawn proceeds regardless. A `~/.claude.json` write race or transient IO
 * failure should not break session spawn — the companion rp1-home
 * validator hook will surface the user-facing diagnostic if HAPI tools
 * are missing at session start.
 *
 * **Account-bound isolated config (issue #2364)**: under multi-account binding
 * (#1446/#1643) the daemon injects `HAPI_ACCOUNT_UUID` and the launcher points
 * the `claude` child at an ISOLATED config dir via `CLAUDE_CONFIG_DIR`. Claude
 * Code then reads `disabledMcpServers` from
 * `<accountConfigsDir>/<uuid>/.claude.json`, NOT `~/.claude.json` — so the
 * home-file scrub above never reaches the file Claude actually reads, and a
 * poisoned `hapi` entry there silently drops the HAPI MCP server before the
 * handshake (the ~10:00Z temporal-boundary symptom). When `HAPI_ACCOUNT_UUID`
 * is set this function makes a SECOND, independent toggle against the isolated
 * config. It is **additive** (Fallback Preservation Rule): host-default
 * (unbound) sessions still read the home file, so the home scrub is preserved
 * untouched; the two calls hold per-config-file locks so they never contend.
 * A removal from the isolated config is logged at **WARN** (it is the exact
 * silent failure this fixes); a missing isolated config is benign and quiet.
 *
 * @param workingDirectory The session's working directory (typically
 *   `process.cwd()`). Resolved to its canonical git root before the
 *   `~/.claude.json` lookup.
 * @param configPath Optional override for `~/.claude.json` (home) path — used
 *   by tests to point at a synthetic config file. Production callers omit. The
 *   account-bound isolated pass is independent of this override; it keys off
 *   `HAPI_ACCOUNT_UUID` and resolves its path via {@link isolatedConfigPath}.
 */
export async function scrubHapiFromDisabledMcps(
  workingDirectory: string,
  configPath?: string
): Promise<void> {
  const canonicalRoot =
    findCanonicalGitRoot(workingDirectory) ?? workingDirectory;
  try {
    const wrote = await applyDisabledServerToggle(
      canonicalRoot,
      HAPI_MCP_SERVER_NAME,
      /* enabled */ true,
      configPath
    );
    if (wrote) {
      logger.info(
        `[scrubHapi] Removed '${HAPI_MCP_SERVER_NAME}' from disabledMcpServers for ${canonicalRoot}`
      );
    } else {
      logger.debug(
        `[scrubHapi] No-op: '${HAPI_MCP_SERVER_NAME}' already enabled for ${canonicalRoot}`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[scrubHapi] Failed for ${canonicalRoot}: ${message}`);
    // Intentional swallow per R5 — spawn proceeds.
  }

  // Account-bound isolated-config scrub (issue #2364). ADDITIVE — the home-file
  // scrub above is unchanged; this is a second, independent toggle against the
  // file an account-bound Claude child actually reads (see the JSDoc's
  // "Account-bound isolated config" note). Gated purely on HAPI_ACCOUNT_UUID so
  // host-default (unbound) sessions are byte-identical to before.
  const accountUuid = process.env.HAPI_ACCOUNT_UUID;
  if (accountUuid) {
    try {
      const isoPath = isolatedConfigPath(accountUuid);
      const wroteIso = await applyDisabledServerToggle(
        canonicalRoot,
        HAPI_MCP_SERVER_NAME,
        /* enabled */ true,
        isoPath
      );
      if (wroteIso) {
        // WARN, not debug: a removal here IS the exact silent failure this
        // fixes — a poisoned isolated config that would otherwise have dropped
        // the HAPI tools before the handshake. Surface it loudly so any
        // recurrence is observable, never silent again (R3).
        logger.warn(
          `[scrubHapi] Account-bound: removed '${HAPI_MCP_SERVER_NAME}' from disabled list in isolated config ${isoPath} for ${canonicalRoot}`
        );
      } else {
        logger.debug(
          `[scrubHapi] Account-bound no-op: '${HAPI_MCP_SERVER_NAME}' already enabled in isolated config ${isoPath} for ${canonicalRoot}`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A missing isolated config is BENIGN: a host-default account-bound
      // session has no isolated `.claude.json` (Claude reads `~/.claude.json`,
      // covered by the home scrub above), so keep that quiet. Any OTHER error —
      // corrupt JSON, lock timeout, unsafe path, malformed UUID — is a config
      // Claude may read that we could NOT verify: surface it at WARN (R3).
      // Non-fatal either way (R5) — the spawn proceeds on the home scrub.
      if (/not found/i.test(message)) {
        logger.debug(
          `[scrubHapi] Account-bound: no isolated config for ${canonicalRoot} (${message}); home scrub is authoritative`
        );
      } else {
        logger.warn(
          `[scrubHapi] Account-bound: isolated-config scrub failed for ${canonicalRoot}: ${message}`
        );
      }
    }
  }
}
