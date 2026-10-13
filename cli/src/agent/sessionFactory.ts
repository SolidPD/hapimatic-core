// SPDX-License-Identifier: AGPL-3.0-only
import os from "node:os";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync, execSync } from "node:child_process";

import { ApiClient } from "@/api/api";
import type { ApiSessionClient } from "@/api/apiSession";
import type {
  AgentState,
  MachineMetadata,
  Metadata,
  RepoIdentity,
  Session,
  SessionRole,
} from "@/api/types";
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { readSettings } from "@/persistence";
import type { AuthBinding } from "@hapi/protocol";
import { AuthBindingSchema } from "@hapi/protocol/schemas";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import { runtimePath } from "@/projectPath";
import { readWorktreeEnv } from "@/utils/worktreeEnv";
import { readClaudeAccountInfo } from "@/utils/claudeCredentials";
import { accountStore } from "@/accounts/accountStore";
import {
  accountInfoFromStored,
  readBoundApiKeyId,
} from "@/claude/accountTokenInjection";
import { detectAgentCapabilities } from "@/utils/agentCapabilities";
import packageJson from "../../package.json";
import { CLI_VERSION } from "@/version";

export type SessionStartedBy = "daemon" | "terminal";

export type SessionBootstrapOptions = {
  flavor: string;
  startedBy?: SessionStartedBy;
  workingDirectory?: string;
  tag?: string;
  agentState?: AgentState | null;
  /** Issue #1633: session launched with --safe-mode — stamped into metadata
   *  so server-side respawn paths preserve the flag across restarts. */
  safeMode?: boolean;
  /** Issue #2155: role-scoped `@`-include profile — stamped into metadata so
   *  server-side respawn paths preserve the role across restarts. */
  sessionRole?: SessionRole;
};

export type SessionBootstrapResult = {
  api: ApiClient;
  session: ApiSessionClient;
  sessionInfo: Session;
  metadata: Metadata;
  machineId: string;
  startedBy: SessionStartedBy;
  workingDirectory: string;
};

/**
 * Detects if running inside a tmux session and returns the window name.
 * Returns undefined if not in tmux or detection fails.
 */
function detectTmuxWindowName(): string | undefined {
  // Check if we're inside tmux
  if (!process.env.TMUX) {
    return undefined;
  }

  try {
    // Get the current tmux window name using tmux display-message
    const result = execSync('tmux display-message -p "#{window_name}"', {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"], // Suppress stderr
    });
    const windowName = result.trim();
    if (windowName) {
      logger.debug(`[SESSION] Detected tmux window name: ${windowName}`);
      return windowName;
    }
  } catch (error) {
    logger.debug("[SESSION] Failed to detect tmux window name:", error);
  }

  return undefined;
}

/**
 * Parse a git remote URL (SSH or HTTPS) and extract owner/repo identity.
 * Returns null if the URL cannot be parsed.
 */
function parseGitRemoteUrl(
  remoteUrl: string
): { name: string; url?: string } | null {
  const trimmed = remoteUrl.trim();

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    const name = `${owner}/${repo}`;
    const isGitHub = host === "github.com";
    return {
      name,
      url: isGitHub ? `https://github.com/${name}` : `https://${host}/${name}`,
    };
  }

  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = trimmed.match(
    /^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    const [, host, owner, repo] = httpsMatch;
    const name = `${owner}/${repo}`;
    return {
      name,
      url: `https://${host}/${name}`,
    };
  }

  return null;
}

/**
 * Resolve git repo identity for the given working directory.
 * Runs `git remote get-url origin` with a short timeout.
 * Returns undefined if not a git repo or no remote configured.
 */
function resolveRepoIdentity(
  workingDirectory: string
): RepoIdentity | undefined {
  try {
    const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: workingDirectory,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!remoteUrl) return undefined;

    const parsed = parseGitRemoteUrl(remoteUrl);
    if (!parsed) {
      logger.debug(`[SESSION] Could not parse git remote URL: ${remoteUrl}`);
      return undefined;
    }

    logger.debug(`[SESSION] Resolved repo identity: ${parsed.name}`);
    return parsed;
  } catch {
    // Not a git repo, no remote, or timeout — graceful fallback
    return undefined;
  }
}

/**
 * Issue #3806 (epic #3345): the fixed allowlist of provider-secret env-var NAMES
 * whose PRESENCE (never value) is stamped on the machine record. The same three
 * names appear in `SECRET_ENV_VARS` (`cli/src/sandbox/secretEnvVars.ts`); the
 * server derives the Gemini `keySource:"daemon-env"` signal from this list.
 */
const PROVIDER_SECRET_ENV_NAMES = [
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

/**
 * Issue #3806: NAMES-ONLY presence stamp of provider-secret env vars set in the
 * daemon's OWN environment (D11 = C). Returns the subset of the fixed allowlist
 * present + non-empty in `process.env` — never a value. The daemon's env is the
 * one that matters: it builds every child env as `{...process.env, ...extraEnv}`
 * (`sessionSpawner.ts`), and the drop-in that carries a key lives on the `-daemon`
 * units. Refreshes only at daemon (re)connect, which matches reality (a drop-in
 * change needs a daemon restart anyway). [ER 2026-09-19: D11]
 */
function detectProviderEnv(): string[] {
  return PROVIDER_SECRET_ENV_NAMES.filter(
    name => (process.env[name] ?? "").length > 0
  );
}

export function buildMachineMetadata(): MachineMetadata {
  return {
    host: os.hostname(),
    platform: os.platform(),
    happyCliVersion: CLI_VERSION,
    homeDir: os.homedir(),
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir: runtimePath(),
    // Issue #1081: stamp agent CLI availability onto the machine record so the
    // web UI can disable agent options whose binary is absent.
    capabilities: detectAgentCapabilities(),
    // Issue #3806 (epic #3345): PRESENCE-ONLY names of provider-secret env vars
    // in the daemon's env — never the values (D11 = C). Empty array when none.
    providerEnv: detectProviderEnv(),
  };
}

export async function buildSessionMetadata(options: {
  flavor: string;
  startedBy: SessionStartedBy;
  workingDirectory: string;
  machineId: string;
  now?: number;
  /** The session tag used to register with the server. Used by daemon for correlation. */
  sessionTag?: string;
  /** Issue #1633: session launched with --safe-mode (scaffolding disabled). */
  safeMode?: boolean;
  /** Issue #2155: role-scoped `@`-include profile (pm/worker/…). */
  sessionRole?: SessionRole;
}): Promise<Metadata> {
  const happyLibDir = runtimePath();
  const worktreeInfo = readWorktreeEnv();
  const now = options.now ?? Date.now();

  // Use tmux window name as session name for synchronization
  // Priority: 1. HAPI_TMUX_WINDOW env var (set by daemon spawn)
  //           2. Detect tmux window name (for manual terminal sessions)
  // This enables name synchronization between Hapimatic sessions and tmux windows
  const defaultName = process.env.HAPI_TMUX_WINDOW ?? detectTmuxWindowName();

  // Read Claude account info (plan type, tier) for display in UI.
  // Multi-account (epic #1446, Sub-Issue D): when this process is bound to an
  // account (HAPI_ACCOUNT_UUID set), report the BOUND account's identity from the
  // AccountStore record instead of the host's on-disk default — the host disk
  // (and the 30s refresh loop) would otherwise surface the wrong account (R4, KD-5).
  const boundAccountUuid = process.env.HAPI_ACCOUNT_UUID || undefined;
  // #3808 (epic #3345): `claudeAccount` is the ANTHROPIC account identity — stamp
  // it ONLY for a Claude session. A codex/gemini session's HAPI_ACCOUNT_UUID is a
  // NON-Anthropic provider account: `accountStore.get()` (Anthropic-only) fails on
  // it, and reading the host default would leave the WRONG account stamped — the
  // #3748 wrong-provider `claudeAccount` this gate removes. The provider binding is
  // verifiable instead via `metadata.accountUuid` (stamped below for every flavor)
  // + `authBinding.providerId`. [ER 2026-09-19: 3808-7]
  const isClaudeFlavor = options.flavor === "claude";
  // Issue #4568: an API-key session bills a vault key and binds NO subscription
  // account, so it records no `claudeAccount` — the host's on-disk login (read by
  // `readClaudeAccountInfo` for an unbound session) is NOT what it runs on, and
  // stamping it would name the wrong credential on every account surface.
  const boundApiKeyId = readBoundApiKeyId() ?? undefined;
  let claudeAccount =
    isClaudeFlavor && !boundApiKeyId
      ? await readClaudeAccountInfo()
      : undefined;
  if (isClaudeFlavor && boundAccountUuid) {
    const bound = await accountStore.get(boundAccountUuid);
    if (bound?.ok) {
      claudeAccount = accountInfoFromStored(bound.account);
    }
  }

  // Resolve git repo identity for project grouping
  const repoIdentity = resolveRepoIdentity(options.workingDirectory);

  // Issue #3351 (epic #3345 Sub-Issue F): stamp the per-session auth binding the
  // daemon COMPUTED and delivered via HAPI_AUTH_BINDING (mirrors HAPI_ACCOUNT_UUID
  // / HAPI_NATIVE_MODEL — daemon has no metadata write path, so the child stamps).
  // Parse DEFENSIVELY: malformed/absent → omit the field entirely; never throw,
  // never partially stamp. For a claude subscription binding the daemon leaves
  // `displayIdentity` EMPTY and we fill the bound-account email here (the account
  // identity is child-resolved, exactly as `claudeAccount` above). A non-empty
  // displayIdentity (codex "ChatGPT", a vault label, "Host default") is kept
  // verbatim — never overwritten with the account email (that would reintroduce
  // the #3748 wrong-account-on-non-claude bug this field exists to fix).
  let authBinding: AuthBinding | undefined;
  const rawAuthBinding = process.env.HAPI_AUTH_BINDING;
  if (rawAuthBinding) {
    try {
      const parsedBinding = AuthBindingSchema.safeParse(
        JSON.parse(rawAuthBinding)
      );
      if (parsedBinding.success) {
        authBinding = parsedBinding.data;
        if (
          authBinding.kind === "subscription-account" &&
          !authBinding.displayIdentity
        ) {
          authBinding = {
            ...authBinding,
            displayIdentity: claudeAccount?.email ?? "",
          };
        }
      }
    } catch {
      // Malformed HAPI_AUTH_BINDING JSON → omit the field (never throw).
    }
  }

  return {
    path: options.workingDirectory,
    host: os.hostname(),
    version: CLI_VERSION,
    name: defaultName,
    os: os.platform(),
    machineId: options.machineId,
    homeDir: os.homedir(),
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir,
    happyToolsDir: resolve(happyLibDir, "tools", "unpacked"),
    startedFromDaemon: options.startedBy === "daemon",
    hostPid: process.pid,
    startedBy: options.startedBy,
    lifecycleState: "running",
    lifecycleStateSince: now,
    flavor: options.flavor,
    worktree: worktreeInfo ?? undefined,
    // Include sessionTag for daemon to correlate terminal-started sessions with server
    // This is the tag the session registered with on the server
    hapiSessionTag: options.sessionTag,
    // Claude account info for UI display (plan badge)
    claudeAccount,
    // Git repo identity for project grouping + header display
    repoIdentity,
    ...(process.env.HAPI_ORIGINATING_NODE_ID
      ? { originatingNodeId: process.env.HAPI_ORIGINATING_NODE_ID }
      : {}),
    ...(boundAccountUuid ? { accountUuid: boundAccountUuid } : {}),
    // Issue #3348: the non-claude native model selected at spawn (gemini id /
    // codex ChatGPT-token id), delivered by the daemon via the HAPI_NATIVE_MODEL
    // env so the in-session UI can DISPLAY the active model for a flavor whose CLI
    // doesn't report `resolvedModel` to Hapimatic. Stamped CLI-side (here, in the
    // uniform metadata builder) so it rides the CLI-owned metadata blob — no
    // server-side clobber race (unlike modelMode/rawModel, which are stamped in
    // runClaude for the same reason). Absent for claude (no HAPI_NATIVE_MODEL) and
    // for a default/Auto spawn. Display-only; a codex model change recreates the
    // session (ruling D2(a)), so it is never mutated in place.
    ...(process.env.HAPI_NATIVE_MODEL
      ? { nativeModel: process.env.HAPI_NATIVE_MODEL }
      : {}),
    // Issue #3351: the per-session auth binding (kind + display identity),
    // parsed from HAPI_AUTH_BINDING above. Absent when the daemon delivered no
    // carrier (legacy/in-flight) or the payload was malformed.
    ...(authBinding ? { authBinding } : {}),
    // Issue #4568: the API-key binding (vault id + the mask recorded at spawn) so
    // every server-side respawn re-binds the SAME key and the launch-time mask
    // check can refuse a key replaced under the same id. Never key material.
    ...(boundApiKeyId
      ? {
          apiKeyId: boundApiKeyId,
          ...(process.env.HAPI_API_KEY_MASKED
            ? { apiKeyMasked: process.env.HAPI_API_KEY_MASKED }
            : {}),
        }
      : {}),
    // Issue #1633: persist the Safe Mode flag so server-side respawns
    // (model switch / account switch) re-spawn with --safe-mode intact.
    ...(options.safeMode ? { safeMode: true } : {}),
    // Issue #2155: persist the role-scoped profile so server-side respawns
    // re-spawn with the SAME role — otherwise a respawn silently reverts to the
    // full stack (OR-4). Omitted when absent (interactive/legacy sessions).
    ...(options.sessionRole ? { sessionRole: options.sessionRole } : {}),
  } as Metadata;
}

async function getMachineIdOrExit(): Promise<string> {
  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(
      `[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on ${packageJson.bugs}`
    );
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  return machineId;
}

async function reportSessionStarted(
  sessionId: string,
  metadata: Metadata
): Promise<void> {
  try {
    logger.debug(`[START] Reporting session ${sessionId} to daemon`);
    const result = await notifyDaemonSessionStarted(sessionId, metadata);
    if (result?.error) {
      logger.debug(
        `[START] Failed to report to daemon (may not be running):`,
        result.error
      );
    } else {
      logger.debug(`[START] Reported session ${sessionId} to daemon`);
    }
  } catch (error) {
    logger.debug(
      "[START] Failed to report to daemon (may not be running):",
      error
    );
  }
}

export async function bootstrapSession(
  options: SessionBootstrapOptions
): Promise<SessionBootstrapResult> {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const startedBy = options.startedBy ?? "terminal";
  // Use provided tag, or HAPI_SESSION_ID env var (for reconnect/daemon spawn), or generate new UUID
  const sessionTag = options.tag ?? process.env.HAPI_SESSION_ID ?? randomUUID();
  const isSessionReuse = !!process.env.HAPI_SESSION_ID && !options.tag;
  // Ensure HAPI_SESSION_ID is available in process.env for hooks (e.g., issue auto-linker).
  // Both daemon spawn paths (tmuxSpawnAdapter and the direct spawn, #5083) inject the
  // spawn's tag; a session started with none generates one above and writes it back here.
  // Safe: the daemon strips any inherited value on startup and before every spawn (#283).
  if (!process.env.HAPI_SESSION_ID) {
    process.env.HAPI_SESSION_ID = sessionTag;
  }
  if (isSessionReuse) {
    logger.debug(
      `[SESSION] Reusing session from HAPI_SESSION_ID env var: ${sessionTag}`
    );
  }
  const agentState = options.agentState === undefined ? {} : options.agentState;

  const api = await ApiClient.create();

  const machineId = await getMachineIdOrExit();
  await api.getOrCreateMachine({
    machineId,
    metadata: buildMachineMetadata(),
  });

  const metadata = await buildSessionMetadata({
    flavor: options.flavor,
    startedBy,
    workingDirectory,
    machineId,
    sessionTag, // Pass sessionTag to include in metadata for daemon correlation
    safeMode: options.safeMode,
    sessionRole: options.sessionRole,
  });

  const sessionInfo = await api.getOrCreateSession({
    tag: sessionTag,
    metadata,
    state: agentState,
  });

  const session = api.sessionSyncClient(sessionInfo);

  await reportSessionStarted(sessionInfo.id, metadata);

  return {
    api,
    session,
    sessionInfo,
    metadata,
    machineId,
    startedBy,
    workingDirectory,
  };
}
