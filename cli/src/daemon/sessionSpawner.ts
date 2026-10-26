// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Grandfathered god-file: extracted VERBATIM from run.ts (Epic 0, #2081/#2077) already at ~1498/1500 by construction; decomposition verdict tracked in claudedocs/architecture-hotspot-review.md. #1082 adds the codex tmux-persistence gate/wiring. */
/**
 * `sessionSpawner` — the daemon's session-spawning core, extracted from
 * `run.ts`'s `startDaemon` closure (issue #2081, Epic #2077 Sub-Issue D).
 *
 * Owns `spawnSession` (+ its nested worktree/codex cleanup helpers and the
 * clone-on-spawn path) — the largest single extraction of the decomposition.
 * `createSessionSpawner(ctx, tracker)` destructures the shared tracked-session
 * maps from the injected {@link DaemonContext} and the three tracker helpers it
 * calls (`computeEffectiveCount`, `onChildExited`, `isTmuxWindowWrapperAlive`)
 * from the {@link SessionTracker}, then returns `spawnSession`. The body is
 * moved VERBATIM from `run.ts` — a pure mechanical extraction, no behavior
 * change (referee'd by `run.test.ts`, the #2079 characterization suite). The
 * import graph is a one-way DAG: sessionSpawner → sessionTracker.
 *
 * The module-scope per-scheduler spawn rate-limit state and `waitForAnyChild`
 * live here too (their only caller is `spawnSession`; #2081 KD3).
 */
import fs from "fs/promises";
import os from "os";
import { join } from "path";
import { logger } from "@/ui/logger";
import { configuration } from "@/configuration";
import { spawnHappyCLI } from "@/utils/spawnHappyCLI";
import { readSettings } from "@/persistence";
import { isQualifiedApiKeyRef } from "@hapi/protocol/apiKeyRef";
import { resolveSharedApiKey } from "@/apiKeys/sharedKeyClient";
import {
  writeOpenRouterCodexHome,
  writeChatGptCodexHome,
} from "@/extensions/agent-codex/codex/utils/codexProviderConfig";
import { setupCodexHomeForTmux } from "@/extensions/agent-codex/codex/codexTmuxLauncher";
import { projectSkills, isSkillProjectionEnabled } from "@/agent/projection";
import { buildOpenCodeConfigContent } from "@/agent/runners/opencodeConfig";
import { isProcessAlive } from "@/utils/process";
import { isPidDescendantOf } from "@/utils/processTree";
import {
  createWorktree,
  ensureWorktreeNodeModules,
  forceRemoveWorktreeAndBranch,
  isExistingLinkedWorktree,
  kickExpiredWorktreePurge,
  kickOrphanedUnitSweep,
  probeGitRepo,
  probeSourceRepoHead,
  resolveRepoRoot,
  syncConfigFromMain,
  type GitRepoProbe,
  type WorktreeInfo,
} from "./worktree";
import {
  claimWorktreePort,
  isValidBranchName,
  resolveSourceBranch,
  type ResolvedSourceBranch,
  withPortClaimLock,
  WORKTREE_PORT_MAX,
  WORKTREE_PORT_MIN,
} from "./worktreeMeta";
import { FileLockTimeoutError } from "@/utils/fileLock";
import { isTmuxPersistenceEnabled } from "./recoveryIntegration";
import {
  harnessSupportsPersistence,
  harnessSupportsSessionRole,
  harnessSupportsOutputStyle,
} from "./harnessGates";
import {
  spawnSessionInTmux,
  buildMessageHooksEnv,
  stopTmuxSession,
  getTmuxSessionPid,
} from "./tmuxSpawnAdapter";
import { readHostDefaultAccountUuid } from "@/utils/claudeCredentials";
import { accountStore } from "@/accounts/accountStore";
import {
  classifyForSelection,
  resolveUnpinnedSpawnAccount,
} from "@/accounts/selectHealthyAccount";
import { generateSessionId } from "@/utils/id";
import { TmuxManager } from "@/tmux";
import { globalEnvNamesOrNull } from "@/tmux/TmuxManager";
import { buildSdkSpawnEnv } from "@/claude/launcherShared";
import {
  API_KEY_AGENT_UNSUPPORTED_MESSAGE,
  computeAuthBinding,
  resolveApiKeyBinding,
  resolveProviderBinding,
  resolveUnboundInstanceToken,
  classifyTableProbe,
  SCHEDULER_MAX_SPAWNS_PER_WINDOW,
  SCHEDULER_RATE_LIMIT_WINDOW_MS,
  schedulerSpawnTimestamps,
  BLOCKED_CWD_PREFIXES,
  waitForAnyChild,
  cloneRepoForSpawn,
} from "./sessionSpawnerHelpers";
import type { ProviderId } from "@hapi/protocol";
import type {
  SpawnSessionOptions,
  SessionTypeDowngrade,
  SpawnSessionResult,
} from "@/modules/common/rpcTypes";
import type { TrackedSession } from "./types";
import type { DaemonContext } from "./daemonContext";
import type { SessionTracker } from "./sessionTracker";
import { getSpawnPaused } from "./spawnPauseState";

/**
 * #2852: bounded wait for the backgrounded worktree `bun install` to settle
 * before a failed-spawn teardown removes the worktree. Long enough for a typical
 * fresh install (~10-30s) to finish so no `bun` process remains for
 * forceRemoveWorktreeAndBranch's kill sweep to SIGTERM (which would trigger
 * defaultBunInstall's plain-install respawn race — F1, HIGH); capped so a stuck
 * install cannot hang teardown. The common late-teardown paths (no-children,
 * webhook-timeout) find the install already settled and return immediately.
 */
const DEPS_TEARDOWN_SETTLE_MS = 30_000;

type GitRepoProbeFailure = Exclude<GitRepoProbe, { state: "repo" }>;

/** Issue #5106 (R6): the cause of a failed git-ness probe, for the daemon log. */
function describeGitRepoProbeFailure(probe: GitRepoProbeFailure): string {
  switch (probe.state) {
    case "not-a-repo":
      return "not a git repository";
    case "git-unavailable":
      return "git is not installed or not on the daemon's PATH";
    case "probe-failed":
      return probe.detail;
  }
}

/**
 * Issue #2270 / #5106 (R6): the refusal for an EXPLICIT worktree spawn whose
 * git-ness probe failed. The not-a-repo text is #2270's, verbatim; the other
 * two name the actual cause instead of claiming the folder is not a repository.
 */
function explicitWorktreeGitProbeMessage(probe: GitRepoProbeFailure): string {
  switch (probe.state) {
    case "not-a-repo":
      return "Selected directory is not a git repository — choose 'Basic' (simple) or a git directory.";
    case "git-unavailable":
      return "Git is not installed or not on the Hapimatic daemon's PATH, so a worktree cannot be created — install Git, or choose 'Basic' (simple) to start the session in this folder.";
    case "probe-failed": {
      const ownedPath = /dubious ownership in repository at '([^']+)'/.exec(
        probe.detail
      )?.[1];
      if (ownedPath) {
        return `Git refuses to read this repository because a different user owns it — as the user that runs Hapimatic, run: git config --global --add safe.directory '${ownedPath}' — or choose 'Basic' (simple) to start the session in this folder.`;
      }
      return `Git reported a problem with the selected directory: ${probe.detail} — fix that, or choose 'Basic' (simple) to start the session in this folder.`;
    }
  }
}

/** True when two paths name the same directory (raw compare if realpath fails). */
async function isSameDirectory(a: string, b: string): Promise<boolean> {
  try {
    return (await fs.realpath(a)) === (await fs.realpath(b));
  } catch {
    return a === b;
  }
}

/**
 * Issue #5086 / #5106 (R3): the refusal for an EXPLICIT worktree spawn whose
 * branch-from HEAD (the main checkout's) has no commits. From the main checkout
 * itself this is #5086's message, verbatim. From a linked worktree the user's
 * own branch may have commits, so the message names the main checkout instead
 * of advising a first commit in the spawn folder, which would not help.
 */
async function noCommitRefusalMessage(
  toplevel: string,
  repoRoot: string
): Promise<string> {
  if (await isSameDirectory(toplevel, repoRoot)) {
    return "The current branch in this Git repository has no commits yet, so there is nothing to branch a worktree from — make a first commit that includes your files (for example: git add . && git commit -m \"Initial commit\"), or choose 'Basic' (simple) to start the session in this folder.";
  }
  return `The main checkout of this Git repository (${repoRoot}) is on a branch with no commits yet, and a new worktree branches from it — switch the main checkout to a branch that has commits, or choose 'Basic' (simple) to start the session in this folder.`;
}

/**
 * hapimatic-private#4370: the branch a new worktree is cut from, with its
 * reason. An explicit `sourceBranch` wins; otherwise the daemon resolves the
 * repo's target branch. The choice is logged at `info` (a fallback at `warn`)
 * because `logger.debug` is file-only and never reaches the daemon journal.
 */
async function resolveWorktreeSourceBranch(
  repoRoot: string,
  explicit: string | undefined
): Promise<ResolvedSourceBranch> {
  const src: ResolvedSourceBranch =
    explicit !== undefined
      ? { branch: explicit, reason: "explicit" }
      : await resolveSourceBranch(repoRoot);
  const line = `[DAEMON RUN] worktree base branch: ${src.branch} (reason: ${src.reason}) for ${repoRoot}`;
  if (src.reason.startsWith("fallback:")) {
    logger.warn(line);
  } else {
    logger.info(line);
  }
  return src;
}

/**
 * Build the session spawner bound to `ctx` (shared maps) and `tracker` (the
 * cap/exit/liveness helpers `spawnSession` calls). Call once during daemon init
 * after the tracker exists; the returned `spawnSession` is wired into the
 * control server, RPC handlers, and `onReady` handles.
 */
export function createSessionSpawner(
  ctx: DaemonContext,
  tracker: SessionTracker
) {
  const { pidToTrackedSession, pidToAwaiter, shellPidToTrackedSession } = ctx;
  const { computeEffectiveCount, onChildExited, isTmuxWindowWrapperAlive } =
    tracker;

  // Spawn a new session (sessionId reserved for future --resume functionality)
  // Issue #5202 (U2): the body below records a silent worktree → simple
  // downgrade in `downgrade`; this wrapper puts it on a success result, so the
  // many success returns inside the body need no per-site change.
  const spawnSession = async (
    requested: SpawnSessionOptions
  ): Promise<SpawnSessionResult> => {
    const downgrade: { value?: SessionTypeDowngrade } = {};
    const result = await spawnSessionBody(requested, downgrade);
    return result.type === "success" && downgrade.value
      ? { ...result, sessionTypeDowngrade: downgrade.value }
      : result;
  };

  const spawnSessionBody = async (
    requested: SpawnSessionOptions,
    downgrade: { value?: SessionTypeDowngrade }
  ): Promise<SpawnSessionResult> => {
    logger.debugLargeJson("[DAEMON RUN] Spawning session", requested);
    // Issue #4349 (R3): a TENANT VM never injects CLAUDE_CODE_OAUTH_TOKEN into a Claude session —
    // not a token named by the spawn request, not the held instance credential (below). The
    // account is selected only by its own CLAUDE_CONFIG_DIR, where the customer signed in.
    const options: SpawnSessionOptions =
      ctx.tenantVm &&
      (requested.agent ?? "claude") === "claude" &&
      requested.token
        ? { ...requested, token: undefined }
        : requested;
    if (options !== requested) {
      logger.warn(
        "[TENANT] ignored an OAuth token named by a Claude spawn request — sign-in happens inside the VM (#4349)"
      );
    }

    const {
      directory: rawDirectory,
      sessionId,
      machineId,
      approvedNewDirectoryCreation = true,
      resumeSessionId,
      hapiSessionId: providedHapiSessionId,
      name,
      forkSession,
      parentSessionId,
      // #2479: threaded for #1262-trap parity; the spawn-parent link is persisted
      // server-side at the syncEngine.spawnSession choke point, not in the daemon.
      parentRelationship,
      originatingNodeId,
      // #3023: renamed from `accountUuid` — the un-pinned veto (below) resolves the
      // EFFECTIVE `accountUuid` from this requested value + the host-default's cached
      // utilization, so every downstream consumer transparently uses the veto result.
      accountUuid: requestedAccountUuid,
      // Issue #4568: the API-key binding (vault id + the mask recorded at the
      // first spawn, carried on a respawn). Resolved against the vault below.
      apiKeyId,
      apiKeyMasked: expectedApiKeyMasked,
      scheduleId,
      claudePath,
      awaitWebhook,
      killLivePane,
      // Issue #3632: the OWNING SERVER's messageHooksEnabled() snapshot, threaded
      // through the spawn RPC. boolean|undefined — `undefined` means the server
      // did not stamp a value, and the marker is OMITTED (never "0") at the env
      // sites below via buildMessageHooksEnv(), so the rp1-home client DEFERS.
      messageHooksEnabled,
      // Issue #3611: the un-pinned optimal-account-selection opt-in, resolved
      // server-side from the `autoSelectOptimalAccount` preference mirror and
      // threaded through the spawn RPC (the #1262 enumeration). undefined/false ⇒
      // NO pick — the #3023 veto behaves exactly as today (R3). The daemon-local
      // `POST /spawn-session` bypass carries no RPC payload, so this is undefined
      // there and that path retains today's #3023 behavior (deliberate scope-out).
      autoSelectOptimalAccount,
    } = options;

    // Generate hapiSessionId early — needed by ALL paths (tmux, worktree, generic)
    const hapiSessionId = providedHapiSessionId ?? generateSessionId();

    // #3808 (epic #3345): the spawn's agent + provider, hoisted ABOVE the un-pinned
    // Anthropic veto so it can be gated per-provider. `spawnProvider` is "openai" for
    // codex, "google" for gemini, "anthropic" otherwise (claude + opencode — opencode
    // binds no per-account provider record, so it stays in the pre-#3808 Anthropic
    // veto path unchanged). A codex/gemini spawn must NEVER route through the Anthropic
    // health veto (NEW-3808-16: it would rebind the spawn to an Anthropic account). [ER 2026-09-19: 3808-4] [ER 2026-09-19: NEW-3808-16]
    const agent = options.agent ?? "claude";
    const spawnProvider: ProviderId =
      agent === "codex"
        ? "openai"
        : agent === "gemini"
          ? "google"
          : "anthropic";

    // Issue #4568 (R3/R4): an API-key spawn bills ONE vault Anthropic key and
    // nothing else — no account, no instance token, no explicit OAuth token, the
    // SDK launcher. Resolved HERE, before the un-pinned veto, the capacity gate and
    // any worktree/tmux work, so a refusal leaves nothing behind. The key itself is
    // never read into this process's output: only its id and mask travel on.
    let apiKeyBinding: { id: string; masked: string; label: string } | null =
      null;
    if (apiKeyId) {
      if (requestedAccountUuid || options.token) {
        logger.warn(
          `[DAEMON RUN] API-key spawn refused: it also names ${requestedAccountUuid ? "an account" : "an OAuth token"} (#4568)`
        );
        return {
          type: "error",
          errorMessage:
            "An API-key session carries exactly one credential — the spawn also named a subscription account or an OAuth token",
          code: "api_key_with_account",
        };
      }
      // Issue #5127: a key homed on another node (`<uuid>@<home>`) is checked
      // with its home through this node's server, before anything else runs.
      // The key itself never reaches this process; only its label, mask and
      // home do. A ref whose home turns out to be THIS node comes back as its
      // bare vault id and takes the vault path below (D16, D17).
      let vaultKeyId: string | null = apiKeyId;
      if (isQualifiedApiKeyRef(apiKeyId)) {
        if (agent !== "claude") {
          return {
            type: "error",
            errorMessage: API_KEY_AGENT_UNSUPPORTED_MESSAGE,
            code: "api_key_agent_unsupported",
          };
        }
        const shared = await resolveSharedApiKey({
          ref: apiKeyId,
          ...(expectedApiKeyMasked !== undefined
            ? { expectedMasked: expectedApiKeyMasked }
            : {}),
          // The home's audit row names the session this spawn will become.
          sessionId: hapiSessionId,
        });
        if (!shared.ok) {
          logger.warn(
            `[DAEMON RUN] API-key spawn refused (${shared.code}): ${shared.message} (#5127)`
          );
          return {
            type: "error",
            errorMessage: shared.message,
            code: shared.code,
          };
        }
        if (isQualifiedApiKeyRef(shared.canonicalRef)) {
          apiKeyBinding = {
            id: shared.canonicalRef,
            masked: shared.maskedKey,
            label: `${shared.label?.trim() || shared.maskedKey} (${shared.homeNodeLabel})`,
          };
          vaultKeyId = null;
          logger.info(
            `[DAEMON RUN] API-key spawn: bills key "${apiKeyBinding.label}" (${shared.maskedKey}) stored on ${shared.homeNodeLabel} — no account, no instance token, SDK launcher (#5127)`
          );
        } else {
          vaultKeyId = shared.canonicalRef;
        }
      }
      if (vaultKeyId !== null) {
        const keySettings = await readSettings();
        const resolution = resolveApiKeyBinding({
          agent,
          apiKeyId: vaultKeyId,
          expectedMasked: expectedApiKeyMasked,
          apiKeys: keySettings.apiKeys,
        });
        if (!resolution.ok) {
          logger.warn(
            `[DAEMON RUN] API-key spawn refused (${resolution.code}): ${resolution.message} (#4568)`
          );
          return {
            type: "error",
            errorMessage: resolution.message,
            code: resolution.code,
          };
        }
        apiKeyBinding = {
          id: vaultKeyId,
          masked: resolution.masked,
          label: resolution.label,
        };
        logger.info(
          `[DAEMON RUN] API-key spawn: bills vault key "${resolution.label}" (${resolution.masked}) — no account, no instance token, SDK launcher (#4568)`
        );
      }
    }

    // Issue #1507 regression-shrink: if the bound account IS the host's native
    // login (the account ~/.claude.json oauthAccount points at), skip env-var
    // binding so Claude Code's own auto-refresh owns the running process — there
    // is no frozen CLAUDE_CODE_OAUTH_TOKEN to expire mid-session. Reuses #1520's
    // host-default resolver so this spawn layer agrees with TokenRefreshService's
    // refresh-deferral layer. Only applies when bound == host-default; explicit
    // switches to a DIFFERENT account stay bound (covered by the #1507 restart
    // path). Computed once here so both injection sites below agree.
    //
    // Issue #1551: for a NON-host bound account, HAPI_ACCOUNT_UUID still travels
    // (set below); the LAUNCHER now resolves it to a per-account
    // CLAUDE_CONFIG_DIR (isolation) rather than a CLAUDE_CODE_OAUTH_TOKEN, so
    // native Claude Code owns refresh in isolation. The host-default skip here
    // is the single-owner guard (R2): the host-default account never gets a
    // second isolated rotator — native owns it via the host dir.
    const hostDefaultAccountUuid = await readHostDefaultAccountUuid().catch(
      () => null
    );

    // #3808 (NEW-3808-16): the EFFECTIVE bound account. The Anthropic un-pinned
    // veto below runs ONLY for an Anthropic spawn (claude / opencode). A codex or
    // gemini spawn skips it entirely — Anthropic utilization never applies to it and
    // it is never rebound to an Anthropic account; it binds the pinned provider account
    // (Task 4/4b add the provider node-default / first-record fallback).
    let accountUuid: string | undefined;
    if (apiKeyBinding) {
      // Issue #4568 (R3/R6): an API-key session binds NO account — it skips the
      // #3023 un-pinned veto and the #3611 optimal pick entirely (treated as
      // pinned-to-nothing). Keys never enter the account pools, so no automatic
      // pick can move a session onto or off a key.
      accountUuid = undefined;
    } else if (spawnProvider !== "anthropic") {
      accountUuid = requestedAccountUuid;
      if (!accountUuid) {
        // #3808 Task 4: un-pinned non-Anthropic spawn — bind the provider's node
        // default (active.json `byProvider`, written by Task 4b) or, absent one, the
        // sole/first provider record from the store. NEVER routed through the
        // Anthropic health veto; never HELD on Anthropic exhaustion. The per-provider
        // usage/pacing SIGNAL is #3809's providerUsage[] (D5 = C) — out of scope here.
        accountUuid =
          (await accountStore
            .getActiveProviderDefault(spawnProvider)
            .catch(() => undefined)) ??
          (await accountStore.list().catch(() => []))
            .filter(e => e.provider === spawnProvider)
            .map(e => e.accountUuid)[0];
      }
      logger.info(
        `[DAEMON RUN] Non-Anthropic (${spawnProvider}) spawn — Anthropic un-pinned veto skipped; accountUuid=${accountUuid ?? "(none)"} (#3808)`
      );
    } else {
      // Issue #3023: un-pinned spawn utilization veto. sessionSpawner is the single
      // universal spawn chokepoint — the apiMachine `spawn-happy-session` RPC path AND
      // the daemon controlServer `/spawn-session` bypass both land here — and
      // `requestedAccountUuid` is definitively empty for an un-pinned spawn. Before an
      // un-pinned spawn binds the (possibly exhausted) host-default account, resolve
      // against the cached utilization: bind a healthy account instead, or — when none is
      // healthy — keep the host-default and log it loudly. The resolver never refuses a
      // spawn (#5460): usage never blocks creating a session. Pinned spawns and
      // respawns/resumes are exempt (a rebind would break `--resume` per-account
      // CLAUDE_CONFIG_DIR isolation).
      // Pure decision core in `selectHealthyAccount.ts`; utilization is sampled per-tick
      // by `tokenRefreshService` (via `utilizationSampler`) into the account-store cache.
      // #3808 (R7): the un-pinned veto is Anthropic-only today — restrict the
      // candidate pool to Anthropic records so a codex/gemini record can never be
      // considered for an Anthropic host-default rebind. (absent provider ⇒ anthropic.)
      // Task 2 additionally gates the whole veto per-provider; Task 4 provider-scopes
      // this pool for non-Anthropic spawns.
      const candidateUuids = (await accountStore.list().catch(() => []))
        .filter(e => (e.provider ?? "anthropic") === "anthropic")
        .map(e => e.accountUuid);
      // Issue #3611 R7: the POSITIVE fresh-spawn whitelist. The optimal-pick fires
      // ONLY for a fresh, un-pinned, locally-originated spawn — every other shape
      // (reconnect/branch/relaunch respawn, successor handoff, federation
      // peer-incoming) carries at least one of these fields and falls through
      // untouched, mirroring #3023's respawn exemption and keeping --resume
      // per-account CLAUDE_CONFIG_DIR isolation intact (#1551). All five fields are
      // already destructured above; the whitelist adds no new wire field.
      const isFreshLocalSpawn =
        !requestedAccountUuid &&
        !resumeSessionId &&
        !originatingNodeId &&
        !parentSessionId &&
        !parentRelationship;
      // Issue #3611 R8 / #5460: build the `unrefreshable` exclusion set ONLY when a
      // branch that consults it can run — the optimal pick (opt-in ON + fresh local
      // spawn) or the unhealthy-host fallback (an un-pinned, non-respawn spawn whose
      // host-default snapshot is exhausted / rate-limited / terminal). A healthy or
      // unknown host-default still does ZERO extra store reads. An unrefreshable
      // account can briefly present a stale `ok` snapshot, so the daemon honors the
      // store flag explicitly rather than relying on its coarse status axis alone.
      const now = Date.now();
      const hostClass =
        hostDefaultAccountUuid && !requestedAccountUuid && !resumeSessionId
          ? classifyForSelection(
              accountStore.getUtilizationSnapshot(hostDefaultAccountUuid),
              now
            )
          : null;
      const hostNeedsFallback =
        hostClass !== null &&
        hostClass !== "healthy" &&
        hostClass !== "unknown";
      let unrefreshableUuids = new Set<string>();
      if (
        (autoSelectOptimalAccount && isFreshLocalSpawn) ||
        hostNeedsFallback
      ) {
        const flags = await Promise.all(
          candidateUuids.map(uuid =>
            accountStore
              .get(uuid)
              .then(r =>
                r?.ok && r.account.unrefreshable === true ? uuid : null
              )
              .catch(() => null)
          )
        );
        unrefreshableUuids = new Set(
          flags.filter((u): u is string => u !== null)
        );
      }
      const unpinnedResolution = resolveUnpinnedSpawnAccount({
        accountUuid: requestedAccountUuid,
        // A respawn/resume is signalled by `resumeSessionId` ALONE — NOT by
        // `providedHapiSessionId`. A FRESH CLI/web spawn pre-generates and passes a
        // `hapiSessionId` too (verified live: a fresh `sessions spawn` carries
        // `providedHapiSessionId` while `resumeSessionId` is absent), so keying the
        // exemption on it would silently exempt every normal spawn and defeat the veto.
        // Only reconnect (`sessionRespawn.ts:440`) and branch (`:642`) carry a
        // `resumeSessionId` (a prior claudeSessionId to resume) — the exact flows a
        // fallback-rebind would break via --resume's per-account CLAUDE_CONFIG_DIR.
        isRespawn: !!resumeSessionId,
        hostDefaultUuid: hostDefaultAccountUuid,
        candidateUuids,
        readSnapshot: uuid => accountStore.getUtilizationSnapshot(uuid),
        now,
        // #3611: the opt-in pick + its R7 whitelist; #3611 R8 / #5460: the unrefreshable
        // predicate, consulted by the optimal pick and the unhealthy-host fallback.
        autoSelectOptimalAccount,
        isFreshLocalSpawn,
        isUnrefreshable: uuid => unrefreshableUuids.has(uuid),
      });
      // R2/AC2: the chosen account + utilization status is ALWAYS observable at spawn
      // (no silent UNCHECKED pass-through) — logged for every un-pinned resolution. A
      // last-resort bind (host-default rate-limited, at its usage cap, or answering the
      // probe with 401/403, and no healthy account) is logged LOUDLY (warn) so it is
      // never silent. The resolver never refuses the spawn (#5460).
      {
        const line = `[DAEMON RUN] Un-pinned spawn account resolution (#3023): decision=${unpinnedResolution.decision} — ${unpinnedResolution.reason}`;
        const lastResort =
          unpinnedResolution.decision === "degraded-last-resort" ||
          unpinnedResolution.decision === "exhausted-last-resort" ||
          unpinnedResolution.decision === "rejected-last-resort";
        if (lastResort) {
          logger.warn(line);
        } else {
          logger.info(line);
        }
      }
      // The EFFECTIVE account: the veto's healthy-fallback UUID when it rebound, else the
      // originally-requested account (or empty for an un-pinned pass-through). Every
      // downstream `accountUuid` consumer (shouldSkipBinding, HAPI_ACCOUNT_UUID injection)
      // reads this resolved value.
      accountUuid = unpinnedResolution.accountUuid ?? requestedAccountUuid;
    } // end Anthropic-only veto (#3808)

    // #3808: load the bound account's full record (provider-aware) so the codex
    // per-account CODEX_HOME binding can be resolved below. `getAny` is Anthropic-safe
    // (byte-identical to get() for an Anthropic record); a null/malformed result yields
    // no provider binding (a claude spawn ignores it entirely).
    const boundAccountRecord =
      accountUuid && spawnProvider !== "anthropic"
        ? await accountStore
            .getAny(accountUuid)
            .then(r => (r && r.ok ? r.account : null))
            .catch(() => null)
        : null;
    const providerBinding = resolveProviderBinding({
      agent,
      record: boundAccountRecord,
    });

    const shouldSkipBinding =
      !!accountUuid && accountUuid === hostDefaultAccountUuid;
    if (shouldSkipBinding) {
      logger.info(
        `[DAEMON RUN] Skipping HAPI_ACCOUNT_UUID binding for ${accountUuid} — matches host-default login; native Claude Code owns refresh (issue #1507)`
      );
    }

    // Issue #3731 (R0b, ruling D3): the node's instance credential, delivered
    // EXPLICITLY ONLY to a strictly-unbound claude spawn — the tmux arm through
    // its 0600 spawn env file, the direct arm through the child's spawn env —
    // never to a bound or host-default spawn, and never over a token passed
    // explicitly with the request (`options.token` wins on both arms; see
    // resolveUnboundInstanceToken). `ctx.instanceOAuthToken` is captured by
    // run.ts's buildDaemonBootRecord BEFORE the control server starts (#4153), so
    // no spawn can precede it. The ambient fallback stays as defense in depth: the
    // ambient copy is only ever deleted after the capture.
    const unboundInstanceToken = resolveUnboundInstanceToken({
      agent,
      accountUuid,
      // #4349: a tenant holds no instance credential (run.ts scrubs it at boot); be explicit.
      heldToken: ctx.tenantVm
        ? undefined
        : (ctx.instanceOAuthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN),
      explicitToken: options.token,
      // Issue #4568: the vault key is an API-key session's only credential.
      apiKeyBound: apiKeyBinding !== null,
    });

    // Issue #3731 (R4): observability — warn when a BOUND claude spawn happens while
    // the onboarding token is still ambient: in the daemon env (a seed-failed or
    // not-yet-released daemon) or in the tmux global table (a server created by an
    // older daemon that KillMode=process preserved across the deploy). The per-pane
    // unset + explicit binding (R1/R3) are the mechanical guarantee; this only makes
    // the condition visible. The daemon cannot tell config-dir isolation from
    // env-token binding (the wrapper decides), and #3351's HAPI_AUTH_BINDING claude
    // arm is always `subscription-account`, so the warning names the account only.
    // Var NAME + account uuid — never the value. The daemon-env check is free and
    // runs for both arms; the tmux-table read runs on the tmux arm only (below),
    // before its createWindow scrubs the table.
    const warnAmbientTokenOnBoundSpawn = (sources: string[]): void => {
      if (sources.length === 0) return;
      logger.warn(
        `[DAEMON RUN] Ambient CLAUDE_CODE_OAUTH_TOKEN present (${sources.join(" + ")}) on a bound spawn for account ${accountUuid} — the per-pane unset and the explicit binding win (#3731)`
      );
    };
    const isBoundClaudeSpawn =
      agent === "claude" && Boolean(accountUuid) && !shouldSkipBinding;
    const ambientTokenSources: string[] =
      isBoundClaudeSpawn && process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? ["daemon env"]
        : [];

    // Issue #1774 (Sub E, Task 10 / R9): spawn-quiesce. The self-update flow
    // pauses spawning during the harness symlink flip so a fresh `claude` cannot
    // fork mid-swap (the narrow spawn race — KD-2). Checked BEFORE the capacity
    // compute so a paused daemon rejects immediately. Inert by default (the flag
    // starts false — behavior is byte-identical to pre-#1774 unless an update
    // actively pauses).
    if (getSpawnPaused()) {
      logger.warn(
        "[DAEMON RUN] Session spawn rejected: spawning is paused (harness self-update in progress)"
      );
      return {
        type: "error",
        errorMessage:
          "Session spawning is temporarily paused while a harness self-update is in progress. Retry shortly.",
        code: "spawn_paused",
      };
    }

    // Guard: reject if at max concurrent session capacity.
    // Uses both in-memory map AND tmux window count as a cross-check.
    // The tmux window count is ground truth — it survives daemon restarts
    // even if the in-memory map fails to repopulate. (Issue #603)
    // Only counts windows with active child processes — disconnected sessions
    // (bare shell, no Claude child) are excluded. (Issue #633)
    // Computed via the shared computeEffectiveCount() closure (issue #1477) so
    // the spawn gate and the /effective-count control endpoint cannot diverge.
    // #1805 R8: `max` comes from the SAME computeEffectiveCount() call that
    // produced effectiveCount — both via the live resolveMaxConcurrent(). The
    // gate must compare against this `max`, never re-read a constant, so the
    // meter and the gate can never disagree (#1477 single-closure principle).
    // Issue #2299 (Task 2 — own-slot credit): thread the incoming
    // providedHapiSessionId as the credit id. computeEffectiveCount only credits
    // when that id CURRENTLY occupies a counted slot (a reused-window respawn such
    // as switchAccount's kill+respawn), so a brand-new spawn — whose
    // providedHapiSessionId is undefined, or a freshly-generated id that matches no
    // counted slot — is byte-identical to before and the hard cap stays intact
    // (KD-2). This is what lets a session's OWN respawn be admitted at 10/10
    // despite the teardown race that still counts its dying PID/tmux window.
    const {
      effectiveCount,
      trackedPids: activeSessionCount,
      activeTmuxWindows: tmuxWindowCount,
      max: maxConcurrent,
    } = await computeEffectiveCount(providedHapiSessionId);
    if (effectiveCount >= maxConcurrent) {
      logger.warn(
        `[DAEMON RUN] Session spawn rejected: ${effectiveCount} active sessions ` +
          `(map: ${activeSessionCount}, tmux-active: ${tmuxWindowCount}, max: ${maxConcurrent})`
      );
      return {
        type: "error",
        errorMessage: `Too many concurrent sessions (${effectiveCount}/${maxConcurrent}). Stop existing sessions before starting new ones.`,
        // Issue #1772: a distinct classifier so callers (the impact-analysis
        // orchestrator, the create route → HTTP 409) can detect "at capacity"
        // authoritatively instead of string-matching this message. Mirrors the
        // account_unrefreshable code slot already carried by the spawn path.
        code: "at_capacity",
      };
    }

    // Guard: per-scheduler rate limit (defense-in-depth for runaway schedulers).
    // Only applies to scheduler-initiated spawns. Manual/CLI/peer spawns skip this
    // and rely on the concurrency cap alone. (Issue #603)
    if (scheduleId) {
      const now = Date.now();
      const windowStart = now - SCHEDULER_RATE_LIMIT_WINDOW_MS;
      let timestamps = schedulerSpawnTimestamps.get(scheduleId);
      if (!timestamps) {
        timestamps = [];
        schedulerSpawnTimestamps.set(scheduleId, timestamps);
      }
      while (timestamps.length > 0 && timestamps[0] < windowStart) {
        timestamps.shift();
      }
      if (timestamps.length >= SCHEDULER_MAX_SPAWNS_PER_WINDOW) {
        const windowMinutes = Math.round(
          SCHEDULER_RATE_LIMIT_WINDOW_MS / 60_000
        );
        logger.warn(
          `[DAEMON RUN] Scheduler ${scheduleId} rate-limited: ${timestamps.length} spawns in last ${windowMinutes}min (max: ${SCHEDULER_MAX_SPAWNS_PER_WINDOW})`
        );
        return {
          type: "error",
          errorMessage: `Scheduler rate limit exceeded for schedule ${scheduleId} (${timestamps.length}/${SCHEDULER_MAX_SPAWNS_PER_WINDOW} per ${windowMinutes}min). This scheduler may be malfunctioning.`,
        };
      }
      timestamps.push(now);
    }

    // Expand tilde to home directory (e.g., ~/projects → /home/user/projects)
    const directory = rawDirectory.startsWith("~/")
      ? rawDirectory.replace(/^~\//, `${os.homedir()}/`)
      : rawDirectory === "~"
        ? os.homedir()
        : rawDirectory;

    // Guard: reject blocked working directories (e.g., /tmp, /test)
    for (const prefix of BLOCKED_CWD_PREFIXES) {
      if (directory === prefix || directory.startsWith(`${prefix}/`)) {
        logger.warn(
          `[DAEMON RUN] Session spawn rejected: blocked CWD '${directory}' (matches ${prefix})`
        );
        return {
          type: "error",
          errorMessage: `Cannot start a session in '${directory}'. This path is blocked for safety. Use a project directory instead.`,
        };
      }
    }

    // Guard: reject non-absolute paths
    if (!directory.startsWith("/")) {
      logger.warn(
        `[DAEMON RUN] Session spawn rejected: non-absolute path '${directory}'`
      );
      return {
        type: "error",
        errorMessage: `Session directory must be an absolute path. Got: '${directory}'`,
      };
    }

    // (`agent` + `spawnProvider` hoisted above the un-pinned veto — #3808.)
    const yolo = options.yolo !== false;
    // Issue #1633: Safe Mode spawn flag (default OFF — unlike yolo there is
    // no !== false inversion) + optional explicit model mode (set by the
    // server's model-switch respawn). Invalid/default model values degrade
    // to undefined — the session then follows normal default-mode
    // resolution (#1506 entitled pin).
    const safeMode = options.safeMode === true;
    // Issue #2155: role-scoped `@`-include profile — threaded to the launcher
    // as --hapi-session-role (runClaude merges the profile's claudeMdExcludes)
    // and injected as HAPI_SESSION_ROLE for in-session telemetry.
    const sessionRole = options.sessionRole;
    // Issue #2626 (D): per-session output style → threaded to the claude child
    // as --hapi-output-style; runClaude injects it into the generated --settings
    // file. Free-form (built-in or custom name); no enum validation — an unknown
    // style is silently no-op'd by Claude Code (Task 1 spike, fail-open).
    const outputStyle = options.outputStyle;
    // Issue #1660: per-session launcher override → injected as
    // HAPI_CLAUDE_LAUNCHER on the spawned process env (both spawn paths below,
    // the same channel as HAPI_ACCOUNT_UUID) so the resolver's env tier wins
    // per-session — no resolver change. Undefined → no injection → the
    // settings.json launcher / sdk default applies (byte-identical to before).
    // Issue #4568 (D-4568-2 A): an API-key session runs on the SDK launcher ALWAYS
    // — injected explicitly so a node whose settings.json default is pty/tmux
    // cannot route a key session onto a launcher that was never verified for API
    // billing (and refuses one). The route already 400s a non-SDK request; this
    // covers every other caller.
    if (apiKeyBinding && options.launcher && options.launcher !== "sdk") {
      logger.warn(
        `[DAEMON RUN] API-key spawn requested launcher "${options.launcher}" — forcing "sdk" (#4568)`
      );
    }
    const launcher = apiKeyBinding ? "sdk" : options.launcher;
    const VALID_SPAWN_MODEL_MODES = ["sonnet", "opus", "fable", "haiku"];
    const spawnModelMode =
      typeof options.modelMode === "string" &&
      VALID_SPAWN_MODEL_MODES.includes(options.modelMode)
        ? options.modelMode
        : undefined;
    // Issue #2456: reasoning-effort level, validated against the effort catalog
    // (inlined to mirror VALID_SPAWN_MODEL_MODES above). An out-of-catalog value
    // is dropped → no --hapi-effort → binary default (byte-identical spawn).
    const VALID_SPAWN_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
    const spawnEffort =
      typeof options.effort === "string" &&
      VALID_SPAWN_EFFORT_LEVELS.includes(options.effort)
        ? options.effort
        : undefined;
    // Issue #2456: a specific pinned raw Claude model id ("More models"). Free-
    // form — accept any non-empty string (the binary warns-and-defaults on an
    // unknown model, exactly like effort).
    const spawnRawModel =
      typeof options.rawModel === "string" && options.rawModel.trim().length > 0
        ? options.rawModel.trim()
        : undefined;
    // Issue #3348: bundled non-claude native model selection. Interpreted per
    // AGENT below: gemini → GEMINI_MODEL env (direct path); codex ChatGPT-token →
    // config.toml `model`/`model_reasoning_effort` bake (BOTH spawn paths). Free-
    // form trimmed strings (the web UI is the axis-constrained source; codex/gemini
    // reject an invalid value at spawn). Empty → undefined → no env / no bake, so a
    // model-less spawn stays byte-identical to today.
    const nativeModelId =
      typeof options.nativeModelSelection?.modelId === "string" &&
      options.nativeModelSelection.modelId.trim().length > 0
        ? options.nativeModelSelection.modelId.trim()
        : undefined;
    const nativeReasoningEffort =
      typeof options.nativeModelSelection?.reasoningEffort === "string" &&
      options.nativeModelSelection.reasoningEffort.trim().length > 0
        ? options.nativeModelSelection.reasoningEffort.trim()
        : undefined;

    // Issue #1953 (A6): clone-on-spawn. When a repo is requested, clone it
    // into the working directory BEFORE the sessionType / git-repo probe
    // below. Runs server/daemon-side with the host `gh` CLI credentials — no
    // GitHub token crosses to the web client or the spawned agent's env (R11).
    // hapimatic-private#4481: reject BEFORE the clone side effect — a fresh clone
    // has only its default branch, so an existing-branch pick cannot apply.
    if (options.cloneRepo && options.existingBranch) {
      return {
        type: "error",
        errorMessage:
          "An existing branch can't be combined with clone-on-spawn.",
      };
    }
    if (options.cloneRepo) {
      const cloneResult = await cloneRepoForSpawn(options.cloneRepo, directory);
      if (!cloneResult.ok) {
        return { type: "error", errorMessage: cloneResult.errorMessage };
      }
    }
    // Default to "worktree" so daemon-driven spawns produce isolated branches
    // and `.worktree-meta.json` automatically. Closes #1095.
    // Defensive: when the caller did NOT pass an explicit sessionType AND
    // `directory` is not a Git repo (e.g. `hapi api sessions spawn --dir
    // /home/matt/scratch/foo`), downgrade silently to "simple" so we don't
    // crash on `resolveRepoRoot`. Explicit `sessionType: "simple"` callers
    // are unaffected.
    let sessionType = options.sessionType ?? "worktree";
    // Issue #1953 (A6, KEY DECISION #3): a cloned repo is a complete checkout
    // — ALWAYS run a SIMPLE session in it rather than a worktree. A freshly-
    // cloned repo IS a git repo, so the probe below would NOT downgrade it;
    // and the web sends `sessionType: "worktree"` by default (its Git-Type
    // default), so this MUST force simple unconditionally for a clone — a
    // `!== "worktree"` guard would never fire for the common case and the
    // daemon would create a worktree off the brand-new clone. The web also
    // sets Git Type → Simple on repo-select so the preview/payload agree; this
    // is the authoritative defense-in-depth guard regardless of what the
    // client sends.
    if (options.cloneRepo) {
      sessionType = "simple";
    }
    // hapimatic-private#4481: an existing-branch spawn always opens a worktree —
    // Basic never switches a shared directory's branch in place (ruling D5b).
    if (options.existingBranch) {
      if (options.sessionType === "simple") {
        return {
          type: "error",
          errorMessage:
            "An existing branch opens in a worktree — choose Worktree, or pick the current branch for Basic.",
        };
      }
      sessionType = "worktree";
    }
    // Issue #2270 (F23): git-ness gate for worktree spawns. Probe ONCE, then
    // branch on whether the caller chose worktree EXPLICITLY:
    //   - non-explicit (CLI convenience, e.g. `hapi api sessions spawn --dir X`
    //     with no --session-type): silently downgrade to 'simple' (preserved,
    //     OR-2) so a scratch dir just runs a simple session.
    //   - EXPLICIT worktree (the web's Git-Type default): reject EARLY with a
    //     clear, actionable message BEFORE any worktree side effects (purge /
    //     branch-detect / createWorktree) — replacing the late, git-raw-message
    //     error the doomed path used to surface. The web's F25 gating steers most
    //     users to 'simple' first; this is the backstop for an explicit override
    //     or any non-web caller. `errorMessage` → `message` via rpcGateway, so
    //     the sync (web) path renders it in-band (machines.ts) exactly like today.
    // Issue #5106 (R5/R6): both gate probes live in worktree.ts — async, with
    // the #1435 GIT_* scrub and the HAPI_GIT_TIMEOUT_MS bound, so they see the
    // same environment as createWorktree — and the git-ness probe names its
    // failure (not a repo / git missing / git refused the folder) instead of
    // reading every failure as "not a git repository".
    if (sessionType === "worktree") {
      const repoProbe = await probeGitRepo(directory);
      if (repoProbe.state !== "repo") {
        // #4481: an existing-branch spawn is an explicit worktree request.
        if (!options.sessionType && !options.existingBranch) {
          if (repoProbe.state === "not-a-repo") {
            logger.debug(
              `[DAEMON RUN] sessionType defaulted to 'worktree' but '${directory}' is not a Git repo — downgrading to 'simple'`
            );
          } else {
            const reason = describeGitRepoProbeFailure(repoProbe);
            logger.warn(
              `[DAEMON RUN] Issue #5106: sessionType defaulted to 'worktree' but git could not read '${directory}' (${reason}) — downgrading to 'simple'`
            );
            // Issue #5202 (U2): a probe failure is not the designed scratch-dir
            // path — it can run the session in the main checkout. Report it and
            // carry the reason on the spawn result.
            logger.reportCaught(new Error(reason), {
              category: "daemon-worktree-probe-downgrade",
              severity: "warn",
              context: JSON.stringify({ directory, probe: repoProbe.state }),
            });
            downgrade.value = { from: "worktree", to: "simple", reason };
          }
          sessionType = "simple";
        } else {
          logger.debug(
            `[DAEMON RUN] Explicit worktree spawn rejected: '${directory}' (${describeGitRepoProbeFailure(repoProbe)})`
          );
          return {
            type: "error",
            errorMessage: explicitWorktreeGitProbeMessage(repoProbe),
          };
        }
      } else if (!options.existingBranch) {
        // Issue #5086: a `git init` folder with no commits passes the
        // --show-toplevel probe above, so it used to fail late in createWorktree
        // ("Source repo HEAD not resolvable", worktree.ts) AFTER creating
        // `.worktrees/` and appending to `.git/info/exclude` in the user's fresh
        // project. Same split as the non-git branch: a defaulted type runs as a
        // simple session; an explicit worktree gets a plain-words fix before any
        // side effect. An existing-branch spawn needs no HEAD (it opens the named
        // branch), so it is exempt and keeps its path.
        // Issue #5106 (R1/R4): the probe reads the base createWorktree branches
        // from (#4370: the source branch, else the main checkout's HEAD, via
        // resolveRepoRoot), not the spawn folder's
        // own HEAD, so an orphan linked worktree is no longer refused. Only an
        // unborn HEAD refuses or downgrades; a probe that cannot tell warns and
        // continues to createWorktree, whose own HEAD check is the backstop.
        const head = await probeSourceRepoHead(directory, options.sourceBranch);
        if (head.state === "unborn") {
          if (!options.sessionType) {
            logger.debug(
              `[DAEMON RUN] sessionType defaulted to 'worktree' but the branch-from HEAD at '${head.repoRoot}' has no commits yet — downgrading to 'simple'`
            );
            // Issue #5202 (U2): carry the reason on the spawn result.
            downgrade.value = {
              from: "worktree",
              to: "simple",
              reason: `the branch-from HEAD at '${head.repoRoot}' has no commits yet`,
            };
            sessionType = "simple";
          } else {
            logger.debug(
              `[DAEMON RUN] Explicit worktree spawn rejected: the branch-from HEAD at '${head.repoRoot}' has no commits yet`
            );
            return {
              type: "error",
              errorMessage: await noCommitRefusalMessage(
                repoProbe.toplevel,
                head.repoRoot
              ),
            };
          }
        } else if (head.state === "unknown") {
          logger.warn(
            `[DAEMON RUN] Issue #5106: could not tell whether '${directory}' has a commit to branch from (${head.detail}) — continuing to createWorktree, which reports its own error if HEAD does not resolve`
          );
        }
      }
      // Runs only when the arms above neither refused nor downgraded: its other
      // guards read `options`, so without the `sessionType` term it would also
      // fire after a #5086 downgrade (#5106 R7).
      if (
        sessionType === "worktree" &&
        !options.sessionType &&
        !options.worktreeName &&
        !options.existingBranch
      ) {
        // Issue #3372: `--dir <existing linked worktree>` with a DEFAULTED
        // sessionType (no explicit sessionType, no worktreeName) must RUN IN
        // that worktree, not cut a fresh `ms-hapi-*` sibling off it — otherwise
        // a re-drive (tester/closer) lands without the target's implementation.
        // Same shape as the #2270 non-git downgrade above and the #1248
        // reconnect rule (sessionRespawn.ts): keep `worktreeInfo` null so nothing
        // in the worktree block can create, sync, or tear down the adopted tree.
        // B-D5 "explicit wins": an explicit sessionType/worktreeName keeps the
        // fresh-create path (this arm is skipped). B-D6: WARN on an owned meta
        // and proceed (#1619 — the meta is the owner-of-record), never refuse.
        // NOTE: read `options.worktreeName`, not `worktreeName` — the latter is
        // const-bound BELOW this gate (TDZ).
        const adoptable = await isExistingLinkedWorktree(directory);
        if (adoptable) {
          if (adoptable.ownerSessionId) {
            logger.warn(
              `[DAEMON RUN] Adopting worktree '${directory}' (branch ${adoptable.branch}); its .worktree-meta.json names session_id=${adoptable.ownerSessionId} — proceeding without an ownership refusal (#1619 meta is owner-of-record)`
            );
          }
          logger.debug(
            `[DAEMON RUN] '${directory}' is an existing linked worktree — downgrading defaulted 'worktree' to 'simple' (#3372)`
          );
          sessionType = "simple";
        }
      }
    }
    const worktreeName = options.worktreeName;
    let directoryCreated = false;
    let spawnDirectory = directory;
    let worktreeInfo: WorktreeInfo | null = null;
    let happyProcess: ReturnType<typeof spawnHappyCLI> | null = null;

    if (sessionType === "simple") {
      // Guard: reject reconnect/branch if CWD no longer exists on disk.
      // New sessions may create directories, but reconnects should not —
      // a missing CWD means the worktree was deleted. (#956)
      if (resumeSessionId) {
        try {
          await fs.access(directory);
        } catch (cwdErr) {
          logger.warn(
            `[DAEMON RUN] Session spawn rejected: CWD no longer exists '${directory}' (likely deleted worktree)`
          );
          logger.reportCaught(cwdErr, {
            category: "daemon-cwd-missing",
            severity: "warn",
            context: JSON.stringify({ directory, resumeSessionId }),
          });
          return {
            type: "error",
            errorMessage: `Session working directory no longer exists: ${directory}. The worktree may have been deleted.`,
          };
        }
      }

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
        // expected: directory missing is the trigger condition for the
        // create-flow below, not an error worth reporting.
        logger.debug(
          `[DAEMON RUN] Directory doesn't exist, creating: ${directory}`
        );

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug(
            `[DAEMON RUN] Directory creation not approved for: ${directory}`
          );
          return {
            type: "requestToApproveDirectoryCreation",
            directory,
          };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug(
            `[DAEMON RUN] Successfully created directory: ${directory}`
          );
          directoryCreated = true;
        } catch (mkdirError) {
          const errCode = (mkdirError as NodeJS.ErrnoException).code;
          let errorMessage = `Unable to create directory at '${directory}'. `;

          // Provide more helpful error messages based on the error code
          if (errCode === "EACCES") {
            errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
          } else if (errCode === "ENOTDIR") {
            errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
          } else if (errCode === "ENOSPC") {
            errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
          } else if (errCode === "EROFS") {
            errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
          } else {
            errorMessage += `System error: ${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)}. Please verify the path is valid and you have the necessary permissions.`;
          }

          logger.debug(
            `[DAEMON RUN] Directory creation failed: ${errorMessage}`
          );
          return {
            type: "error",
            errorMessage,
          };
        }
      }
    } else {
      try {
        await fs.access(directory);
        logger.debug(
          `[DAEMON RUN] Worktree base directory exists: ${directory}`
        );
      } catch (error) {
        logger.debug(
          `[DAEMON RUN] Worktree base directory missing: ${directory}`
        );
        logger.reportCaught(error, {
          category: "daemon-worktree-base-missing",
          severity: "warn",
          context: JSON.stringify({ directory }),
        });
        return {
          type: "error",
          errorMessage: `Worktree sessions require an existing Git repository. Directory not found: ${directory}`,
        };
      }
    }

    // #2852 (Task 2 / F1): the worktree `bun install` now runs in the
    // background — started after createWorktree, awaited by NOTHING on the spawn
    // path so the RPC returns while it overlaps the tmux spawn + Claude Code
    // boot. Declared at function scope so every failed-spawn teardown path can
    // SETTLE it before forceRemoveWorktreeAndBranch, and so its background
    // continuation can stand down (skip logging) once the worktree is torn down.
    // `worktreeTornDown` is the "aborted flag" the continuation consults (F1).
    let depsPromise: ReturnType<typeof ensureWorktreeNodeModules> | null = null;
    let worktreeTornDown = false;
    // #2852 F1 (HIGH): before any teardown removes the worktree, signal the
    // install continuation to stand down and let the in-flight `bun install`
    // settle (bounded). Otherwise forceRemoveWorktreeAndBranch's kill sweep
    // SIGTERMs the frozen-lockfile bun, defaultBunInstall's catch respawns a
    // plain `bun install` in the same cwd INSIDE the 500ms SIGKILL grace window
    // (worktree.ts) — a new cwd-holder invisible to the one-shot /proc snapshot,
    // which can strand the worktree+branch or fire a spurious severity-"error"
    // report for a deliberately torn-down worktree. depsPromise never rejects
    // (ensureWorktreeNodeModules returns a structured result); .catch() guards
    // defense-in-depth. A null depsPromise (simple session, or teardown before
    // the install started) makes this an immediate no-op.
    const settleDepsBeforeTeardown = async (): Promise<void> => {
      worktreeTornDown = true;
      if (!depsPromise) return;
      await Promise.race([
        depsPromise.catch(() => undefined),
        new Promise<void>(resolve =>
          setTimeout(resolve, DEPS_TEARDOWN_SETTLE_MS)
        ),
      ]);
    };

    // Issue #1202: Cleanup helper for any failed-spawn path with a partial
    // worktree. The non-tmux path uses `maybeCleanupWorktree` (defined
    // later), but that helper:
    //   1) Calls `cleanupWorktreeAndBranch`, which soft-deletes to
    //      `.worktrees/.trash/` and PRESERVES the branch — defeating
    //      retry-after-cleanup (createWorktree skips names whose branch
    //      already exists, so the orphan branch forces a `-XXXX` suffix).
    //   2) Skips when `happyProcess` is alive — wrong for the tmux path
    //      because `happyProcess` is null (tmux spawns its own shell).
    //
    // This helper uses `forceRemoveWorktreeAndBranch` (hard-remove +
    // force-delete branch) so the unsuffixed worktree path is truly free
    // for retry. It also stops the tmux session if one was started — the
    // post-tmux failure cases (no shell PID, no children, webhook timeout)
    // leave a tmux pane that may have Claude running. Without stopping it
    // we'd orphan Claude on a deleted worktree.
    const cleanupTmuxSpawnFailure = async (
      reason: string,
      tmuxSessionId: string | null
    ): Promise<void> => {
      logger.debug(`[DAEMON RUN] Cleaning up partial worktree after ${reason}`);
      // #2852 F1: settle/abort the backgrounded install BEFORE removing the
      // worktree so the kill sweep can't race defaultBunInstall's respawn.
      await settleDepsBeforeTeardown();
      if (worktreeInfo) {
        try {
          await forceRemoveWorktreeAndBranch({
            basePath: worktreeInfo.basePath,
            worktreePath: worktreeInfo.worktreePath,
            branch: worktreeInfo.branch,
            sessionId: hapiSessionId,
          });
        } catch (err) {
          logger.warn(
            `[DAEMON RUN] forceRemoveWorktreeAndBranch failed (${reason}): ${err}`
          );
        }
      }
      if (tmuxSessionId) {
        try {
          await stopTmuxSession(tmuxSessionId);
        } catch (err) {
          logger.warn(
            `[DAEMON RUN] stopTmuxSession failed (${reason}): ${err}`
          );
        }
      }
    };

    // === WORKTREE CREATION ===
    // Worktree must be created BEFORE the tmux spawn so the directory exists
    // when tmux tries to cd into it
    if (sessionType === "worktree") {
      // hapimatic-private#4370: an explicit base branch must be a valid branch
      // name (the server schema checks first; this is the daemon-side check).
      if (
        options.sourceBranch !== undefined &&
        !(await isValidBranchName(options.sourceBranch))
      ) {
        return {
          type: "error",
          errorMessage: `Invalid source branch name: '${options.sourceBranch}'`,
        };
      }
      // #2450 (R4): the expired-worktree purge is now kicked via the
      // single-flight `kickExpiredWorktreePurge()` wrapper (worktree.ts) AFTER
      // createWorktree below — the wrapper resolves the repo root internally, so
      // even that cheap resolve is off the spawn critical path (R1). #2852 first
      // moved this purge off the critical path (a bare per-spawn fire-and-forget);
      // #2450 adds per-repo-root single-flight coalescing so concurrent spawns
      // never overlap purges against the shared .git/ (AC #3). The wrapper
      // swallows a RepoRootResolutionError itself (its outer .catch), so the
      // resolve no longer needs the eager pre-create try/catch that absorbed it.

      try {
        // Claim a worktree port BEFORE creating the worktree so meta is
        // written atomically with claimed_port set. Issue #1145.
        //
        // Issue #1262: the port claim is now gated on the caller's
        // `claimPort` opt-in. Default-false: the worktree is created with
        // `claimed_port: null` and the port is claimed later (typically
        // at deploy-time via `scripts/hapi-worktree.sh claim`). The
        // claimed_port-null meta-write path is already supported (see
        // `createWorktree` in `cli/src/daemon/worktree.ts:381`).
        //
        // claimWorktreePort and resolveSourceBranch both scan/read at the
        // *repo root*, so resolve `directory` (which may be a subdir of the
        // repo) to the actual root first. Without this, a spawn from a
        // subdir would scan a non-existent `.worktrees/` and miss sibling
        // claims (port collision risk — code-reviewer M1 on #1145).
        let claimedPort: number | null = null;
        // #4370: seeded from the caller's branch so an explicit sourceBranch
        // survives a resolveRepoRoot failure below. Operator ruling 4370-D1 = C:
        // fail the create on a missing base only when the caller named it.
        let resolvedSourceBranch = options.sourceBranch ?? "ms-dev";
        let failIfBaseMissing = options.sourceBranch !== undefined;
        let resolvedRepoRoot: string | null = null;
        // `worktreeResult` is assigned on every branch below (or the branch
        // early-returns). Hoisted here (was a `const` after the if/else
        // pre-#1730) so the claimPort:true path can build it INSIDE the
        // port-claim lock — see the #1730 note in that branch.
        let worktreeResult: Awaited<ReturnType<typeof createWorktree>>;
        if (options.claimPort === true) {
          // Issue #1730: serialize the port claim AND its later meta-write
          // (the write happens inside createWorktree -> writeWorktreeMeta)
          // under ONE cross-process lock. claimWorktreePort() only returns a
          // port; the claim is persisted later, so without a lock spanning
          // claim->write two concurrent claimPort:true spawns both read the
          // pre-write claimed set, both pick the lowest free port, and both
          // write it (TOCTOU). TS sibling of the bash flock added in #1619 R5.
          try {
            resolvedRepoRoot = await resolveRepoRoot(directory);
          } catch (repoRootError) {
            // resolveRepoRoot failed — non-fatal; fall through to the unlocked
            // null-port create below (preserves pre-#1730 behavior).
            logger.warn(
              `[DAEMON RUN] Pre-creation resolveRepoRoot threw (non-fatal): ${repoRootError}`
            );
            logger.reportCaught(repoRootError, {
              category: "daemon-worktree-port-claim",
              severity: "warn",
            });
          }

          if (resolvedRepoRoot !== null) {
            // `const` so the narrowed non-null type survives into the closure
            // (a `let` widens back to `string | null` inside a callback).
            const lockRepoRoot = resolvedRepoRoot;
            try {
              const outcome = await withPortClaimLock<
                | { kind: "all-claimed" }
                | {
                    kind: "created";
                    result: Awaited<ReturnType<typeof createWorktree>>;
                  }
              >(async () => {
                const port = await claimWorktreePort(lockRepoRoot);
                if (port === null) {
                  return { kind: "all-claimed" };
                }
                claimedPort = port;
                const src = await resolveWorktreeSourceBranch(
                  lockRepoRoot,
                  options.sourceBranch
                );
                resolvedSourceBranch = src.branch;
                failIfBaseMissing = src.reason === "explicit";
                const result = await createWorktree({
                  basePath: directory,
                  nameHint: worktreeName,
                  existingBranch: options.existingBranch,
                  hapiSessionId,
                  claimedPort: port,
                  sourceBranch: resolvedSourceBranch,
                  failIfBaseMissing,
                });
                return { kind: "created", result };
              });

              if (outcome.kind === "all-claimed") {
                logger.warn(
                  `[DAEMON RUN] All worktree ports (${WORKTREE_PORT_MIN}-${WORKTREE_PORT_MAX}) are claimed`
                );
                // #2450 (R2): still kick the purge on the port-exhausted early
                // return. #2852 moved the purge to success-only, but trash
                // pressure is HIGHEST on a port-exhausted instance, so a failed
                // spawn must still reclaim expired trash — this restores the
                // pre-#2852 "purge on every spawn attempt" coverage.
                // Single-flight-guarded + `void` (fire-and-forget).
                void kickExpiredWorktreePurge(directory);
                // #3210: also kick the orphan-unit sweep on the port-exhausted
                // early return — port exhaustion is precisely when orphaned
                // hapimatic-wt-* units (holding a port whose worktree is gone)
                // are the likeliest cause, and no worktree of THIS spawn exists
                // to protect. Single-flight-guarded + `void`; observe-first, so
                // it only logs candidates until HAPI_WT_ORPHAN_SWEEP=reap.
                void kickOrphanedUnitSweep(directory);
                return {
                  type: "error",
                  errorMessage: `All worktree ports (${WORKTREE_PORT_MIN}-${WORKTREE_PORT_MAX}) are in use. Stop an existing worktree instance with: scripts/hapi-worktree.sh stop`,
                };
              }
              worktreeResult = outcome.result;
            } catch (lockOrClaimError) {
              if (lockOrClaimError instanceof FileLockTimeoutError) {
                // R3 (#1730): lock contention is NOT a transient I/O error.
                // Surface it — do NOT fall through to a null-port spawn, which
                // would silently re-risk the very collision this lock closes.
                logger.warn(
                  `[DAEMON RUN] Port-claim lock timeout: ${lockOrClaimError}`
                );
                return {
                  type: "error",
                  errorMessage:
                    "Another worktree spawn currently holds the port-claim lock. Please retry shortly.",
                };
              }
              // Any other claim/create error stays non-fatal: create with a
              // null port so the issue-worker auto-bootstrap (#1025) recovers
              // (preserves pre-#1730 behavior).
              logger.warn(
                `[DAEMON RUN] Locked port claim/create threw (non-fatal): ${lockOrClaimError}`
              );
              logger.reportCaught(lockOrClaimError, {
                category: "daemon-worktree-port-claim",
                severity: "warn",
              });
              // Reset the claim so the meta-write + log reflect the actual
              // null-port create (the closure may have set claimedPort before
              // createWorktree threw).
              claimedPort = null;
              worktreeResult = await createWorktree({
                basePath: directory,
                nameHint: worktreeName,
                existingBranch: options.existingBranch,
                hapiSessionId,
                claimedPort: null,
                sourceBranch: resolvedSourceBranch,
                failIfBaseMissing,
              });
            }
          } else {
            // resolveRepoRoot failed above — unlocked null-port create.
            worktreeResult = await createWorktree({
              basePath: directory,
              nameHint: worktreeName,
              existingBranch: options.existingBranch,
              hapiSessionId,
              claimedPort: null,
              sourceBranch: resolvedSourceBranch,
              failIfBaseMissing,
            });
          }
        } else {
          // claimPort default-false (#1262): skip the port claim but still
          // resolve source branch so createWorktree gets the right base.
          // UNCHANGED from pre-#1730 except the createWorktree result is now
          // assigned to the hoisted `worktreeResult`.
          try {
            resolvedRepoRoot = await resolveRepoRoot(directory);
            const src = await resolveWorktreeSourceBranch(
              resolvedRepoRoot,
              options.sourceBranch
            );
            resolvedSourceBranch = src.branch;
            failIfBaseMissing = src.reason === "explicit";
          } catch (sourceBranchError) {
            logger.warn(
              `[DAEMON RUN] Pre-creation source-branch detect threw (non-fatal, claimPort=false): ${sourceBranchError}`
            );
            logger.reportCaught(sourceBranchError, {
              category: "daemon-worktree-source-branch",
              severity: "warn",
            });
          }
          worktreeResult = await createWorktree({
            basePath: directory,
            nameHint: worktreeName,
            existingBranch: options.existingBranch,
            hapiSessionId,
            claimedPort,
            sourceBranch: resolvedSourceBranch,
            failIfBaseMissing,
          });
        }

        if (!worktreeResult.ok) {
          logger.debug(
            `[DAEMON RUN] Worktree creation failed: ${worktreeResult.error}`
          );
          return {
            type: "error",
            errorMessage: worktreeResult.error,
          };
        }
        worktreeInfo = worktreeResult.info;
        spawnDirectory = worktreeInfo.worktreePath;
        logger.debug(
          `[DAEMON RUN] Created worktree ${worktreeInfo.worktreePath} (branch ${worktreeInfo.branch}, port=${claimedPort})`
        );

        // #2450 (R1, R4): kick the expired-worktree purge via the single-flight
        // wrapper now that createWorktree's git mutations are done. Its 0-22s
        // cost (rm of node_modules-heavy trash, ~1.2 GB / ~82k files per expired
        // entry) no longer gates the spawn RPC. `void` preserves fire-and-forget;
        // the wrapper coalesces concurrent spawns to ONE purge per repo root — so
        // parallel spawns never run overlapping `git worktree remove`/`branch -D`
        // against the shared .git/ (AC #3) — and resolves the repo root + swallows
        // all failures internally (R3). Placement is unchanged from #2852 — AFTER
        // this spawn's own createWorktree, so the background purge can never race
        // THIS spawn's `git worktree add`. Keep the per-spawn trigger: the daemon
        // maintenance loop does NOT purge, so dropping it would let trash grow
        // unbounded.
        void kickExpiredWorktreePurge(directory);
        // #3210: kick the orphan-unit sweep on the success path too. This
        // spawn's own meta (with claimed_port/last_port) already exists, so its
        // port is `owned` and can never be a candidate — the sweep reaps only
        // units whose worktree is gone. Single-flight-guarded + `void`;
        // observe-first until HAPI_WT_ORPHAN_SWEEP=reap.
        void kickOrphanedUnitSweep(directory);

        // Verify the inline meta-write inside createWorktree() actually
        // landed. createWorktree treats meta-write failure as non-fatal,
        // so a missing file here is observable but not an abort condition
        // — the auto-bootstrap path (#1025) recovers. Log only.
        // Restores the WARN observability the previous run.ts code had.
        try {
          await fs.access(
            join(worktreeInfo.worktreePath, ".worktree-meta.json")
          );
        } catch {
          logger.warn(
            `[DAEMON RUN] .worktree-meta.json missing after createWorktree (port=${claimedPort}, branch=${worktreeInfo.branch}) — auto-bootstrap will recover`
          );
        }

        // Sync .claude/ config from the worktree's source branch to prevent
        // stale hooks/skills (#438; source-branch-aware since #1399).
        const syncResult = await syncConfigFromMain({
          worktreePath: worktreeInfo.worktreePath,
        });
        if (syncResult.ok) {
          // Issue #1356: surface fetch failure even when sync overall
          // succeeded — without this, a hung/failed fetch followed by a
          // successful diff/checkout against the (potentially stale) local
          // origin/<source-branch> ref would log nothing, recreating the
          // silent-failure mode that #1320 was meant to close at the spawn
          // surface (#1327 closed it at the resume surface).
          if (!syncResult.fetchSucceeded) {
            logger.warn(
              `[DAEMON RUN] Spawn-time .claude/ re-sync: fetch failed, used local origin/<source-branch> ref (${syncResult.filesUpdated} files updated) (port=${claimedPort}, branch=${worktreeInfo.branch})`
            );
          } else if (syncResult.filesUpdated > 0) {
            logger.debug(
              `[DAEMON RUN] Synced .claude/ from origin/<source-branch> (${syncResult.filesUpdated} files updated)`
            );
          }
        } else {
          logger.warn(
            `[DAEMON RUN] .claude/ sync failed (non-fatal): ${syncResult.error}`
          );
        }

        // Issue #1646 + #2852: install the worktree's node_modules so the
        // session's first `bun run typecheck` / build does not fail TS2688. The
        // daemon spawn path writes a claimed_port (above) but historically never
        // installed deps — the #1209 invariant only lived in the shell
        // `cmd_start`, and #1262 made the daemon claim ports too.
        //
        // #2852 (R2): START the install but do NOT await it inline — let control
        // flow reach spawnSessionInTmux and the RPC return WHILE the install
        // runs concurrently with the ~3s tmux spawn and the session's ~10-20s
        // Claude Code boot, which hides the 10-30s install. That overlap is the
        // entire latency win (the RPC returns ~10-30s sooner). Merely moving the
        // await past the tmux spawn yields almost nothing — tmux returns in ~3s.
        //
        // #2852 (R3): the #1209 invariant re-expresses from "deps ready before
        // spawn" to "deps ready before the session's first `bun run typecheck`"
        // (CC boot precedes the first typecheck). This fast path AUGMENTS (does
        // not replace) the downstream loud-failure fallback (the worker's own
        // `bun run typecheck` TS2688 / worktree-build.sh `die`) per the Fallback
        // Preservation Rule — a rare session that typechecks before the install
        // finishes degrades to that loud manual-recovery path, not a silent
        // break.
        //
        // #2852 (R4): the result-handling (WARN + reportCaught severity "error")
        // moves VERBATIM into the background continuation, so an overlapped
        // install failure is still surfaced. The continuation stands down when
        // the worktree was torn down (F1) so it cannot fire a spurious failure
        // report against a deliberately removed worktree. ensureWorktreeNodeModules
        // never throws (returns a structured result); the `.catch` is defense-
        // in-depth (F2 single-chain `void p.then().catch()`). Capture stable
        // non-null locals — the continuation runs after the try's narrowing is
        // gone.
        const depsWtInfo = worktreeInfo;
        const depsPort = claimedPort;
        // [perf] issue #2147 stage (d2): time the BACKGROUND bun install. It is
        // off the serial spawn path since #2852 — its duration matters only as
        // CPU contention with Claude boot on a Pi. grep `[perf][spawn]`.
        const perfInstallT0 = Date.now();
        depsPromise = ensureWorktreeNodeModules({
          worktreePath: depsWtInfo.worktreePath,
        });
        void depsPromise
          .then(depsResult => {
            logger.debug(
              `[perf][spawn] stage=bun-install background=true action=${depsResult.ok ? depsResult.action : "failed"} branch=${depsWtInfo.branch} ms=${Date.now() - perfInstallT0}`
            );
            if (worktreeTornDown) return;
            if (depsResult.ok) {
              if (depsResult.action === "installed") {
                logger.debug(
                  `[DAEMON RUN] Installed worktree node_modules (branch ${depsWtInfo.branch}, port=${depsPort})`
                );
              }
              // skipped-already-present / skipped-not-bun-workspace: steady
              // state, no log.
            } else {
              logger.warn(
                `[DAEMON RUN] Worktree node_modules install failed (non-fatal): ${depsResult.error} (branch ${depsWtInfo.branch}, port=${depsPort})`
              );
              logger.reportCaught(new Error(depsResult.error), {
                category: "daemon-worktree-node-modules",
                severity: "error",
                context: JSON.stringify({
                  worktreePath: depsWtInfo.worktreePath,
                  branch: depsWtInfo.branch,
                  port: depsPort,
                }),
              });
            }
          })
          .catch(err => {
            if (worktreeTornDown) return;
            logger.warn(
              `[DAEMON RUN] Worktree node_modules install threw (non-fatal): ${err} (branch ${depsWtInfo.branch}, port=${depsPort})`
            );
            logger.reportCaught(err, {
              category: "daemon-worktree-node-modules",
              severity: "error",
              context: JSON.stringify({
                worktreePath: depsWtInfo.worktreePath,
                branch: depsWtInfo.branch,
                port: depsPort,
              }),
            });
          });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`[DAEMON RUN] Worktree creation threw: ${message}`);
        logger.reportCaught(error, {
          category: "daemon-worktree-create",
          severity: "error",
        });
        // #2450 (R2): kick the purge even when createWorktree threw — the
        // background purge only touches already-soft-deleted .trash (never this
        // failed spawn's partial worktree) and is single-flight-guarded, so it
        // cannot race the caller's error handling. Restores the pre-#2852
        // "purge fires on every spawn attempt" coverage for the failure path.
        void kickExpiredWorktreePurge(directory);
        return {
          type: "error",
          errorMessage: `Worktree creation failed: ${message}`,
        };
      }
    }

    // === TMUX PERSISTENCE PATH ===
    // Issue #1082 (Tier 2): codex joins claude on the tmux-persistence path so
    // codex sessions (simple + worktree) survive daemon restarts. Gemini and
    // opencode stay on direct-spawn (Gemini has no native persistence;
    // #1975's opencode is OpenRouter-mandatory/env-only with no CODEX_HOME).
    if (
      (sessionType === "simple" || sessionType === "worktree") &&
      harnessSupportsPersistence(agent) &&
      isTmuxPersistenceEnabled()
    ) {
      logger.info(
        `[DAEMON RUN] Using tmux persistence for ${
          agent === "codex" ? "Codex" : "Claude"
        } session in ${spawnDirectory}`
      );

      // Issue #1082 (ruling D4): a codex session with a token or OpenRouter
      // model needs a durable session-scoped CODEX_HOME so its resume JSONL
      // survives a daemon restart. Set it up BEFORE the tmux window starts.
      let codexHomeForTmux: string | undefined;
      let codexExtraEnv: Record<string, string> = {};
      if (agent === "codex") {
        if (providerBinding.codexHome) {
          // #3808: bound per-account codex login — point CODEX_HOME at the
          // account's PERSISTENT dir (#3807 owns it at 0700) via `extraEnv` ONLY.
          // Do NOT set `codexHomeForTmux` (→ `session.codexHome`), which the tmux
          // path persists AND `fs.rm`s on session delete — the account dir must
          // survive exit / delete / daemon restart (R6/V2). Skip
          // `setupCodexHomeForTmux`: its ephemeral session-lifetime dir is for the
          // token / OpenRouter flow, not a bound account. [ER 2026-09-19: 3808-1]
          codexExtraEnv = { CODEX_HOME: providerBinding.codexHome };
        } else {
          const openRouterModelTmux =
            typeof options.model === "string" && options.model.trim().length > 0
              ? options.model.trim()
              : undefined;
          const codexSetup = await setupCodexHomeForTmux({
            hapiSessionId,
            token: options.token,
            openRouterModel: openRouterModelTmux,
            // Issue #3348: the ChatGPT-token model + reasoning effort bake on the
            // TMUX spawn path (the direct-path bake above is codex's other path).
            chatgptModel: nativeModelId,
            chatgptReasoningEffort: nativeReasoningEffort,
          });
          if (codexSetup && "error" in codexSetup) {
            if (directoryCreated) {
              try {
                await fs.rmdir(directory);
              } catch {
                // Ignore cleanup errors
              }
            }
            return { type: "error", errorMessage: codexSetup.error };
          }
          if (codexSetup) {
            codexHomeForTmux = codexSetup.codexHome;
            codexExtraEnv = codexSetup.extraEnv;
          }
        }
      }

      // Issue #3351 (epic #3345 Sub-Issue F): compute + deliver the per-session
      // auth binding on the TMUX-PERSISTENCE path (the direct-spawn path has its
      // own delivery; both must deliver — the #1262 dead-handoff trap). Only
      // claude + codex reach here (harnessSupportsPersistence). Label-only (R4).
      const tmuxOpenRouterModel =
        agent === "codex" &&
        typeof options.model === "string" &&
        options.model.trim().length > 0
          ? options.model.trim()
          : undefined;
      const tmuxAuthSettings = await readSettings();
      const tmuxAuthBindingJson = JSON.stringify(
        computeAuthBinding({
          agent,
          codexHasToken: agent === "codex" && Boolean(options.token),
          // #3808: a bound per-account codex record's authMode drives the binding
          // (providerId "openai"), taking precedence over the token/OpenRouter arms.
          codexBoundAuthMode: providerBinding.codexAuthMode,
          openRouterModel: tmuxOpenRouterModel,
          apiKeys: tmuxAuthSettings.apiKeys,
          openRouterUsedKey: tmuxAuthSettings.openRouterApiKey,
          // Issue #4568: a key-bound Claude spawn → api-key / anthropic.
          claudeApiKeyId: apiKeyBinding?.id,
          // Issue #5127: the label resolved at spawn ("Label (RP1)" for a key
          // stored on another node, which this vault cannot see).
          claudeApiKeyLabel: apiKeyBinding?.label,
        })
      );

      // Issue #3731 (R4): read the tmux global table BEFORE spawnSessionInTmux,
      // whose createWindow scrubs it. Latched off only after a SUCCESSFUL clean read
      // (see DaemonContext.ambientTokenTableProbeClean) so steady state costs
      // nothing; a failed or timed-out read (`null`) leaves the latch unset, so the
      // next bound spawn probes again.
      if (isBoundClaudeSpawn && !ctx.ambientTokenTableProbeClean) {
        const tableRead = await new TmuxManager({
          sessionName: configuration.tmuxSessionName,
          socketName: configuration.tmuxSessionName,
        }).readGlobalEnvVarNamesDetailed();
        // #4153 (A4): say WHY a read failed — once per distinct reason, not per
        // spawn. "No server" on the daemon's own socket is not a failure.
        if ("error" in tableRead && !tableRead.noServer) {
          const logged = (ctx.ambientTokenProbeFailuresLogged ??=
            new Set<string>());
          if (!logged.has(tableRead.error)) {
            logged.add(tableRead.error);
            logger.warn(
              `[DAEMON RUN] Ambient-token check: could not read the tmux global table (${tableRead.error}); retrying on the next bound spawn (#3731/#4153)`
            );
          }
        }
        const probe = classifyTableProbe(globalEnvNamesOrNull(tableRead));
        if (probe === "token") {
          ambientTokenSources.push("tmux global table");
        } else if (probe === "clean") {
          ctx.ambientTokenTableProbeClean = true;
        }
      }
      warnAmbientTokenOnBoundSpawn(ambientTokenSources);

      const tmuxResult = await spawnSessionInTmux({
        directory: spawnDirectory,
        agent,
        yolo,
        safeMode,
        modelMode: spawnModelMode,
        effort: spawnEffort,
        rawModel: spawnRawModel,
        sessionRole,
        // Issue #2626 (D): forward the per-session output style into the tmux
        // spawn path too (the #1262 trap — the direct-spawn argv push above and
        // the tmuxSpawnAdapter destructure are BOTH dead without this handoff).
        outputStyle,
        // #3731 (R0b): an explicit RPC token still wins; otherwise a strictly
        // unbound claude spawn receives the node's instance credential. The adapter
        // writes it into the 0600 env file (never a command line), where it is
        // re-exported AFTER the per-pane binding-var unset. `||`, not `??` (#4153
        // B1): an explicit EMPTY token counts as no token, exactly as on the direct
        // arm and in resolveUnboundInstanceToken, so it delivers the held one.
        token: options.token || unboundInstanceToken,
        // Issue #1082: codex-only — OpenRouter model → buildCodexCommand
        // --hapi-model; durable CODEX_HOME → env + PersistedSession.
        model:
          agent === "codex" &&
          typeof options.model === "string" &&
          options.model.trim().length > 0
            ? options.model.trim()
            : undefined,
        codexHome: codexHomeForTmux,
        resumeSessionId,
        forkSession,
        hapiSessionId,
        name,
        extraEnv: {
          // Issue #1082: CODEX_HOME + OPENROUTER_API_KEY for a codex session
          // (empty for claude). Merged first so worktree/account vars below
          // cannot be shadowed by it.
          ...codexExtraEnv,
          ...(worktreeInfo
            ? {
                HAPI_WORKTREE_BASE_PATH: worktreeInfo.basePath,
                HAPI_WORKTREE_BRANCH: worktreeInfo.branch,
                HAPI_WORKTREE_NAME: worktreeInfo.name,
                HAPI_WORKTREE_PATH: worktreeInfo.worktreePath,
                HAPI_WORKTREE_CREATED_AT: String(worktreeInfo.createdAt),
              }
            : {}),
          ...(originatingNodeId
            ? { HAPI_ORIGINATING_NODE_ID: originatingNodeId }
            : {}),
          // Issue #1456: bind the spawned process to an account so D's
          // launcher injection resolves its token (mirrors HAPI_ORIGINATING_NODE_ID).
          ...(accountUuid && !shouldSkipBinding
            ? { HAPI_ACCOUNT_UUID: accountUuid }
            : {}),
          // Issue #4568: the API-key binding — the vault id + the spawn-time mask
          // the launcher re-checks at every launch. Never the key itself: Claude
          // Code obtains it from the session's `apiKeyHelper`, so it never enters
          // this env file or any other environment.
          ...(apiKeyBinding
            ? {
                HAPI_API_KEY_ID: apiKeyBinding.id,
                HAPI_API_KEY_MASKED: apiKeyBinding.masked,
              }
            : {}),
          // Issue #1660: per-session launcher override → resolver env tier wins.
          ...(launcher ? { HAPI_CLAUDE_LAUNCHER: launcher } : {}),
          ...(scheduleId ? { HAPI_SCHEDULE_ID: scheduleId } : {}),
          // Issue #933: explicit claude path from federation config
          // overrides auto-detection in resolveClaudePath()
          ...(claudePath ? { HAPI_CLAUDE_PATH: claudePath } : {}),
          // Issue #3632: export the message-hook stage marker (literal "1"/"0")
          // on the tmux spawn path. This extraEnv object is merged into the
          // adapter's envVars (tmuxSpawnAdapter.ts) — do NOT also inject it there
          // (same value twice → drift). buildMessageHooksEnv returns {} when the
          // server did not stamp a value → marker OMITTED → rp1-home client DEFERS.
          ...buildMessageHooksEnv(messageHooksEnabled),
          // Issue #3351: deliver the computed auth binding to the tmux-persisted
          // CLI child (stamped in buildSessionMetadata). Merged last so it is
          // never shadowed; label-only, never a secret (R4).
          HAPI_AUTH_BINDING: tmuxAuthBindingJson,
        },
        // Issue #1661: reconnect kill-vs-reattach intent + the daemon-local
        // liveness checker the adapter calls when killLivePane===false. The
        // adapter re-attaches (skips respawn) ONLY if isWrapperAlive returns
        // true for the resolved window; otherwise it respawns (Fallback
        // Preservation Rule). The checker closes over pidToTrackedSession (the
        // daemon-local map the adapter cannot reach directly).
        killLivePane,
        isWrapperAlive: isTmuxWindowWrapperAlive,
      });

      // Issue #1661: re-attach short-circuit. When the adapter detected a
      // genuinely-live wrapper and SKIPPED the respawn (reattached=true), there
      // is no fresh child to wait for and no session-started webhook will fire.
      // Returning here BEFORE the child-detect + webhook flow is load-bearing:
      // the webhook path's 60s timeout calls cleanupTmuxSpawnFailure →
      // stopTmuxSession, which would kill the very live session we just
      // preserved. The session is already tracked + relaying via its live
      // wrapper FIFO, so success is immediate.
      if (tmuxResult.type === "success" && tmuxResult.reattached) {
        logger.info(
          `[DAEMON RUN] Reconnect re-attached to live session ${hapiSessionId} (no respawn) — skipping child-detect/webhook (#1661)`
        );
        return {
          type: "success",
          sessionId: tmuxResult.hapiSessionId ?? hapiSessionId,
        };
      }

      if (tmuxResult.type === "error") {
        logger.debug(
          `[DAEMON RUN] Tmux spawn failed: ${tmuxResult.errorMessage}`
        );
        // Clean up directory if we created it
        if (directoryCreated) {
          try {
            await fs.rmdir(directory);
          } catch {
            // Ignore cleanup errors
          }
        }
        // Clean up worktree AND branch if we created it (#438, #1202).
        // Use the same hard-remove helper as the post-tmux failure paths
        // (#1202) — soft-delete-via-`cleanupWorktreeAndBranch` would
        // preserve the branch and force a `-XXXX` suffix on retry. tmux
        // never started here, so `tmuxSessionId` is null.
        await cleanupTmuxSpawnFailure("tmux-spawn-error", null);
        return {
          type: "error",
          errorMessage:
            tmuxResult.errorMessage || "Failed to spawn tmux session",
        };
      }

      // Get the shell PID from the tmux window.
      //
      // Prefer index-based lookup (`getWindowPidByIndex`) when the spawn
      // captured a window index. On tmux 3.4+ (WSL2 / SL7 / RP2), the
      // `list-windows -F` path that `getTmuxSessionPid` traverses returns
      // stale data for an extended period after `new-window` — even with
      // the bumped retry budget. Index-based `display-message -t <s>:<i>`
      // bypasses that entirely. Falls back to the name-based path when no
      // index is available (reconnect/recovery, parse failure). #1315.
      let shellPid: number | null = null;
      if (tmuxResult.tmuxWindowIndex != null) {
        const tmuxIndexed = new TmuxManager({
          sessionName: configuration.tmuxSessionName,
          socketName: configuration.tmuxSessionName,
        });
        shellPid = await tmuxIndexed.getWindowPidByIndex(
          tmuxResult.tmuxWindowIndex
        );
      }
      if (shellPid == null && tmuxResult.hapiSessionId) {
        shellPid = await getTmuxSessionPid(tmuxResult.hapiSessionId);
      }

      if (!shellPid) {
        logger.debug(`[DAEMON RUN] Failed to get shell PID for tmux window`);
        await cleanupTmuxSpawnFailure(
          "no-shell-pid",
          tmuxResult.hapiSessionId ?? null
        );
        return {
          type: "error",
          errorMessage: "Failed to get shell PID from tmux window",
        };
      }

      logger.debug(
        `[DAEMON RUN] Tmux shell PID: ${shellPid}, waiting for child processes...`
      );

      // Wait for any child process to start inside the tmux shell.
      // Issue #1555: child-detect budget. The default 20s suits the normal
      // path (which is followed by the 60s webhook wait). The
      // awaitWebhook:false path (account-switch / reconnect respawn) returns
      // on child-start with NO subsequent webhook wait, so the child-detect
      // IS its entire spawn budget — give it more headroom to absorb
      // process-spawn starvation under host CPU overload (a loaded Pi 5 at
      // load avg ~6 exceeded the 20s gate during back-to-back switch
      // respawns). 45s stays well under the 75s spawn RPC ack so the server
      // never pre-empts it. A genuinely-stuck spawn still rolls back (R4) —
      // just after 45s instead of 20s.
      const childDetectTimeoutMs = awaitWebhook === false ? 45_000 : 20_000;
      const hasChildren = await waitForAnyChild(shellPid, childDetectTimeoutMs);

      if (!hasChildren) {
        logger.debug(`[DAEMON RUN] No child processes started within timeout`);
        await cleanupTmuxSpawnFailure(
          "no-children",
          tmuxResult.hapiSessionId ?? null
        );
        return {
          type: "error",
          errorMessage: "Claude process did not start within timeout",
        };
      }

      logger.debug(
        `[DAEMON RUN] Child processes detected under shell PID ${shellPid}`
      );

      // Create tracked session - PID will be updated when webhook arrives
      // We track by shell PID to enable descendant matching in webhook handler
      const trackedSession: TrackedSession = {
        startedBy: "daemon",
        pid: shellPid, // Placeholder - will be updated to actual reporting PID by webhook
        childProcess: undefined, // tmux sessions don't have a direct child process handle
        directoryCreated,
        message: directoryCreated
          ? `The path '${directory}' did not exist. Created folder and spawned tmux-backed session.`
          : undefined,
        // Store tmux-specific info for cleanup
        tmuxSessionId: tmuxResult.hapiSessionId,
        tmuxWindow: tmuxResult.tmuxWindow,
        tmuxWindowIndex: tmuxResult.tmuxWindowIndex, // #1316
        tmuxWindowId: tmuxResult.tmuxWindowId, // #3734
      };

      // Register in shellPidToTrackedSession for descendant matching
      shellPidToTrackedSession.set(shellPid, trackedSession);

      // Link TrackedSession to PersistedSession for webhook handler correlation.
      // The session is already saved by spawnSessionInTmux (tmuxSpawnAdapter.ts:433).
      if (isTmuxPersistenceEnabled()) {
        trackedSession.persistedHapiSessionId = hapiSessionId;
      }

      // Wait for webhook to populate session with the real happySessionId
      // The webhook handler will find this session by checking if the reporting
      // PID is a descendant of any tracked shell PID
      logger.debug(
        `[DAEMON RUN] Waiting for session webhook (shell PID ${shellPid}, will match descendants)`
      );

      // RACE CONDITION FIX: Check if webhook already arrived before we registered
      // The webhook may have been processed as "external" if it arrived before
      // we registered the shell PID. Check for any recently-registered sessions
      // that are actually descendants of our shell PID.
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (
          session.startedBy !== "daemon" &&
          isPidDescendantOf(pid, shellPid)
        ) {
          logger.debug(
            `[DAEMON RUN] Found already-arrived webhook: PID ${pid} is descendant of shell ${shellPid}`
          );
          // This session is ours! Update and return immediately
          trackedSession.happySessionId = session.happySessionId;
          trackedSession.happySessionMetadataFromLocalWebhook =
            session.happySessionMetadataFromLocalWebhook;
          trackedSession.pid = pid;
          // Clean up the orphaned entry
          pidToTrackedSession.delete(pid);
          pidToTrackedSession.set(pid, trackedSession);
          shellPidToTrackedSession.delete(shellPid);
          return {
            type: "success",
            sessionId: trackedSession.happySessionId!,
          };
        }
      }

      const webhookPromise = new Promise<SpawnSessionResult>(resolve => {
        // Set timeout for webhook — 60s spawn budget for slower systems.
        // A cold Claude session on a Pi 5 (large CLAUDE.md + MCP servers +
        // plugins + SessionStart hooks) can take >30s to phone home; 30s
        // produced spurious "spawn failed" while the session was actually
        // booting. The server-RPC ack (75s) and web request (90s) sit above
        // this so they never pre-empt a slow-but-valid spawn.
        const timeout = setTimeout(() => {
          pidToAwaiter.delete(shellPid);
          shellPidToTrackedSession.delete(shellPid);
          logger.debug(
            `[DAEMON RUN] Session webhook timeout for tmux shell PID ${shellPid}`
          );
          resolve({
            type: "error",
            errorMessage: `Session webhook timeout for tmux session`,
          });
        }, 60_000);

        // Register awaiter keyed by shell PID
        pidToAwaiter.set(shellPid, async completedSession => {
          clearTimeout(timeout);
          logger.debug(
            `[DAEMON RUN] Tmux session ${completedSession.happySessionId} fully spawned with webhook`
          );

          // If the tmux window name was deduplicated (issue #816), push the
          // corrected name to the server BEFORE returning the spawn result.
          // This ensures the web app sees the deduplicated name when it loads
          // the session, preventing a race where the web app's metadata update
          // overwrites the deduplicated name with the original.
          if (
            tmuxResult.tmuxWindow &&
            name &&
            tmuxResult.tmuxWindow !== name &&
            completedSession.happySessionId
          ) {
            try {
              const renameHeaders: Record<string, string> = {
                "Content-Type": "application/json",
              };
              if (configuration.cliApiToken) {
                renameHeaders["Authorization"] =
                  `Bearer ${configuration.cliApiToken}`;
              }
              const renameUrl = `${configuration.serverUrl}/cli/sessions/${completedSession.happySessionId}`;
              const abortController = new AbortController();
              const fetchTimeout = setTimeout(
                () => abortController.abort(),
                5_000
              );
              const renameResp = await fetch(renameUrl, {
                method: "PATCH",
                headers: renameHeaders,
                body: JSON.stringify({
                  name: tmuxResult.tmuxWindow,
                  skipTmuxSync: true,
                }),
                signal: abortController.signal,
              });
              clearTimeout(fetchTimeout);
              if (renameResp.ok) {
                logger.info(
                  `[DAEMON RUN] Pushed deduplicated name "${tmuxResult.tmuxWindow}" to server for session ${completedSession.happySessionId}`
                );
              } else {
                logger.warn(
                  `[DAEMON RUN] Failed to push deduplicated name to server: ${renameResp.status} ${renameResp.statusText}`
                );
              }
            } catch (err) {
              logger.warn(
                `[DAEMON RUN] Error pushing deduplicated name to server:`,
                err
              );
              logger.reportCaught(err, {
                category: "daemon-server-rename-push",
                severity: "warn",
              });
            }
          }

          resolve({
            type: "success",
            sessionId: completedSession.happySessionId!,
            // Include resolved (possibly deduplicated) name so the web app
            // can use it instead of the original user-provided name.
            resolvedName:
              tmuxResult.tmuxWindow && name && tmuxResult.tmuxWindow !== name
                ? tmuxResult.tmuxWindow
                : undefined,
          });
        });
      });

      // Issue #1555: await-webhook gate. When awaitWebhook === false (set by
      // switchAccount's reconnect-style respawn), return success now that the
      // child has STARTED (waitForAnyChild passed above) and let the cold MCP
      // load finish asynchronously. Keep the webhook promise running
      // fire-and-forget so its bookkeeping still fires: the awaiter pushes the
      // dedup name + cleans shellPidToTrackedSession when the webhook lands,
      // and a genuine never-phones-home boot failure still triggers
      // cleanupTmuxSpawnFailure via the 60s timeout branch. The
      // shellPidToTrackedSession entry stays registered so the eventual
      // webhook is correlated. Reconnect-style respawns reuse the tag, so
      // hapiSessionId is the correct success id. The R4 rollback in
      // switchAccount is preserved — a no-child-started failure returns error
      // from waitForAnyChild above (never reaching here) and still rolls back.
      if (awaitWebhook === false) {
        void webhookPromise.then(async r => {
          if (r.type !== "success") {
            await cleanupTmuxSpawnFailure(
              "webhook-timeout",
              tmuxResult.hapiSessionId ?? null
            );
          }
        });
        return { type: "success", sessionId: hapiSessionId };
      }

      const spawnResult = await webhookPromise;

      logger.debug(`[DAEMON RUN] Spawn result: ${JSON.stringify(spawnResult)}`);
      // Issue #1202: webhook timeout (or any non-success resolution) leaves
      // a partial worktree + a tmux pane that may have Claude running. Mirror
      // the non-tmux path's spawn-error cleanup (line ~1422 in the
      // post-tmux branch) so retries land at the unsuffixed worktree path.
      if (spawnResult.type !== "success") {
        await cleanupTmuxSpawnFailure(
          "webhook-timeout",
          tmuxResult.hapiSessionId ?? null
        );
      }
      return spawnResult;
    }

    // Issue #3731 (R4): the direct arm has no tmux table — daemon env only.
    warnAmbientTokenOnBoundSpawn(ambientTokenSources);

    const cleanupWorktree = async () => {
      if (!worktreeInfo) {
        return;
      }
      // #2852 F1: settle/abort the backgrounded install BEFORE removing the
      // worktree so the kill sweep can't race defaultBunInstall's respawn.
      await settleDepsBeforeTeardown();
      // Hard-remove worktree AND branch (#438, #1202). Was previously
      // `cleanupWorktreeAndBranch` which soft-deletes; that preserves the
      // branch and forces `-XXXX` suffixes on retry (issue #1202).
      const result = await forceRemoveWorktreeAndBranch({
        basePath: worktreeInfo.basePath,
        worktreePath: worktreeInfo.worktreePath,
        branch: worktreeInfo.branch,
        sessionId: hapiSessionId,
      });
      if (!result.ok) {
        logger.debug(
          `[DAEMON RUN] Failed to remove worktree ${worktreeInfo.worktreePath}: ${result.error}`
        );
      }
    };
    const maybeCleanupWorktree = async (reason: string) => {
      if (!worktreeInfo) {
        return;
      }
      const pid = happyProcess?.pid;
      if (pid && isProcessAlive(pid)) {
        logger.debug(
          `[DAEMON RUN] Skipping worktree cleanup after ${reason}; child still running`,
          {
            pid,
            worktreePath: worktreeInfo.worktreePath,
          }
        );
        return;
      }
      await cleanupWorktree();
    };

    // Issue #1733: per-session CODEX_HOME, declared above the try so EVERY
    // exit path (normal exit, spawn error, no-pid, exception) can remove it
    // (R8 — fixes the pre-existing hapi-codex-* temp-dir credential leak).
    let codexHomeDir: string | undefined;
    const cleanupCodexHome = () => {
      if (!codexHomeDir) return;
      const dir = codexHomeDir;
      codexHomeDir = undefined; // idempotent — only rm once
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    };

    // Issue #3122: a DEDICATED per-session HAL skill-projection home, created
    // only for a foreign spawn that does NOT already fabricate a config home
    // (a token-less codex / gemini / opencode). When projection reuses the
    // existing codexHomeDir, this stays undefined and cleanupCodexHome owns the
    // teardown. Rides the same every-exit-path cleanup lifecycle as codexHomeDir
    // so a projection home never leaks.
    let projectionHomeDir: string | undefined;
    const cleanupProjectionHome = () => {
      if (!projectionHomeDir) return;
      const dir = projectionHomeDir;
      projectionHomeDir = undefined; // idempotent — only rm once
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    };

    try {
      // Resolve authentication token if provided
      let extraEnv: Record<string, string> = {};

      // Issue #3349 (ruling D4(a)): an opencode spawn is NATIVE-routed when the
      // explicit `modelRouting` discriminator says so. This is the wire signal
      // that distinguishes a native `provider/model` selection from an OpenRouter
      // one — NOT a string-shape heuristic. Parse the `provider/model` (opencode's
      // canonical model format) ONCE here so both the opencode spawn branch and
      // the auth-binding computation reuse it. `null` when the selection is
      // malformed (no "/" or an empty side) — the branch fails fast on it.
      const isNativeOpencodeRouting =
        options.agent === "opencode" && options.modelRouting === "native";
      const nativeOpencodeSelection = ((): {
        provider: string;
        model: string;
      } | null => {
        if (!isNativeOpencodeRouting) return null;
        const raw =
          typeof options.model === "string" ? options.model.trim() : "";
        const slash = raw.indexOf("/");
        if (slash <= 0 || slash === raw.length - 1) return null;
        return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
      })();

      // Issue #1733/#1975: an OpenRouter-routed model was requested. The web
      // model picker sets `model` for gateway:openrouter-capable codex AND
      // opencode sessions, so (agent ∈ {codex, opencode} && model) is the
      // OpenRouter signal — EXCEPT a native-routed opencode spawn (#3349), whose
      // `model` is a native `provider/model` and must NOT be read as OpenRouter.
      const openRouterModel =
        !isNativeOpencodeRouting &&
        (options.agent === "codex" || options.agent === "opencode") &&
        typeof options.model === "string" &&
        options.model.trim().length > 0
          ? options.model.trim()
          : undefined;

      // Create a per-session CODEX_HOME for any codex session that needs one
      // (ChatGPT token OR OpenRouter). A token-less, model-less codex session
      // keeps codex's own default home unchanged (R7).
      if (options.agent === "codex" && (options.token || openRouterModel)) {
        // R4: fail fast if an OpenRouter model is selected but no key is
        // configured — never fall through to a default provider or hang.
        let openRouterApiKey: string | undefined;
        if (openRouterModel) {
          const liveSettings = await readSettings();
          openRouterApiKey = liveSettings.openRouterApiKey?.trim() || undefined;
          if (!openRouterApiKey) {
            logger.warn(
              "[DAEMON RUN] OpenRouter model requested but no openRouterApiKey configured — failing spawn"
            );
            await maybeCleanupWorktree("openrouter-no-key");
            return {
              type: "error",
              errorMessage:
                "OpenRouter model selected but no OpenRouter API key is configured on this node. Set `openRouterApiKey` in settings.json and retry.",
            };
          }
        }

        codexHomeDir = await fs.mkdtemp(join(os.tmpdir(), "hapi-codex-"));
        extraEnv = { CODEX_HOME: codexHomeDir };

        if (openRouterModel && openRouterApiKey) {
          // OpenRouter (R2/R3): emit a config.toml provider table (NOT
          // auth.json — the key is a provider API key, not a ChatGPT OAuth
          // token) and deliver the key via env so Codex reads it while its
          // shell_environment_policy filters it from the agent's bash tools.
          await writeOpenRouterCodexHome(codexHomeDir, {
            model: openRouterModel,
          });
          extraEnv.OPENROUTER_API_KEY = openRouterApiKey;
        } else if (options.token) {
          // ChatGPT-auth Codex: write the OAuth token to auth.json, now 0600
          // (R9 — also fixes the pre-existing un-moded write).
          const authPath = join(codexHomeDir, "auth.json");
          await fs.writeFile(authPath, options.token, { mode: 0o600 });
          await fs.chmod(authPath, 0o600).catch(() => {});
          // Issue #3348: bake the selected model + reasoning effort into
          // config.toml (codex's built-in openai provider; no provider table),
          // in the SAME CODEX_HOME as auth.json. Gated on a managed token being
          // present so this per-session CODEX_HOME always carries auth — a
          // host-auth (token-less) codex session keeps its own ~/.codex (no
          // CODEX_HOME override), so its model selection is a documented
          // follow-up (it needs host-auth seeding without the durable
          // stale-token risk). A model-less ChatGPT spawn writes only auth.json,
          // byte-identical to pre-#3348.
          if (nativeModelId || nativeReasoningEffort) {
            await writeChatGptCodexHome(codexHomeDir, {
              model: nativeModelId,
              reasoningEffort: nativeReasoningEffort,
            });
          }
          // #3348 display marker: buildSessionMetadata stamps metadata.nativeModel
          // from this so the in-session UI shows the active codex model.
          if (nativeModelId) {
            extraEnv.HAPI_NATIVE_MODEL = nativeModelId;
          }
        }
      } else if (options.agent === "opencode") {
        // Issue #3349: OpenCode is NO LONGER OpenRouter-mandatory (#1975). Branch
        // on the explicit modelRouting discriminator (ruling D4(a) — NOT a
        // string-shape heuristic): a native provider selection resolves a
        // per-provider key from the #1955 apiKeys vault and emits a native
        // provider block; otherwise the pre-#3349 OpenRouter path runs UNCHANGED
        // (R5). Both paths deliver model + permission posture via
        // OPENCODE_CONFIG_CONTENT (inline JSON env) with
        // OPENCODE_DISABLE_PROJECT_CONFIG=1 — no temp dir, nothing on disk.
        if (nativeOpencodeSelection) {
          // Native path (#3349) — the FIRST spawn-path vault read in the codebase
          // (no precedent to mirror; the codexProviderConfig vault-read citation
          // was a research error). readSettings().apiKeys lookup by provider (at
          // most one entry per provider — the StoredApiKeySchema invariant). The
          // provider key is delivered IN the config's provider block
          // (buildOpenCodeConfigContent) — never on the spawn wire / metadata /
          // preview; no OPENROUTER_API_KEY env on this path (R4: no new provider
          // types, just the vault entry the operator already stored).
          const { provider: nativeProvider, model: nativeModelId } =
            nativeOpencodeSelection;
          const liveSettings = await readSettings();
          const providerKey =
            (liveSettings.apiKeys ?? [])
              .find(k => k.provider === nativeProvider && k.key?.trim())
              ?.key?.trim() || undefined;
          if (!providerKey) {
            logger.warn(
              `[DAEMON RUN] OpenCode native provider "${nativeProvider}" selected but no vault key configured — failing spawn`
            );
            await maybeCleanupWorktree("opencode-no-native-key");
            return {
              type: "error",
              errorMessage: `OpenCode selected the "${nativeProvider}" provider but no API key for it is configured on this node. Add one in Settings → Provider Accounts → Provider API Keys (provider: ${nativeProvider}) and retry.`,
            };
          }
          extraEnv = {
            OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent({
              routing: "native",
              provider: nativeProvider,
              model: nativeModelId,
              apiKey: providerKey,
              yolo,
            }),
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            // #3349 display marker: buildSessionMetadata stamps metadata.nativeModel
            // so the in-session UI shows the active native provider/model (parity
            // with the codex/gemini HAPI_NATIVE_MODEL markers). Non-secret.
            HAPI_NATIVE_MODEL: `${nativeProvider}/${nativeModelId}`,
          };
        } else if (isNativeOpencodeRouting) {
          // modelRouting === "native" but the provider/model was malformed
          // (nativeOpencodeSelection === null). Fail fast — never fall through to
          // the OpenRouter branch, which would misroute the native selection.
          logger.warn(
            "[DAEMON RUN] OpenCode native routing requested but the provider/model selection was malformed — failing spawn"
          );
          await maybeCleanupWorktree("opencode-bad-native-model");
          return {
            type: "error",
            errorMessage:
              "OpenCode native routing requires a `provider/model` selection. Pick a provider and model in the New Session form and retry.",
          };
        } else {
          // OpenRouter path (explicit "openrouter" OR absent + model = legacy) —
          // UNCHANGED from #1975 (R5). OpenCode auto-detects OPENROUTER_API_KEY
          // from the env; the key never enters the config. The legacy
          // settings.openRouterApiKey read survives for pre-#1955 operators.
          if (!openRouterModel) {
            logger.warn(
              "[DAEMON RUN] OpenCode session requested without a model — failing spawn"
            );
            await maybeCleanupWorktree("opencode-no-model");
            return {
              type: "error",
              errorMessage:
                "OpenCode requires an OpenRouter model selection. Pick a model in the New Session form and retry.",
            };
          }
          const liveSettings = await readSettings();
          const openRouterApiKey =
            liveSettings.openRouterApiKey?.trim() || undefined;
          if (!openRouterApiKey) {
            logger.warn(
              "[DAEMON RUN] OpenCode (OpenRouter) requested but no openRouterApiKey configured — failing spawn"
            );
            await maybeCleanupWorktree("opencode-no-key");
            return {
              type: "error",
              errorMessage:
                "OpenCode selected but no OpenRouter API key is configured on this node. Add one in Settings → Provider Accounts → Provider API Keys (provider: openrouter) and retry.",
            };
          }
          extraEnv = {
            OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent({
              routing: "openrouter",
              model: openRouterModel,
              yolo,
            }),
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENROUTER_API_KEY: openRouterApiKey,
          };
        }
      } else if (options.agent === "codex" && providerBinding.codexHome) {
        // #3808: bound per-account codex login on the DIRECT-spawn path (codex when
        // tmux persistence is disabled). CODEX_HOME points at the account's
        // PERSISTENT dir — never fabricated here, so `codexHomeDir` stays undefined
        // and `cleanupCodexHome` is a no-op (the account dir must survive). [ER 2026-09-19: 3808-1]
        extraEnv = { CODEX_HOME: providerBinding.codexHome };
      } else if (options.agent === "gemini") {
        // Issue #3362: inject GEMINI_API_KEY from the #1954 apiKeys vault
        // (settings.apiKeys) at spawn, mirroring the codex OpenRouter arm's
        // SHAPE (resolve key → named fail-fast → extraEnv.<KEY> = value) — but
        // NOT its trigger: gemini has no OpenRouter-style selection signal, so
        // injection is EXISTENCE-driven (expert-review ruling D5), not
        // selection-driven. Gemini always lands here (never the tmux block-A):
        // harnessSupportsPersistence("gemini") is false (gemini.ts tmuxSafe:
        // false), so a gemini spawn is always direct-spawn — this is the ONE
        // injection site.
        const geminiSettings = await readSettings();
        const geminiApiKeys = geminiSettings.apiKeys ?? [];
        // Prefer provider "gemini"; fall back to "google". BOTH are first-class
        // storable providers (the per-provider upsert keys on the exact string,
        // so both can coexist; only the VALIDATION adapter aliases google→gemini).
        // #3808: the vault invariant is now "at most one entry per (provider,
        // accountUuid ?? null)", so bind the PER-ACCOUNT key when this spawn is bound
        // to a Google account — prefer the vault entry matching the bound accountUuid,
        // then fall back to the provider's UNBOUND (default) entry (today's behaviour).
        // [ER 2026-09-19: 3808-5]
        const boundGoogleUuid =
          spawnProvider === "google" ? accountUuid : undefined;
        const matchVault = (prov: string, uuid: string | undefined) =>
          geminiApiKeys.find(
            k =>
              k.provider === prov &&
              (k.accountUuid ?? undefined) === uuid &&
              k.key?.trim()
          );
        // Tier 1: the bound account's key. Tier 2: the provider's unbound key.
        const geminiEntry =
          (boundGoogleUuid
            ? matchVault("gemini", boundGoogleUuid)
            : undefined) ?? matchVault("gemini", undefined);
        const googleEntry =
          (boundGoogleUuid
            ? matchVault("google", boundGoogleUuid)
            : undefined) ?? matchVault("google", undefined);
        if (geminiEntry && googleEntry) {
          logger.warn(
            "[DAEMON RUN] Both a 'gemini' and a 'google' API-key vault entry match this spawn — preferring 'gemini'."
          );
        }
        const geminiVaultKey =
          (geminiEntry ?? googleEntry)?.key?.trim() || undefined;
        if (geminiVaultKey) {
          // Precedence (R2, ruling D5(a)): the vault entry (gemini preferred
          // over google) WINS over any node-local env. Setting it on extraEnv
          // means `childEnv = {...process.env, ...extraEnv}` (below) overrides a
          // pre-existing process.env.GEMINI_API_KEY. Env-only delivery (R3):
          // the key rides extraEnv into the child ONLY — never persisted to
          // session metadata, logged, or added to a spawn command preview.
          extraEnv.GEMINI_API_KEY = geminiVaultKey;
        } else if (!process.env.GEMINI_API_KEY?.trim()) {
          // R4 (ruling D5): NEITHER a vault key (gemini|google) NOR rp1's
          // node-local Option A env (daemon EnvironmentFile drop-in, inherited
          // into childEnv via process.env) is present — the ONLY reachable bad
          // state. Fail fast with a NAMED error (no key material); never fall
          // through to an unauthenticated gemini spawn.
          logger.warn(
            "[DAEMON RUN] Gemini session requested but no Gemini API key is configured (no vault entry and no node-local GEMINI_API_KEY) — failing spawn"
          );
          await maybeCleanupWorktree("gemini-no-key");
          return {
            type: "error",
            errorMessage:
              "Gemini selected but no Gemini API key is configured on this node. Add one in Settings → Provider Accounts → Provider API Keys (provider: gemini) or set GEMINI_API_KEY in the daemon environment, and retry.",
          };
        }
        // else: no vault key but a node-local GEMINI_API_KEY IS present → leave
        // extraEnv untouched so rp1's Option A env delivery is preserved (R2).
      } else if (
        options.token &&
        (options.agent === "claude" || !options.agent)
      ) {
        extraEnv = {
          CLAUDE_CODE_OAUTH_TOKEN: options.token,
        };
      }

      // Issue #3348 (ruling D3(a)): convey a gemini native model via the
      // GEMINI_MODEL env var. The gemini wrapper (geminiCommand.ts) parses ONLY
      // --started-by / --yolo and silently DROPS unknown argv, so an argv --model
      // append is a no-op — the env route is the only working conveyance.
      // agent-gemini/registerAgent.ts `buildEnv()` passes the FULL process env
      // through to the ACP-spawned gemini, so this needs zero extension edits.
      // Auto (no selection) omits it → the gemini CLI picks its own default.
      // Merged (not overwritten) so a worktree/account spawn's other extraEnv survives.
      if (options.agent === "gemini" && nativeModelId) {
        extraEnv = {
          ...extraEnv,
          // Conveyance to the gemini CLI (ruling D3(a)).
          GEMINI_MODEL: nativeModelId,
          // #3348 display marker: buildSessionMetadata stamps metadata.nativeModel
          // from this so the in-session UI shows the active model.
          HAPI_NATIVE_MODEL: nativeModelId,
        };
      }

      // Issue #3122: HAL skill projection. Materialize the projected skill fleet
      // (Agent Plugins 1.0.0) into the foreign harness's per-session config home
      // before the child launches. Gated on the NORMALIZED `agent` local (NOT
      // `options.agent`, which is undefined on a default Claude spawn — the R6
      // Claude-parity guard) AND on `HAPI_SKILL_PROJECTION` (default OFF, so this
      // is byte-identical to today until explicitly enabled). Reuse the existing
      // codexHomeDir when a codex spawn already fabricated one; otherwise create a
      // DEDICATED ephemeral projection home — this never overrides the harness's
      // own config-home env (no `~/.codex` / disk-less-opencode regression). Fully
      // fail-open: projectSkills never throws on an unconfigured canonical source
      // (Task 5 policy), and this block's catch makes any projection error
      // non-fatal to the spawn.
      if (agent !== "claude" && isSkillProjectionEnabled()) {
        try {
          const projectionSettings = await readSettings();
          if (!codexHomeDir) {
            projectionHomeDir = await fs.mkdtemp(
              join(os.tmpdir(), "hapi-projection-")
            );
          }
          const projectionHome = codexHomeDir ?? projectionHomeDir;
          if (projectionHome) {
            await projectSkills({
              agentId: agent,
              configHomeDir: projectionHome,
              canonicalCheckoutPath:
                projectionSettings.halCanonicalCheckoutPath,
              cacheDir: join(
                configuration.happyHomeDir,
                "hal-projection-cache"
              ),
              generatedAt: new Date().toISOString(),
              // #3130: attribute the run to its model. Only OpenRouter
              // codex/opencode spawns carry one; a default spawn passes
              // `undefined` → provenance omits it (harness-default).
              model: openRouterModel,
            });
            // #3128 (Task 5): expose the projection home to the child so the
            // scorecard run reporter can read <home>/hal-projection/provenance.json
            // at session teardown. The ephemeral hapi-projection-* dir is
            // otherwise NOT plumbed to the child (only CODEX_HOME is), so
            // Gemini/OpenCode runs would go unscored without this.
            extraEnv.HAPI_PROVENANCE_HOME = projectionHome;
          }
        } catch (projectionError) {
          logger.warn(
            "[DAEMON RUN] #3122 skill projection failed (non-fatal — spawn continues):",
            projectionError
          );
          cleanupProjectionHome();
        }
      }

      if (worktreeInfo) {
        extraEnv = {
          ...extraEnv,
          HAPI_WORKTREE_BASE_PATH: worktreeInfo.basePath,
          HAPI_WORKTREE_BRANCH: worktreeInfo.branch,
          HAPI_WORKTREE_NAME: worktreeInfo.name,
          HAPI_WORKTREE_PATH: worktreeInfo.worktreePath,
          HAPI_WORKTREE_CREATED_AT: String(worktreeInfo.createdAt),
        };
      }

      if (originatingNodeId) {
        extraEnv = {
          ...extraEnv,
          HAPI_ORIGINATING_NODE_ID: originatingNodeId,
        };
      }

      // Issue #1456: bind the spawned process to an account (mirrors
      // HAPI_ORIGINATING_NODE_ID); D's launcher injection reads the env var.
      if (accountUuid && !shouldSkipBinding) {
        extraEnv = {
          ...extraEnv,
          HAPI_ACCOUNT_UUID: accountUuid,
        };
      }

      // Issue #4568: the API-key binding on the DIRECT arm too (the #1262
      // dead-handoff trap — both arms must deliver). Id + mask only; the key reaches
      // Claude Code through the session's `apiKeyHelper`, never an environment.
      if (apiKeyBinding) {
        extraEnv = {
          ...extraEnv,
          HAPI_API_KEY_ID: apiKeyBinding.id,
          HAPI_API_KEY_MASKED: apiKeyBinding.masked,
        };
      }

      // Issue #3731 (R0b): a strictly unbound claude spawn receives the node's
      // instance credential explicitly. `unboundInstanceToken` is undefined when
      // the request carried its own non-empty `options.token` (set into extraEnv
      // above), so the explicit token wins here exactly as on the tmux arm (#3731
      // F5); an empty one counts as none on both arms (#4153 B1).
      if (unboundInstanceToken) {
        extraEnv = {
          ...extraEnv,
          CLAUDE_CODE_OAUTH_TOKEN: unboundInstanceToken,
        };
      }

      // Issue #1660: per-session launcher override → resolver env tier wins.
      if (launcher) {
        extraEnv = {
          ...extraEnv,
          HAPI_CLAUDE_LAUNCHER: launcher,
        };
      }

      // Issue #2155: expose the spawn-time role to in-session telemetry hooks
      // (the direct-spawn analogue of the tmux path's HAPI_SESSION_ROLE inject).
      if (sessionRole) {
        extraEnv = {
          ...extraEnv,
          HAPI_SESSION_ROLE: sessionRole,
        };
      }

      if (scheduleId) {
        extraEnv = {
          ...extraEnv,
          HAPI_SCHEDULE_ID: scheduleId,
        };
      }

      // Issue #3351 (epic #3345 Sub-Issue F): compute the per-session auth
      // binding for THIS flavor and deliver it via HAPI_AUTH_BINDING (mirrors
      // HAPI_ACCOUNT_UUID). The CLI child stamps it onto session metadata in
      // buildSessionMetadata. Label-only — never a raw secret (R4); the node-local
      // vault label is resolved inside computeAuthBinding, which never emits key
      // material. This is the DIRECT-SPAWN delivery site; the tmux-persistence
      // path has its own (both must deliver — the #1262 dead-handoff trap).
      {
        const authBindingSettings = await readSettings();
        const authBinding = computeAuthBinding({
          agent,
          codexHasToken: agent === "codex" && Boolean(options.token),
          // #3808: a bound per-account codex record's authMode drives the binding
          // (providerId "openai"), taking precedence over the token/OpenRouter arms.
          codexBoundAuthMode: providerBinding.codexAuthMode,
          openRouterModel,
          // Issue #3349: a native-routed opencode spawn resolved a per-provider
          // vault key → the binding is an api-key for THAT provider, not the
          // OpenRouter gateway-key. undefined for an OpenRouter opencode spawn.
          opencodeNativeProvider: nativeOpencodeSelection?.provider,
          apiKeys: authBindingSettings.apiKeys,
          openRouterUsedKey: authBindingSettings.openRouterApiKey,
          // Issue #4568: a key-bound Claude spawn → api-key / anthropic.
          claudeApiKeyId: apiKeyBinding?.id,
          // Issue #5127: the label resolved at spawn (see the tmux site).
          claudeApiKeyLabel: apiKeyBinding?.label,
        });
        extraEnv = {
          ...extraEnv,
          HAPI_AUTH_BINDING: JSON.stringify(authBinding),
        };
      }

      // Construct arguments for the CLI
      const agentCommand =
        agent === "codex"
          ? "codex"
          : agent === "gemini"
            ? "gemini"
            : agent === "opencode"
              ? "opencode"
              : "claude";
      const args = [
        agentCommand,
        "--hapi-starting-mode",
        "remote",
        "--started-by",
        "daemon",
      ];
      // Issue #1975: `opencode acp` has no `--yolo` flag — its YOLO posture
      // lives in the OPENCODE_CONFIG_CONTENT permission block (Task 6), so the
      // CLI flag is skipped for opencode.
      if (yolo && agent !== "opencode") {
        args.push("--yolo");
      }
      // Issue #1633: Safe Mode + explicit model mode (mirror the tmux path)
      if (safeMode) {
        args.push("--safe-mode");
      }
      if (spawnModelMode) {
        args.push("--hapi-model-mode", spawnModelMode);
      }
      // Issue #2155: role-scoped `@`-include profile — claude-only (`@`-includes
      // are a claude concept). Hapimatic-internal flag; runClaude merges the
      // role's claudeMdExcludes into the hook-settings file.
      if (sessionRole && harnessSupportsSessionRole(agent)) {
        args.push("--hapi-session-role", sessionRole);
      }
      // Issue #2626 (D): per-session output style — claude-only (output styles
      // are a claude concept). Hapimatic-internal flag; runClaude injects it
      // into the generated --settings file so all four launcher kinds honor it.
      if (outputStyle && harnessSupportsOutputStyle(agent)) {
        args.push("--hapi-output-style", outputStyle);
      }
      // Issue #1733: route the OpenRouter model to the codex child via
      // --hapi-model so its EnhancedMode.model resolves to it (provider
      // routing itself comes from the config.toml model_provider, Phase 1).
      // #1975: opencode gets its model from OPENCODE_CONFIG_CONTENT instead,
      // so this flag is codex-only.
      if (openRouterModel && agent === "codex") {
        args.push("--hapi-model", openRouterModel);
      }

      // Support resuming existing Claude sessions. Issue #1082 (finding 1082-1,
      // in-path cleanup): codex remote mode IGNORES CLI args, so `--resume <id>`
      // for a codex direct-spawn is a latent no-op (its actual resume goes
      // through the tmux gate's --hapi-codex-resume → findCodexResumeFile).
      // Restrict --resume to non-codex agents so we stop pushing a dead flag.
      if (options.resumeSessionId && agent !== "codex") {
        args.push("--resume", options.resumeSessionId);
        logger.debug(`[DAEMON RUN] Adding --resume ${options.resumeSessionId}`);
      }
      const MAX_TAIL_CHARS = 4000;
      let stderrTail = "";
      const appendTail = (current: string, chunk: Buffer | string): string => {
        const text = chunk.toString();
        if (!text) {
          return current;
        }
        const combined = current + text;
        return combined.length > MAX_TAIL_CHARS
          ? combined.slice(-MAX_TAIL_CHARS)
          : combined;
      };
      const logStderrTail = () => {
        const trimmed = stderrTail.trim();
        if (!trimmed) {
          return;
        }
        logger.debug("[DAEMON RUN] Child stderr tail", trimmed);
      };

      // Defense #2: Build child env without session-specific vars.
      // Even if defense #1 missed (e.g., env var set after startup),
      // ensure children never inherit a stale HAPI_SESSION_ID. See issue #283.
      // Both inherited vars are stripped below; HAPI_SESSION_ID is then set to
      // THIS spawn's own hapiSessionId, as the tmux path does (#5083).
      //
      // Issue #3731 (R3 parity on the direct path): for a claude spawn, the
      // wrapper's account-binding env is EXACTLY what the daemon delivers
      // explicitly in `extraEnv` (HAPI_ACCOUNT_UUID when bound; a token passed
      // with the request; else the instance credential when strictly unbound;
      // nothing for a host-default spawn) — ambient BINDING_ENV_VARS never pass.
      // This mirrors the tmux arm's per-pane unset, and it is what makes the
      // wrapper-side R2b rule sound: an unbound wrapper treats its launch-time
      // CLAUDE_CODE_OAUTH_TOKEN as its explicit binding, so a host-default spawn
      // must not inherit a stray one here.
      //
      // Issue #4884 (PM ruling): `wrapperEnv` — this is the WRAPPER's env, so it
      // keeps an inherited ANTHROPIC_BASE_URL for a key session's wrapper to pass
      // on; the wrapper's own Claude-child build strips it for a subscription
      // session.
      const childEnv =
        agent === "claude"
          ? buildSdkSpawnEnv(process.env, extraEnv, { wrapperEnv: true })
          : { ...process.env, ...extraEnv };
      delete childEnv.HAPI_SESSION_ID;
      delete childEnv.HAPI_TMUX_WINDOW;
      // Issue #5083: hand the child THIS spawn's own tag, as the tmux path does
      // (tmuxSpawnAdapter.ts HAPI_SESSION_ID: hapiSessionId). The wrapper takes
      // its session tag from this var (sessionFactory.ts bootstrapSession), and
      // the server placeholder reconcile, the web Create-page swap and the
      // respawn re-attach all match on that tag. The value comes from the spawn
      // options or generateSessionId() — never from the environment — so #283's
      // guard above still holds: an inherited id is always stripped first.
      childEnv.HAPI_SESSION_ID = hapiSessionId;
      // Issue #4065: carry this instance's HAPI_HOME explicitly, mirroring the
      // tmux path (tmuxSpawnAdapter.ts envVars). The orphan-MCP reaper attributes
      // a process to this instance by the HAPI_HOME in its /proc environ, so every
      // daemon-spawned tree must carry it even when the daemon runs on the default
      // ~/.hapi home with no HAPI_HOME in its own env. Behavior-neutral for the
      // child, which resolves the identical home either way.
      childEnv.HAPI_HOME = configuration.happyHomeDir;
      // Issue #3632: export the message-hook stage marker (literal "1"/"0") on
      // the direct spawn path — the ONE line every direct spawn passes through.
      // buildMessageHooksEnv returns {} when the server did not stamp a value
      // (daemon-local POST /spawn-session, or an old server) → marker OMITTED,
      // never "0" → rp1-home client DEFERS (fail-closed).
      Object.assign(childEnv, buildMessageHooksEnv(messageHooksEnabled));

      happyProcess = spawnHappyCLI(args, {
        cwd: spawnDirectory,
        detached: true, // Sessions stay alive when daemon stops
        stdio: ["ignore", "pipe", "pipe"], // Capture stdout/stderr for debugging
        env: childEnv,
      });

      happyProcess.stderr?.on("data", data => {
        stderrTail = appendTail(stderrTail, data);
      });

      if (!happyProcess.pid) {
        logger.debug("[DAEMON RUN] Failed to spawn process - no PID returned");
        await maybeCleanupWorktree("no-pid");
        cleanupCodexHome();
        cleanupProjectionHome(); // #3122
        return {
          type: "error",
          errorMessage: "Failed to spawn HAPI process - no PID returned",
        };
      }

      const pid = happyProcess.pid;
      logger.debug(`[DAEMON RUN] Spawned process with PID ${pid}`);

      const trackedSession: TrackedSession = {
        startedBy: "daemon",
        pid,
        childProcess: happyProcess,
        directoryCreated,
        message: directoryCreated
          ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.`
          : undefined,
      };

      pidToTrackedSession.set(pid, trackedSession);

      happyProcess.on("exit", (code, signal) => {
        logger.debug(
          `[DAEMON RUN] Child PID ${pid} exited with code ${code}, signal ${signal}`
        );
        if (code !== 0 || signal) {
          logStderrTail();
        }
        // Issue #1733 (R8): remove the per-session CODEX_HOME temp dir.
        cleanupCodexHome();
        cleanupProjectionHome(); // #3122: remove the per-session projection home
        onChildExited(pid);
      });

      happyProcess.on("error", error => {
        logger.debug(`[DAEMON RUN] Child process error:`, error);
        cleanupCodexHome();
        cleanupProjectionHome(); // #3122
        onChildExited(pid);
      });

      // Wait for webhook to populate session with happySessionId
      logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${pid}`);

      const spawnResult = await new Promise<SpawnSessionResult>(resolve => {
        // Set timeout for webhook
        const timeout = setTimeout(() => {
          pidToAwaiter.delete(pid);
          logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${pid}`);
          logStderrTail();
          resolve({
            type: "error",
            errorMessage: `Session webhook timeout for PID ${pid}`,
          });
          // 60s spawn budget — matches the tmux-path webhook wait above.
          // (Was 15s; a slow Pi 5 session boot exceeded it even though the
          // session was still created successfully a few seconds later.)
        }, 60_000);

        // Register awaiter
        pidToAwaiter.set(pid, completedSession => {
          clearTimeout(timeout);
          logger.debug(
            `[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`
          );
          resolve({
            type: "success",
            sessionId: completedSession.happySessionId!,
          });
        });
      });
      if (spawnResult.type !== "success") {
        await maybeCleanupWorktree("spawn-error");
      }
      return spawnResult;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      // R6 in-path bug fix: bump severity from debug → warn so spawn
      // failures are visible without DEBUG=1; and route to error_logs.
      logger.warn("[DAEMON RUN] Failed to spawn session:", error);
      logger.reportCaught(error, {
        category: "daemon-spawn-session",
        severity: "error",
      });
      await maybeCleanupWorktree("exception");
      cleanupCodexHome();
      cleanupProjectionHome(); // #3122
      return {
        type: "error",
        errorMessage: `Failed to spawn session: ${errorMessage}`,
      };
    }
  };

  return { spawnSession };
}

export type SessionSpawner = ReturnType<typeof createSessionSpawner>;
