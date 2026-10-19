// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Create-form component at capacity: the #3515
   optimistic-spawn accepted-branch + R4 retry-form restore tip this large but
   cohesive create UI past the Epic-0 (#2077) 1500-line guardrail. Extracting
   handleCreateSession / handleCreateSchedule into hooks (as this component
   already does for ~10 sub-concerns) is the tracked follow-up; grandfathered
   like web/src/api/client.ts and web/src/router.tsx until then. */
import {
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ApiClient } from "@/api/client";
import type { CreateScheduledTaskRequest, Machine } from "@/types/api";
import { usePlatform } from "@/hooks/usePlatform";
import { useCreateSessionSections } from "@/hooks/useCreateSessionSections";
import { useSpawnSession } from "@/hooks/mutations/useSpawnSession";
import { usePollFederationRefresh } from "@/hooks/mutations/usePollFederation";
import { useScheduleMutations } from "@/extensions/scheduler/hooks/useScheduleMutations";
import { useSessions } from "@/hooks/queries/useSessions";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import { useAccounts, useNodeActiveAccount } from "@/hooks/queries/useAccounts";
import { useAccountUsage } from "@/hooks/queries/useAccountUsage";
import { useRecentPaths } from "@/hooks/useRecentPaths";
import { useVersion } from "@/hooks/useVersion";
import { addPendingSpawn, markSpawnFailed } from "@/lib/pending-spawns";
import { beginSpawnHandover, takeRetryForm } from "@/lib/spawn-draft";
import { buildClaimedIssueIndex } from "@/lib/claimedIssues";
import { selectOptimalAccountUuid } from "@/lib/selectOptimalAccount";
import type { LinkedIssue } from "@hapi/protocol/types";
import { validateSessionName } from "@hapi/protocol";
import type { AgentType, SessionMode, SessionType } from "./types";
import { ActionButtons } from "./ActionButtons";
import { FooterBar } from "./FooterBar";
import { DefaultsActionsBar } from "./DefaultsActionsBar";
import { useKeyboardAwareFieldFocus } from "./useKeyboardAwareFieldFocus";
import {
  buildMeterTargetLabel,
  buildSectionSummaries,
  SECTION_ACCENTS,
} from "./sectionSummaries";
import {
  buildSpawnInput,
  type SpawnDisplayContext,
  type SpawnSelections,
} from "./spawnCommand";
import {
  cloneLockFor,
  coerceGitTypeForClone,
  deriveFormState,
} from "./formState";
import { useAdminPreferences } from "@/hooks/useAdminPreferences";
import { useApiKeys } from "@/hooks/queries/useApiKeys";
import { apiKeyDisplayName } from "@/lib/apiKeyStatus";
import {
  resolveSpawnPermissionMode,
  getSpawnPermissionModeOptionsForFlavor,
} from "@hapi/protocol/modes";
import type { ModelMode, PermissionMode } from "@hapi/protocol/modes";
import type { EffortLevel } from "@hapi/protocol";
import { AgentSelector } from "./AgentSelector";
import { CapabilityChips } from "./CapabilityChips";
import { ProviderModelFields } from "./ProviderModelFields";
import { AccountSelector } from "./AccountSelector";
import { BranchNameField, toBranchName } from "./BranchNameField";
import { BranchReadOnly, BranchSelector } from "./BranchSelector";
import { useBranchSelection } from "./useBranchSelection";
import {
  currentRefLabel,
  directoryLabel,
  newBranchFeedback,
} from "./branchSelection";
import { SessionModeSelector } from "./SessionModeSelector";
import { CreateDefaultsProvider } from "./bookmarkContext";
import { useCreateDefaultsEngine } from "./useCreateDefaultsEngine";
import { AccountSelectorModal } from "@/components/AccountSelectorModal";
import { DirectorySection } from "./DirectorySection";
import { useDirectorySeed } from "./useDirectorySeed";
import { usePathExistence } from "./usePathExistence";
import { useAutoSelectMachine } from "./useAutoSelectMachine";
import {
  GitHubAccountRepoSelector,
  buildGitHubSummary,
} from "./GitHubAccountRepoSelector";
import { GitHubAccountSelectorModal } from "./GitHubAccountSelectorModal";
import { GitHubRepoSelectorModal } from "./GitHubRepoSelectorModal";
import { useGitHubSection } from "./useGitHubSection";
import type { GitHubRepo } from "@/hooks/queries/useGitHubRepos";
import { LinkIssueField } from "./LinkIssueField";
import { LauncherSelector } from "./LauncherSelector";
import { useLauncherSelection } from "./useLauncherSelection";
import { OutputStyleSelector } from "./OutputStyleSelector";
import { useOutputStyleSelection } from "./useOutputStyleSelection";
import {
  MachineSelector,
  parseSpawnTarget,
  type RemoteNode,
  type SpawnTarget,
} from "./MachineSelector";
import { CapacityNotice } from "./CapacityNotice";
import { useSpawnCapacity, type SpawnCapacityTarget } from "./useSpawnCapacity";
import { SessionIdentitySection } from "./SessionIdentitySection";
import {
  SessionTypeSelector,
  describeSessionType,
} from "./SessionTypeSelector";
import { PermissionModeSelector } from "./PermissionModeSelector";
import { SafeModeToggle } from "./SafeModeToggle";
import { CollapsibleLayer } from "./CollapsibleLayer";
import {
  MonitorIcon,
  GitHubIcon,
  RobotIcon,
  TerminalIcon,
} from "@/components/icons";
import {
  ScheduleSection,
  defaultScheduleState,
  type ScheduleState,
} from "./ScheduleSection";

/** Imperative handle exposed to the page header (expand/collapse-all button). */
export type NewSessionHandle = { toggleAll: () => void };

/** Aggregate expand state of the accordion sections, reported to the header so
 * its button can mirror the standard section chevron (all-expanded = down,
 * all-collapsed = right, mixed = unfold). */
export type ExpandState = "all" | "none" | "mixed";

export const NewSession = forwardRef<
  NewSessionHandle,
  {
    api: ApiClient;
    machines: Machine[];
    remoteNodes?: RemoteNode[];
    /** Local node identity (#1455) — used to resolve the default account. */
    localNode?: { nodeId: string; nodeLabel: string } | null;
    isLoading?: boolean;
    onSuccess: (sessionId: string, isRemote: boolean) => void;
    onCancel: () => void;
    onScheduleCreated?: () => void;
    /** Reports the aggregate section expand state to the page header. */
    onExpandStateChange?: (state: ExpandState) => void;
    /**
     * #3132 respawn pre-fill (from a capability-miss offer). `initialAgent`
     * pre-selects a capable harness; `pendingSkill` is the skill the offer
     * wanted to run — surfaced as a banner AND pre-filled into the schedule
     * prompt. (The standard spawn carries no initial message, so auto-running
     * the skill on a plain create is a documented seam — OR2/#3124.)
     */
    initialAgent?: AgentType;
    pendingSkill?: string;
  }
>(function NewSession(props, ref) {
  const { haptic } = usePlatform();
  const {
    spawnSession,
    isPending: spawnPending,
    error: spawnError,
  } = useSpawnSession(props.api);
  const { createSchedule, isPending: schedulePending } = useScheduleMutations(
    props.api
  );
  const { sessions } = useSessions(props.api);
  const { remoteSessions, localNode } = useFederatedSessions(props.api);
  const federationRefresh = usePollFederationRefresh(props.api);
  const isFormDisabled = Boolean(
    spawnPending || schedulePending || props.isLoading
  );

  // Issues claimed by a live session, keyed by `repo#number` — merges local
  // (useSessions) + remote (useFederatedSessions) halves (both, since the feed is remote-only) for the Link Issue picker (#1899, mirrors router.tsx).
  const claimedIssues = useMemo(() => {
    const enrichedLocal = localNode
      ? sessions.map(s => ({
          ...s,
          nodeId: localNode.nodeId,
          nodeLabel: localNode.nodeLabel,
        }))
      : sessions;
    return buildClaimedIssueIndex([...enrichedLocal, ...remoteSessions]);
  }, [sessions, remoteSessions, localNode]);

  // Issue #3515 (R4): when the previous optimistic spawn FAILED, the failure
  // handler stashed the user-entered Create form so this fresh mount repopulates
  // for a single-click retry. Consumed ONCE (lazy initializer) — a normal Create
  // navigation reads null. Each field's useState below prefers this snapshot,
  // and the directory/name refs below flip so the seed hooks don't clobber it.
  const [retryForm] = useState(() => takeRetryForm());

  // The raw select value includes prefix ("machine:xxx" or "node:yyy")
  const [selectedValue, setSelectedValue] = useState<string | null>(
    () => retryForm?.target ?? null
  );

  // Derive the typed spawn target from the select value
  const spawnTarget: SpawnTarget | null = useMemo(
    () => (selectedValue ? parseSpawnTarget(selectedValue) : null),
    [selectedValue]
  );

  const isRemoteTarget = spawnTarget?.kind === "remote";

  // Extract IDs for hooks — one will be set, the other null
  const localMachineId =
    spawnTarget?.kind === "local" ? spawnTarget.machineId : null;
  const remoteNodeId =
    spawnTarget?.kind === "remote" ? spawnTarget.nodeId : null;

  // #2533: the selected remote node (undefined for a local target / stale peer)
  // — one source of truth for its agent caps + advertised home dir.
  const selectedRemoteNode = useMemo(
    () =>
      isRemoteTarget && remoteNodeId
        ? props.remoteNodes?.find(n => n.nodeId === remoteNodeId)
        : undefined,
    [isRemoteTarget, remoteNodeId, props.remoteNodes]
  );
  const selectedNodeHomeDir = selectedRemoteNode?.homeDir;

  // #4417 (Task 8): advisory spawn-capacity notice for the selected target. A local
  // target polls the daemon; a remote target reads the federation summary fields. The
  // notice is rendered in the footer above the Create button; it never blocks spawning.
  const capacityTarget: SpawnCapacityTarget = useMemo(() => {
    if (spawnTarget?.kind === "local") return { kind: "local" };
    if (spawnTarget?.kind === "remote" && selectedRemoteNode)
      return { kind: "remote", node: selectedRemoteNode };
    return null;
  }, [spawnTarget, selectedRemoteNode]);
  const spawnCapacity = useSpawnCapacity(props.api, capacityTarget);

  const meterTargetLabel = useMemo(
    () => buildMeterTargetLabel(spawnTarget, props.remoteNodes),
    [spawnTarget, props.remoteNodes]
  );

  // Compute available agents for the selected target node OR local machine.
  // Issue #1081: local machines now carry agent capabilities in their metadata
  // (stamped by buildMachineMetadata via detectAgentCapabilities), mirroring
  // the existing remote-node pattern. Absence of `capabilities` (older machine
  // records that pre-date #1081) remains optimistic show-all.
  const availableAgents = useMemo((): AgentType[] | undefined => {
    if (selectedRemoteNode) {
      const caps = selectedRemoteNode.capabilities;
      if (!caps) return undefined; // No capability info: optimistic
      const agents = caps
        .filter(c => c.startsWith("agent:"))
        .map(c => c.slice("agent:".length) as AgentType);
      return agents.length > 0 ? agents : undefined;
    }
    if (localMachineId) {
      const machine = props.machines.find(m => m.id === localMachineId);
      const caps = machine?.metadata?.capabilities;
      if (!caps) return undefined; // No capability info: optimistic
      const agents = caps
        .filter(c => c.startsWith("agent:"))
        .map(c => c.slice("agent:".length) as AgentType);
      return agents.length > 0 ? agents : undefined;
    }
    return undefined;
  }, [selectedRemoteNode, localMachineId, props.machines]);

  // Issue #1733: does the selected target advertise gateway:openrouter? Mirrors
  // availableAgents' target resolution (remote node vs local machine caps).
  const supportsOpenRouter = useMemo((): boolean => {
    if (selectedRemoteNode) {
      return (
        selectedRemoteNode.capabilities?.includes("gateway:openrouter") ?? false
      );
    }
    if (localMachineId) {
      const machine = props.machines.find(m => m.id === localMachineId);
      return (
        machine?.metadata?.capabilities?.includes("gateway:openrouter") ?? false
      );
    }
    return false;
  }, [selectedRemoteNode, localMachineId, props.machines]);

  // Multi-account (#1455): account list + node default for the create-session
  // selector. Gated on !isRemoteTarget — remote spawns use the node default.
  const {
    accounts,
    envCredentialPresent,
    isLoading: accountsLoading,
  } = useAccounts(props.api, !isRemoteTarget);
  const [accountUuid, setAccountUuid] = useState<string | null>(null);
  // Issue #4568: a node-vault Anthropic API key picked as the session's credential
  // INSTEAD of an account (mutually exclusive — exactly one credential). Only a
  // user pick sets it: no auto-select, default or bookmark ever binds a key.
  // #4825 (RV2-8): the retry of a failed key spawn restores that pick — without
  // it the account default below would bind a subscription to the retry.
  const [apiKeyId, setApiKeyId] = useState<string | null>(
    () => retryForm?.apiKeyId ?? null
  );
  // #1496: the create-page account picker now opens the shared modal.
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  // #2019: GitHub account + repo pickers now open selection modals.
  const [githubAccountModalOpen, setGithubAccountModalOpen] = useState(false);
  const [githubRepoModalOpen, setGithubRepoModalOpen] = useState(false);
  // Distinguishes "not yet defaulted" from "user explicitly chose node-default".
  // A restored key pick (#4825) starts locked, as the original pick did.
  const accountInitializedRef = useRef(Boolean(retryForm?.apiKeyId));
  const handleAccountChange = (uuid: string | null) => {
    accountInitializedRef.current = true;
    setAccountUuid(uuid);
    // #4568: picking an account replaces a picked API key.
    setApiKeyId(null);
  };
  // Issue #4568: picking a key replaces the account and locks the account
  // auto-select out (accountInitializedRef), so no default can re-bind one.
  const handleApiKeyChange = (id: string) => {
    accountInitializedRef.current = true;
    setApiKeyId(id);
    setAccountUuid(null);
  };

  const {
    recentPaths,
    addRecentPath,
    removeRecentPath,
    getLastUsedMachineId,
    setLastUsedMachineId,
  } = useRecentPaths(props.api, localMachineId, remoteNodeId);
  const [directory, setDirectory] = useState(() => retryForm?.directory ?? "");
  // #2269 (F18): the server exposes its daemon-user home as the Directory fallback for a
  // fresh instance with no recent paths (e.g. /home/hapimatic on a new user VM).
  const { data: versionInfo } = useVersion();
  // Issue #1953 (A6): GitHub-account → repo → clone-on-spawn selection. The
  // selected account is the host `gh` identity; `cloneRepo` is "owner/repo" (or
  // null when no repo is chosen). Standard mode only (R10).
  const [githubAccount, setGithubAccount] = useState<string | null>(null);
  const [cloneRepo, setCloneRepo] = useState<string | null>(null);
  // #3558: the SAME value, updated synchronously by applyCloneRepo (the only
  // writer). The Git Type guards read this ref, not the state: the defaults
  // engine applies every bookmark in ONE effect loop through one render's
  // setters, so a guard closed over the `cloneRepo` state would still see the
  // pre-loop value when `repo` is restored before `gitType`.
  const cloneRepoRef = useRef<string | null>(null);
  // #3558: the session mode, updated synchronously by applySessionMode (the only
  // writer) for the same reason — the clone lock is Standard-only, and a
  // restore can set `sessionMode` in the same loop as `repo` / `gitType`.
  const sessionModeRef = useRef<SessionMode>("standard");
  // #3558: the Git Type a bookmark restore ASKED for. A restored clone repo
  // coerces it to Basic; if repo auto-detection then clears that restored repo
  // (the defaults engine's precedence effect), the saved Git Type applies
  // again. Any user interaction with Git Type, the repo or the target clears it.
  const restoredGitTypeRef = useRef<SessionType | null>(null);
  // Distinguishes "not yet defaulted" from "user explicitly chose an account
  // (including None)". The default pre-selects the host gh identity so the
  // GitHub Account field is never "None" by default (per the locked V1 mock-up,
  // which shows MattStarfield). Reset on machine change so it re-defaults.
  const githubAccountUserEditedRef = useRef(false);
  // #3132: a respawn offer pre-selects a capable harness; default "claude".
  const [agent, setAgent] = useState<AgentType>(
    () => retryForm?.agent ?? props.initialAgent ?? "claude"
  );
  // #3808 Task 5: the account selector + node-default read are scoped to the
  // spawn's provider — codex → openai, gemini → google, else the Anthropic default
  // (undefined ⇒ the 2-element node-default key, byte-identical for claude/opencode).
  // Read here (after `agent`) so the pre-selected default + the modal list match the
  // chosen harness's provider. `activeAccount`/`nodeAccountLoading` are first used
  // below, so relocating the hook here preserves stable hook order.
  const accountSelectorProvider =
    agent === "codex" ? "openai" : agent === "gemini" ? "google" : undefined;
  const { activeAccount, isLoading: nodeAccountLoading } = useNodeActiveAccount(
    props.api,
    props.localNode?.nodeId ?? null,
    !isRemoteTarget,
    accountSelectorProvider
  );
  // Issue #1733: selected OpenRouter model id ("" = none → no OpenRouter
  // routing; the Codex session uses its own ChatGPT auth).
  const [selectedModel, setSelectedModel] = useState<string>("");
  // #1951 A4: the spawn-time permission mode replaces the binary YOLO toggle.
  // Initialized from the user's saved default (resolved to a valid mode for the
  // current agent flavor); collapsed to the wire `yolo` boolean in formState.
  const { prefs: adminPrefs } = useAdminPreferences();
  // #2042 (A4): the usage envelope carries each account's `score` (from #2039),
  // used to auto-select the most-underutilized account on create. Gated on the
  // preference so OFF performs zero fetch/poll — a true no-op (R2).
  const { usage: accountUsage, isLoading: accountUsageLoading } =
    useAccountUsage(
      props.api,
      !isRemoteTarget && adminPrefs.autoSelectOptimalAccount
    );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() =>
    resolveSpawnPermissionMode(adminPrefs.defaultSpawnPermissionMode, agent)
  );
  // Keep the selected mode valid for the chosen agent. On an agent change,
  // re-resolve only when the current mode is not in the new flavor's option set
  // (preserves an explicit in-flavor selection; maps a yolo-equivalent default
  // across flavors via resolveSpawnPermissionMode — R4).
  useEffect(() => {
    setPermissionMode(prev => {
      const valid = getSpawnPermissionModeOptionsForFlavor(agent).map(
        o => o.mode
      );
      return valid.includes(prev)
        ? prev
        : resolveSpawnPermissionMode(
            adminPrefs.defaultSpawnPermissionMode,
            agent
          );
    });
  }, [agent, adminPrefs.defaultSpawnPermissionMode]);
  // #2456: the create-page Model+Effort row uses the live full catalog (rawModel
  // / effort, "" = Default; Claude-only). modelMode stays "default" — the #2434
  // family pin is subsumed by the catalog; formState omits unset pins so an
  // untouched form spawns byte-identically.
  const [modelMode] = useState<ModelMode>("default");
  const [rawModel, setRawModel] = useState("");
  const [effort, setEffort] = useState<EffortLevel | "">("");
  // Issue #3348: gemini native model ("" = Auto), codex ChatGPT-token model
  // ("" = Default), codex reasoning effort ("" = default). Only the picker for
  // the current agent's native catalog renders (deriveFormState gates them via
  // the manifest axis).
  const [selectedGeminiModel, setSelectedGeminiModel] = useState("");
  const [selectedCodexModel, setSelectedCodexModel] = useState("");
  const [selectedCodexEffort, setSelectedCodexEffort] = useState("");
  // Issue #3349: opencode native provider (a #1955 vault provider string) +
  // model id. Only the opencode native picker renders these (deriveFormState
  // gates it via the manifest `opencode-native` catalog + dual-source exclusion).
  const [selectedOpencodeProvider, setSelectedOpencodeProvider] = useState("");
  const [selectedOpencodeModel, setSelectedOpencodeModel] = useState("");
  // Issue #3349: the node's redacted API-key vault feeds the opencode native
  // provider selector (provider names/labels only — never the secret). Issue
  // #4568: it also feeds the Claude credential picker's "API keys" section on a
  // LOCAL target (a node's keys never bind a remote session). Fetched only for
  // those consumers to avoid a needless request otherwise.
  const { data: vaultKeys } = useApiKeys(props.api, {
    enabled: agent === "opencode" || (agent === "claude" && !isRemoteTarget),
  });
  // Issue #4568: the Anthropic keys a Claude session can bill, and the picked
  // one's vault entry (its label). A key deleted mid-form has no entry here, but
  // its id is still sent (SF-2) so the daemon refuses with api_key_not_found
  // instead of the spawn falling back to the node's default account.
  const anthropicKeys = useMemo(
    () => (vaultKeys ?? []).filter(k => k.provider === "anthropic"),
    [vaultKeys]
  );
  const pickedApiKey = useMemo(
    () => (apiKeyId ? anthropicKeys.find(k => k.id === apiKeyId) : undefined),
    [apiKeyId, anthropicKeys]
  );
  // Issue #1633: Safe Mode spawn toggle (default OFF) — claude --safe-mode
  const [safeMode, setSafeMode] = useState(false);
  // #1660: per-session launcher override — extracted to useLauncherSelection
  // (#2930). `globalDefaultLauncher` is returned because the spawn-command
  // assembly reads it (its `!== globalDefault` omit rule); `setLauncher` is
  // touch-marking (guards the async default sync).
  const { launcher, globalDefaultLauncher, setLauncher } =
    useLauncherSelection();
  // #2626 (D): per-session output style — extracted to useOutputStyleSelection
  // (#2930). The hook owns the catalog query, saved-default pre-fill, and touch
  // guard; the returned `setOutputStyle` is touch-marking (see the hook doc).
  const { outputStyle, outputStyles, setOutputStyle } = useOutputStyleSelection(
    props.api
  );
  const [sessionType, setSessionType] = useState<SessionType>(
    () => retryForm?.sessionType ?? "simple"
  );
  // #3273: Basic ("simple") is the default Git Type for every fresh form. This RAW value
  // is what the saved-defaults engine snapshots (`gitType: sessionType` below), so raw ==
  // effective and the Git Type bookmark stores exactly what the control shows; Worktree
  // stays selectable (explicit pick or restored bookmark, both set the flag below). The
  // #2270 (F25) seam in formState.ts is unchanged (non-git + not user-selected → simple).
  const [sessionTypeUserSelected, setSessionTypeUserSelected] = useState(
    () => retryForm?.sessionTypeUserSelected ?? false
  );
  // #3558: the ONE writer of the clone-on-spawn repo (manual pick, bookmark
  // restore, target/account resets). #1953 A6 (KEY DECISION #3): a clone is a
  // complete checkout — run a SIMPLE session in it, not a worktree — so setting
  // a repo also forces the RAW Git Type to Simple. Raw == effective keeps the
  // preview, the payload and the Git Type bookmark indicator honest; the daemon
  // force-simples every clone regardless.
  const applyCloneRepo = useCallback((repo: string | null) => {
    cloneRepoRef.current = repo;
    setCloneRepo(repo);
    if (cloneLockFor(repo, sessionModeRef.current)) setSessionType("simple");
  }, []);
  const [worktreeName, setWorktreeName] = useState(
    () => retryForm?.worktreeName ?? ""
  );
  const [sessionEmoji, setSessionEmoji] = useState<string | null>(
    () => retryForm?.emoji ?? null
  );
  const [sessionName, setSessionName] = useState(() => retryForm?.name ?? "");
  const [linkedIssue, setLinkedIssue] = useState<LinkedIssue | null>(
    () => retryForm?.linkedIssue ?? null
  );
  // #3515 (R4): a restored name is a user-authored value — mark it edited so the
  // linked-issue auto-populate never clobbers it on the retry mount.
  const hasUserEditedName = useRef(Boolean(retryForm?.name));
  const hasUserEditedBranch = useRef(Boolean(retryForm?.worktreeName));
  const scrollStackRef = useRef<HTMLDivElement>(null);
  useKeyboardAwareFieldFocus(scrollStackRef);
  const [error, setError] = useState<string | null>(null);

  // Directory removal confirmation
  // Session mode: standard (interactive) vs scheduled (automated)
  const [sessionMode, setSessionMode] = useState<SessionMode>("standard");
  // #3558: the ONE writer of the session mode. Returning to Standard with a
  // clone repo still selected re-locks Git Type to Simple (raw == effective).
  const applySessionMode = useCallback((mode: SessionMode) => {
    sessionModeRef.current = mode;
    setSessionMode(mode);
    if (cloneLockFor(cloneRepoRef.current, mode)) setSessionType("simple");
  }, []);
  // Issue #4568 (SF-1): the API-key option is offered only where it is honoured
  // — a Standard Claude session. CreateScheduledTaskRequest carries no key or
  // account, so in Scheduled mode the option would be shown and then ignored.
  // A key picked in Standard mode is hidden and left out of the spawn input (and
  // the SDK lock) while Scheduled is selected, and comes back on return to
  // Standard. Clearing it instead would strand the form with no credential: the
  // key pick locked the account default out (accountInitializedRef).
  const apiKeysOffered = agent === "claude" && sessionMode === "standard";

  // Schedule state
  // #3132: a respawn offer carries the pending skill intent — pre-fill it as the
  // schedule prompt so a scheduled run would invoke it (the one prompt affordance
  // the create flow has; the standard spawn has no initial-message field).
  const [scheduleState, setScheduleState] = useState<ScheduleState>(() =>
    props.pendingSkill
      ? { ...defaultScheduleState, prompt: `/${props.pendingSkill}` }
      : defaultScheduleState
  );

  // Issue #1953 (A6) / #2327: GitHub accounts + repos for the clone-on-spawn
  // selector. Standard mode only (R10); federation-aware via remoteNodeId.
  const {
    accounts: githubAccounts,
    accountsLoading: githubAccountsLoading,
    accountsUnavailable: githubAccountsUnavailable,
    accountsReason: githubAccountsReason,
    repos: githubRepos,
    reposLoading: githubReposLoading,
    issues: repoIssues,
    detectedRepo,
    issuesLoading,
    issuesUnavailable,
    directoryIsGitRepo,
  } = useGitHubSection({
    api: props.api,
    nodeId: remoteNodeId,
    enabled: sessionMode === "standard",
    account: githubAccount,
    directory,
  });

  // #3558: auto-detection owns the Repo field. When the directory is already a
  // repo checkout — e.g. the `~/projects/<name>` destination of a clone pick
  // that already exists — drop the clone selection: the daemon never clones
  // into a non-empty folder, so a kept `--clone` would be a no-op the page
  // hides behind the read-only detected repo, and Worktree would stay locked.
  // (A RESTORED repo is also cleared by the defaults engine's precedence
  // effect; both go through the idempotent applyCloneRepo.)
  useEffect(() => {
    if (detectedRepo != null && cloneRepoRef.current) applyCloneRepo(null);
  }, [detectedRepo, applyCloneRepo]);

  // hapimatic-private#4481: the Branch control (both Git Types). `markTouched`
  // comes from the defaults engine further down, which itself needs this hook's
  // listing — bridge it through a ref (assigned after the engine is created).
  const markTouchedRef = useRef<(id: string) => void>(() => {});
  const branchSel = useBranchSelection({
    api: props.api,
    directory,
    nodeId: remoteNodeId,
    sessionMode,
    sessionType,
    setSessionType,
    setSessionTypeUserSelected,
    markTouched: id => markTouchedRef.current(id),
    cloneLocked: cloneLockFor(cloneRepo, sessionMode) != null,
    directoryIsGitRepo,
    initialExistingBranch: retryForm?.existingBranch,
  });

  // Auto-select a local machine once machines load (last-used, else first) —
  // extracted to useAutoSelectMachine (#2930).
  useAutoSelectMachine({
    machines: props.machines,
    localMachineId,
    isRemoteTarget,
    getLastUsedMachineId,
    setSelectedValue,
  });

  // Default the account selection (#1455, extended #1496). Runs once; an
  // explicit user choice (handleAccountChange) locks it. Prefers the node's
  // active (default) account; if the node has no default once the lookup
  // settles, pre-selects the first stored account so an account is always bound
  // when ≥1 exists (R3 "(no default)" + R7 always-bind).
  useEffect(() => {
    if (isRemoteTarget) return;
    if (accountInitializedRef.current) return;

    // #3808 Task 5: the pre-selection must draw only from the SELECTED provider's
    // accounts. `GET /api/accounts` spans providers (anthropic | openai | google),
    // so an unscoped `accounts[0]` fallback would bind a cross-provider (e.g.
    // Anthropic) account to a codex/gemini spawn — the exact stale-uuid leak the
    // provider-reset effect below exists to prevent. A row with no `provider` reads
    // as anthropic (mirrors AccountSelectorModal's `targetProvider`).
    const scopedAccounts = accounts.filter(
      a =>
        (a.provider ?? "anthropic") === (accountSelectorProvider ?? "anthropic")
    );

    // #2042 (A4) auto-select fast-path: when the preference is ON, pre-select the
    // lowest-score (most-underutilized) healthy account. Wait for usage to settle,
    // then fall THROUGH to the existing default if no scored account is available
    // (Fallback Preservation Rule — R4). A user's explicit pick still wins via the
    // accountInitializedRef lock above (R5).
    if (adminPrefs.autoSelectOptimalAccount) {
      if (accountUsageLoading) return; // re-runs when usage settles
      const optimal = selectOptimalAccountUuid(scopedAccounts, accountUsage);
      if (optimal) {
        setAccountUuid(optimal);
        accountInitializedRef.current = true;
        return;
      }
      // No eligible (ok + finite-score) account → fall through to the default.
    }

    if (activeAccount) {
      setAccountUuid(activeAccount.accountUuid);
      accountInitializedRef.current = true;
    } else if (!nodeAccountLoading && scopedAccounts.length > 0) {
      setAccountUuid(scopedAccounts[0].accountUuid);
      accountInitializedRef.current = true;
    }
  }, [
    activeAccount,
    nodeAccountLoading,
    accounts,
    accountSelectorProvider,
    isRemoteTarget,
    adminPrefs.autoSelectOptimalAccount,
    accountUsageLoading,
    accountUsage,
  ]);

  // #3808 Task 5: when the spawn's PROVIDER changes (an agent switch), reset the
  // account pre-selection so the next default resolves to the NEW provider's account
  // — a stale cross-provider uuid must never leak into the spawn. Ref-guarded so it
  // is a no-op on the initial render (does not clobber the first pre-selection).
  const prevAccountProviderRef = useRef(accountSelectorProvider);
  useEffect(() => {
    if (prevAccountProviderRef.current !== accountSelectorProvider) {
      prevAccountProviderRef.current = accountSelectorProvider;
      accountInitializedRef.current = false;
      setAccountUuid(null);
      // #4568: a key is a Claude credential — a provider change drops it too.
      setApiKeyId(null);
    }
  }, [accountSelectorProvider]);

  // Default the GitHub account to the host gh identity (first available) once
  // accounts load, unless the user has explicitly chosen one. Keeps "None" off
  // as the default (the V1 mock-up shows the account pre-selected).
  useEffect(() => {
    if (sessionMode !== "standard") return;
    if (githubAccountUserEditedRef.current) return;
    if (githubAccount) return;
    if (githubAccounts.length > 0) {
      setGithubAccount(githubAccounts[0].login);
    }
  }, [githubAccounts, githubAccount, sessionMode]);

  // Pre-populate the Directory field until the user edits it (recents > node
  // home > hub default; #2533 adds the node tier). The ref stays here — the
  // directory/clone handlers flip it and target-change resets it.
  // #3515 (R4): a restored directory is a user-authored value — mark it edited so
  // useDirectorySeed does not overwrite it on the retry mount.
  const hasUserEditedDirectory = useRef(Boolean(retryForm?.directory));
  useDirectorySeed({
    hasUserEdited: hasUserEditedDirectory,
    recentPaths,
    nodeHomeDir: selectedNodeHomeDir,
    defaultDirectory: versionInfo?.defaultDirectory,
    setDirectory,
  });

  // Directory path-existence (recents + session dirs) checked against the
  // selected target, with stale-recents auto-prune — extracted to
  // usePathExistence (#2930).
  const pathExistence = usePathExistence({
    api: props.api,
    localMachineId,
    remoteNodeId,
    sessions,
    recentPaths,
    removeRecentPath,
  });

  // #1950 A3: the conditional field-state engine. One pure derivation computes
  // per-field gray-out/relabel (`fields`) AND the agent-gated resolved selections
  // (`effective`). It is the single source the layout reads for each field's
  // disabled/label, and the source the spawn payload below is assembled from — so
  // no ad-hoc per-component conditionals remain (R1).
  const formState = useMemo(
    () =>
      deriveFormState({
        agent,
        sessionType,
        isRemoteTarget,
        isFormDisabled,
        directoryHasGitRepo: detectedRepo != null,
        // #2270 (F25): true git-ness tri-state + explicit-choice flag drive the
        // effective-session-type default at the derivation seam.
        directoryIsGitRepo,
        sessionTypeUserSelected,
        // #3558: a clone-on-spawn repo forces simple + disables Worktree —
        // Standard mode only (a scheduled task never clones).
        cloneRepo: cloneLockFor(cloneRepo, sessionMode),
        permissionMode,
        safeMode,
        launcher,
        worktreeName,
        // #4481: the Branch control's existing-branch pick (Worktree only).
        existingBranch: branchSel.existingBranch,
        accountUuid,
        accountsCount: accounts.length,
        // #4568 (SF-2): the picked key id, even when the key has since left the
        // vault — the daemon then refuses with api_key_not_found instead of the
        // spawn silently falling back to the node default.
        apiKeyId: apiKeysOffered ? apiKeyId : null,
        agentSupportsOpenRouter: supportsOpenRouter,
        selectedModelMode: modelMode,
        selectedEffort: effort,
        selectedRawModel: rawModel,
        selectedModel,
        // #3348: gemini/codex native model + codex effort selections.
        selectedGeminiModel,
        selectedCodexModel,
        selectedCodexEffort,
        // #3349: opencode native provider + model selections.
        selectedOpencodeProvider,
        selectedOpencodeModel,
      }),
    [
      agent,
      effort,
      rawModel,
      selectedGeminiModel,
      selectedCodexModel,
      selectedCodexEffort,
      selectedOpencodeProvider,
      selectedOpencodeModel,
      sessionType,
      isRemoteTarget,
      isFormDisabled,
      detectedRepo,
      directoryIsGitRepo,
      sessionTypeUserSelected,
      cloneRepo,
      sessionMode,
      permissionMode,
      safeMode,
      launcher,
      worktreeName,
      branchSel.existingBranch,
      accountUuid,
      accounts.length,
      apiKeysOffered,
      apiKeyId,
      supportsOpenRouter,
      modelMode,
      selectedModel,
    ]
  );

  // #1949 A2 ⟷ #1950 A3: the canonical spawn-relevant selections — the ONE source
  // shared by the live command preview AND the real spawn payload (buildSpawnInput).
  // A3 feeds the agent-gated `formState.effective` values in here (safeMode /
  // launcher / accountUuid nulled for non-Claude); A2's buildSpawnInput then applies
  // the wire-format omission, so a non-Claude null becomes an omitted field. The
  // preview, the spawn, and the field-state engine therefore can never derive
  // divergent semantics (R6/R7). The Claude path is byte-identical to pre-A3:
  // `effective` returns the raw values unchanged when `agent === "claude"`.
  const spawnSelections = useMemo<SpawnSelections>(
    () => ({
      target: spawnTarget,
      directory,
      agent: formState.effective.agent,
      yolo: formState.effective.yolo,
      safeMode: formState.effective.safeMode,
      // effective.launcher is undefined for non-Claude → fall back to the global
      // default so buildSpawnInput omits `launcher` (its `!== globalDefault` rule).
      launcher: formState.effective.launcher ?? globalDefaultLauncher,
      globalDefaultLauncher,
      // #2270 (F25): the EFFECTIVE session type (never diverges from the preview).
      sessionType: formState.effective.sessionType,
      // worktreeName stays raw — buildSpawnInput trims + gates it on the
      // effective sessionType (equivalent to effective.worktreeName).
      worktreeName,
      // #4481: gated by formState (effective Worktree only).
      existingBranch: formState.effective.existingBranch,
      name: sessionName,
      accountUuid: formState.effective.accountUuid ?? null,
      hasStoredAccounts: accounts.length > 0,
      // #4568: the API-key binding — Standard mode only (apiKeysOffered), then
      // gated by formState.effective (Claude + local + a picked key id, which may
      // have left the vault); buildSpawnInput sends it INSTEAD of accountUuid.
      apiKeyId: formState.effective.apiKeyId,
      // #1733/#1950 A3: model is agent-gated by formState.effective (codex +
      // openrouter + selection, OR the opencode native `provider/model`);
      // buildSpawnInput omits it when undefined.
      model: formState.effective.model,
      // #3349 (D4(a)): native-vs-OpenRouter routing discriminator — agent-gated
      // by formState.effective ("native" only for the opencode native picker);
      // buildSpawnInput omits it otherwise (byte-identical OpenRouter spawn).
      modelRouting: formState.effective.modelRouting,
      // #2434/#2456: Claude model-mode / effort / raw-model pins — agent-gated
      // by formState.effective; omitted when unset (byte-identical spawn).
      modelMode: formState.effective.modelMode,
      effort: formState.effective.effort,
      rawModel: formState.effective.rawModel,
      // #3348: gemini/codex native model + codex effort — agent-gated by
      // formState.effective; buildSpawnInput bundles them into the single
      // `nativeModelSelection` wire field (omitted for claude/OpenRouter/opencode).
      geminiModel: formState.effective.geminiModel,
      codexModel: formState.effective.codexModel,
      codexReasoningEffort: formState.effective.codexReasoningEffort,
      // #1953 A6: clone-on-spawn repo (standard mode only — the selector is not
      // rendered for scheduled runs, so this stays null there). buildSpawnInput
      // omits it when null/empty so non-repo spawns are byte-identical (R12).
      cloneRepo,
      // #2626 (D): per-session output style (raw value). buildSpawnInput gates
      // it — claude-only + omit when "default"/empty — so non-claude/default
      // spawns stay byte-identical (R2).
      outputStyle,
    }),
    [
      spawnTarget,
      directory,
      formState,
      globalDefaultLauncher,
      worktreeName,
      sessionName,
      accounts.length,
      cloneRepo,
      outputStyle,
    ]
  );

  // Display-only enrichment for the preview (humanizes opaque ids — machine/node
  // id → label, account uuid → email). Never changes WHICH flags render, only
  // their displayed value.
  const spawnDisplay = useMemo<SpawnDisplayContext>(
    () => ({
      machineLabel: isRemoteTarget ? undefined : meterTargetLabel,
      nodeLabel: isRemoteTarget ? meterTargetLabel : undefined,
      accountEmail:
        accounts.find(a => a.accountUuid === accountUuid)?.emailAddress ??
        undefined,
      // #4568: name the bound key by label / mask in the preview — never the key.
      apiKeyLabel: pickedApiKey ? apiKeyDisplayName(pickedApiKey) : undefined,
    }),
    [isRemoteTarget, meterTargetLabel, accounts, accountUuid, pickedApiKey]
  );

  // Create-page saved defaults (bookmark feature) — see useCreateDefaultsEngine.
  // Restore setter lambdas ALSO set the "user edited" guards a real interaction
  // would, so the auto-default effects never clobber a restored value.
  const { defaultsApi, markTouched, handleScheduleChange } =
    useCreateDefaultsEngine({
      api: props.api,
      values: {
        federationNode: selectedValue,
        directory,
        cliHarness: agent,
        account: accountUuid,
        launcher,
        model: rawModel,
        effort,
        outputStyle,
        openrouterModel: selectedModel,
        githubAccount,
        repo: cloneRepo,
        gitType: sessionType,
        sessionName,
        branchName: worktreeName,
        branch: branchSel.choice,
        permissionMode,
        safeMode,
        sessionMode,
      },
      scheduleState,
      data: {
        machines: props.machines,
        remoteNodes: props.remoteNodes,
        accounts,
        repoAutoDetected: detectedRepo != null,
        branchListing: branchSel.listing,
        branchListingUnavailable: branchSel.listingUnavailable,
      },
      set: {
        federationNode: setSelectedValue,
        directory: v => {
          hasUserEditedDirectory.current = true;
          setDirectory(v);
        },
        cliHarness: setAgent,
        account: v => {
          accountInitializedRef.current = true;
          setAccountUuid(v);
          // #4568: a restored account replaces a picked key (one credential).
          setApiKeyId(null);
        },
        launcher: setLauncher,
        model: setRawModel,
        effort: setEffort,
        outputStyle: setOutputStyle,
        openrouterModel: setSelectedModel,
        githubAccount: v => {
          githubAccountUserEditedRef.current = true;
          setGithubAccount(v);
        },
        // #3558: a restored repo goes through the same force as a manual pick
        // (no touch mark, no directory pre-fill); a restored Worktree is coerced
        // while a clone is selected — read via the ref (order-independent).
        repo: v => {
          applyCloneRepo(v);
          // Auto-detection clearing a RESTORED repo hands the saved Git Type back.
          if (v === null && restoredGitTypeRef.current) {
            setSessionType(restoredGitTypeRef.current);
          }
        },
        gitType: v => {
          restoredGitTypeRef.current = v;
          setSessionTypeUserSelected(true);
          setSessionType(
            coerceGitTypeForClone(
              cloneLockFor(cloneRepoRef.current, sessionModeRef.current),
              v
            )
          );
        },
        sessionName: v => {
          hasUserEditedName.current = true;
          setSessionName(v);
        },
        branchName: v => {
          hasUserEditedBranch.current = true;
          setWorktreeName(v);
        },
        // #4481: a restored Branch choice — never while a clone locks Basic.
        branch: v => {
          if (cloneLockFor(cloneRepoRef.current, sessionModeRef.current))
            return;
          restoredGitTypeRef.current = null;
          branchSel.selectBranch(v, { restore: true });
        },
        permissionMode: setPermissionMode,
        safeMode: setSafeMode,
        // #3558: a restored Scheduled mode drops the clone lock, so a Git Type
        // the same restore coerced to Basic is handed back (order-independent).
        sessionMode: v => {
          applySessionMode(v);
          if (v !== "standard" && restoredGitTypeRef.current) {
            setSessionType(restoredGitTypeRef.current);
          }
        },
        schedule: partial =>
          setScheduleState(prev => ({ ...prev, ...partial })),
      },
    });

  markTouchedRef.current = markTouched;

  // #3132: a respawn pre-selection (`initialAgent`) is an explicit intent, so
  // protect it from a saved `cliHarness` bookmark default — mark the field
  // touched on mount so the defaults engine's restore pass skips it (the engine
  // makes touched fields immune to saved defaults). The store hydrates async, so
  // this runs before the restore pass seeds. Mount-only.
  useEffect(() => {
    if (props.initialAgent) markTouched("cliHarness");
    // #4825 (RV2-8): a retried key spawn keeps its key — a saved `account`
    // bookmark would replace it, so the account field is protected the same way.
    if (retryForm?.apiKeyId) markTouched("account");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMachineChange = useCallback(
    (newValue: string) => {
      markTouched("federationNode");
      setSelectedValue(newValue);
      hasUserEditedDirectory.current = false;
      setDirectory("");
      setLinkedIssue(null);
      // #1953 A6: reset the clone-on-spawn selection when the target changes — the
      // account + repos are resolved per spawn-target node. Clear the user-edited
      // flag so the GitHub account re-defaults to the new target's host identity.
      setGithubAccount(null);
      restoredGitTypeRef.current = null;
      applyCloneRepo(null);
      githubAccountUserEditedRef.current = false;
      hasUserEditedName.current = false;
      hasUserEditedBranch.current = false;
      // #3273: reset Git Type to the Basic default when switching targets
      setSessionType("simple");
      // #2270 (F25): a fresh target re-evaluates git-ness from scratch — clear the
      // explicit-choice flag so the non-git `simple` default applies again.
      setSessionTypeUserSelected(false);
      // Reset session mode to standard (scheduled not supported on remote targets)
      applySessionMode("standard");
    },
    [markTouched, applyCloneRepo, applySessionMode]
  );

  // Issue #1953 (A6): clone-on-spawn selection handlers.
  const handleGithubAccountChange = useCallback(
    (login: string | null) => {
      markTouched("githubAccount");
      markTouched("repo");
      githubAccountUserEditedRef.current = true;
      setGithubAccount(login);
      restoredGitTypeRef.current = null;
      applyCloneRepo(null); // reset the repo selection when the account changes
    },
    [markTouched, applyCloneRepo]
  );

  const handleCloneRepoChange = useCallback(
    (repo: GitHubRepo | null) => {
      markTouched("repo");
      restoredGitTypeRef.current = null;
      if (!repo) {
        applyCloneRepo(null);
        return;
      }
      // #1953 A6 (KEY DECISION #3): applyCloneRepo also forces Git Type → Simple
      // so the live preview and the spawn payload match the daemon.
      applyCloneRepo(repo.nameWithOwner);
      // The web derives the clone-destination directory (the daemon stays dumb and
      // clones into the provided directory). MVP base: ~/projects/<repoName>.
      hasUserEditedDirectory.current = true;
      setDirectory(`~/projects/${repo.name}`);
      setLinkedIssue(null);
    },
    [markTouched, applyCloneRepo]
  );

  const handleDirectoryChange = useCallback(
    (value: string) => {
      markTouched("directory");
      hasUserEditedDirectory.current = true;
      setDirectory(value);
      // Clear linked issue when directory changes (repo may differ)
      setLinkedIssue(null);
    },
    [markTouched]
  );

  async function handleCreate() {
    setError(null);

    if (sessionMode === "scheduled") {
      return handleCreateSchedule();
    }

    return handleCreateSession();
  }

  async function handleCreateSession() {
    if (!spawnTarget || !directory.trim()) return;
    if (pathExistence[directory.trim()] === false) return;

    // For remote targets, add a pending spawn stub immediately for instant
    // visual feedback. The stub appears in the session list before the API
    // call returns and persists until the real session appears via federation
    // poll (or times out / fails).
    let pendingSpawnId: string | undefined;
    let spawnCorrelationId: string | undefined;
    if (isRemoteTarget && spawnTarget.kind === "remote") {
      const nodeLabel =
        props.remoteNodes?.find(n => n.nodeId === spawnTarget.nodeId)
          ?.nodeLabel ?? spawnTarget.nodeId;
      // Generate a correlation ID for reliable stub-to-session matching (issue #933)
      spawnCorrelationId = crypto.randomUUID();
      pendingSpawnId = addPendingSpawn({
        nodeId: spawnTarget.nodeId,
        nodeLabel,
        directory: directory.trim(),
        name: sessionName.trim() || undefined,
        emoji: sessionEmoji ?? undefined,
        agent,
        spawnCorrelationId,
      });
    }

    try {
      // #1949 A2: build the spawn payload from the SAME canonical selections the
      // live preview renders from (buildSpawnInput), so preview ⟷ spawn cannot
      // diverge (R4). buildSpawnInput reproduces the field-omission rules
      // (#1633 safeMode, #1660 launcher, #1262/#1683 claimPort, worktreeName,
      // #1496 R7 accountUuid) byte-for-byte. Runtime-only fields (emoji,
      // spawnCorrelationId) are merged here — they never live in SpawnSelections
      // and never surface in the preview.
      const result = await spawnSession({
        // #1950 A3: model now flows through buildSpawnInput via spawnSelections
        // (formState.effective.model, gated on codex + openrouter + selection),
        // so the live preview and the real spawn read it from ONE source — the
        // #1733-documented follow-up. Only runtime-only fields are merged here.
        ...buildSpawnInput(spawnSelections),
        emoji: sessionEmoji ?? undefined,
        spawnCorrelationId,
        // Issue #3515: LOCAL spawns opt into the early-ack optimistic path so the
        // UI lands on a live placeholder screen before the daemon spawn resolves.
        // Remote spawns (spawnOnNode) ignore this — remote parity is descoped (D4).
        earlyReturn: !isRemoteTarget,
      });

      // Issue #3515: LOCAL optimistic path — the server accepted the spawn and
      // answered with the placeholder id (= the future session TAG, 3515-1)
      // before the daemon spawn resolved. Navigate to the live placeholder NOW;
      // emoji + linkedIssue (NOT carried in the local spawn body) + the typed
      // draft are handed to the real uuid at the swap, and the primary form
      // fields are snapshotted for a single-click retry on failure (R1/R3/R4).
      if (result.type === "accepted") {
        haptic.notification("success");
        if (spawnTarget.kind === "local") {
          setLastUsedMachineId(spawnTarget.machineId);
        }
        beginSpawnHandover(result.sessionId, {
          emoji: sessionEmoji,
          linkedIssue,
          form: {
            directory: directory.trim(),
            target: selectedValue,
            name: sessionName,
            emoji: sessionEmoji,
            linkedIssue,
            agent,
            sessionType,
            sessionTypeUserSelected,
            worktreeName,
            existingBranch: branchSel.existingBranch,
            // #4825 (RV2-8): the same key the spawn payload carried.
            apiKeyId: apiKeysOffered ? apiKeyId : null,
          },
        });
        addRecentPath(directory.trim());
        props.onSuccess(result.sessionId, false); // isRemote=false (local placeholder)
        return;
      }

      if (result.type === "success") {
        haptic.notification("success");

        if (spawnTarget.kind === "local") {
          setLastUsedMachineId(spawnTarget.machineId);

          // Set optional session properties after local spawn
          // (remote spawns apply name/emoji on the node side via federation body)
          // Use resolvedName if the daemon deduplicated it (issue #816),
          // otherwise use the user-provided name from the form.
          const finalName = result.resolvedName ?? sessionName.trim();
          if (finalName) {
            await props.api.renameSession(result.sessionId, finalName);
          }
          if (sessionEmoji) {
            await props.api.updateSessionEmoji(result.sessionId, sessionEmoji);
          }
        }

        // Link issue after spawn — only if we have a valid sessionId.
        // Remote spawns return empty sessionId (fire-and-forget).
        if (linkedIssue && result.sessionId) {
          await props.api.updateSessionLinkedIssue(
            result.sessionId,
            linkedIssue
          );
        }

        // Save recent path for both local and remote targets
        addRecentPath(directory.trim());

        props.onSuccess(result.sessionId, isRemoteTarget);
        return;
      }

      haptic.notification("error");
      setError(result.message);
      // Mark stub as failed if API returned a non-success response
      if (pendingSpawnId) {
        markSpawnFailed(pendingSpawnId, result.message);
      }
    } catch (e) {
      haptic.notification("error");
      const msg = e instanceof Error ? e.message : "Failed to create session";
      setError(msg);
      // Mark stub as failed on network/unexpected errors
      if (pendingSpawnId) {
        markSpawnFailed(pendingSpawnId, msg);
      }
    }
  }

  async function handleCreateSchedule() {
    const s = scheduleState;
    const dir = directory.trim();

    if (!dir) {
      setError("Directory is required");
      return;
    }
    if (!s.prompt.trim()) {
      setError("Prompt is required");
      return;
    }

    const scheduleName =
      sessionName.trim() ||
      dir.split("/").filter(Boolean).pop() ||
      "Scheduled Task";

    const input: CreateScheduledTaskRequest = {
      name: scheduleName,
      emoji: sessionEmoji ?? undefined,
      prompt: s.prompt.trim(),
      projectDirectory: dir,
      scheduleType: "every" as const,
      timezone: s.timezone,
      deleteAfterRun: false,
      notifyOn: s.notifyOn,
      overlapPolicy: s.overlapPolicy,
      intervalMs: s.intervalMs,
      // 5-Layer Temporal Model
      operatingSchedule: JSON.stringify({
        everyNWeeks: s.everyNWeeks,
        activeDays: s.activeDays
          .map((enabled, i) => (enabled ? i : -1))
          .filter(i => i >= 0),
        clockIn: s.clockIn,
        clockOut: s.clockOut,
      }),
      exclusionSchedule: JSON.stringify(
        s.exclusions.map(e => ({
          label: e.description,
          month: new Date(e.startAt).getMonth() + 1,
          day: new Date(e.startAt).getDate(),
          annualRepeat: e.annualRepeat,
          year: e.annualRepeat ? undefined : new Date(e.startAt).getFullYear(),
        }))
      ),
      lifetimeStart: s.lifetimeStart
        ? new Date(s.lifetimeStart).getTime()
        : undefined,
      lifetimeEnd: s.lifetimeEnd
        ? new Date(s.lifetimeEnd).getTime()
        : undefined,
      eventCountLimit: s.eventCountLimit
        ? parseInt(s.eventCountLimit, 10)
        : undefined,
      jitterMaxMs: s.jitterMs || undefined,
      heartbeatMode: s.heartbeatMode,
      preWorkInstructions: !s.heartbeatMode
        ? s.preWorkInstructions || undefined
        : undefined,
      closingInstructions: !s.heartbeatMode
        ? s.closingInstructions || undefined
        : undefined,
      standingOrders: s.heartbeatMode
        ? s.standingOrdersMode === "inline"
          ? s.standingOrdersText
          : s.standingOrdersFile
        : undefined,
      ackMaxChars: parseInt(s.responseSuppression, 10) || 100,
      rotationConfig: JSON.stringify({
        mode: s.rotationMode,
        ...(s.rotationMode === "count"
          ? { count: parseInt(s.rotationCount, 10) || 5 }
          : { days: s.rotationDays, time: s.rotationTime }),
      }),
      backoffConfig: s.backoffEnabled
        ? JSON.stringify({
            multiplier: parseFloat(s.backoffMultiplier) || 2,
            threshold: parseInt(s.backoffThreshold, 10) || 3,
          })
        : undefined,
      runOnceAtCreation: s.runOnceAtCreation,
      dstAdjustment: s.dstAdjustment ? "skip" : "none",
      // #2270 (F25): use the EFFECTIVE type so a scheduled task on a non-git dir
      // matches the (downgraded-to-simple) control the user saw.
      sessionType: formState.effective.sessionType,
      worktreeBranchName: formState.effective.worktreeName,
    };

    if (s.maxRuntimeMinutes) {
      input.maxRuntimeMs = parseInt(s.maxRuntimeMinutes, 10) * 60_000;
    }

    try {
      await createSchedule(input);
      haptic.notification("success");
      props.onScheduleCreated?.();
    } catch (e) {
      haptic.notification("error");
      setError(e instanceof Error ? e.message : "Failed to create schedule");
    }
  }

  // #4481: new-branch name feedback (only while the name field is shown).
  const newBranchFb = useMemo(
    () =>
      formState.fields.worktreeBranch.visible
        ? newBranchFeedback(worktreeName, branchSel.listing, { sessionMode })
        : undefined,
    [
      formState.fields.worktreeBranch.visible,
      worktreeName,
      branchSel.listing,
      sessionMode,
    ]
  );
  const newBranchError = newBranchFb?.error ?? null;

  const canCreate = useMemo(() => {
    if (isFormDisabled) return false;

    // Block spawn when the path is confirmed non-existent on the target
    if (pathExistence[directory.trim()] === false) return false;

    // Block spawn when a session name was entered but fails validation.
    // Empty name is allowed (name is optional — falls back to session ID).
    const nameTrimmed = sessionName.trim();
    if (nameTrimmed.length > 0 && validateSessionName(nameTrimmed) !== null) {
      return false;
    }

    // #4481: an invalid new-branch name blocks Create (inline error shown).
    if (newBranchError) return false;

    if (sessionMode === "scheduled") {
      // Need prompt + directory for scheduled sessions. The slot meter is an
      // immediate-spawn concern, so at-capacity does NOT gate a scheduled task.
      return Boolean(scheduleState.prompt.trim() && directory.trim());
    }

    // Standard session creation: need a target + directory
    return Boolean(spawnTarget && directory.trim());
  }, [
    isFormDisabled,
    sessionMode,
    scheduleState,
    spawnTarget,
    directory,
    pathExistence,
    sessionName,
    newBranchError,
  ]);

  // Accordion section open/collapse state. INDEPENDENT expand/collapse (the
  // user's locked design decision): any number of sections may be open at once,
  // and expanding all four yields the single long top-to-bottom scroll. Default:
  // ALL expanded; deliberate collapses are persisted SERVER-side (survive
  // leaving/returning to the Create page and follow the account across devices).
  const {
    sections: openSections,
    toggleSection,
    toggleAll,
  } = useCreateSessionSections(props.api);

  // Expand-all / collapse-all from the page-header button (majority-rule logic
  // lives in the hook so it persists alongside per-section toggles).
  useImperativeHandle(ref, () => ({ toggleAll }), [toggleAll]);

  // Report the aggregate expand state up so the header button can mirror the
  // standard chevron (all = down, none = right, mixed = unfold icon).
  const expandState: ExpandState = useMemo(() => {
    const vals = Object.values(openSections);
    if (vals.every(Boolean)) return "all";
    if (vals.every(v => !v)) return "none";
    return "mixed";
  }, [openSections]);
  const onExpandStateChange = props.onExpandStateChange;
  useEffect(() => {
    onExpandStateChange?.(expandState);
  }, [expandState, onExpandStateChange]);

  // Collapsed-section one-line summaries (derivation in sectionSummaries.ts).
  const summaries = useMemo(
    () =>
      buildSectionSummaries({
        spawnTarget,
        machines: props.machines,
        remoteNodes: props.remoteNodes,
        directory,
        agent,
        launcher,
        selectedModel,
        linkedIssue,
        sessionEmoji,
        sessionName,
        permissionMode,
        safeMode,
        sessionMode,
      }),
    [
      spawnTarget,
      props.machines,
      props.remoteNodes,
      directory,
      agent,
      launcher,
      selectedModel,
      linkedIssue,
      sessionEmoji,
      sessionName,
      permissionMode,
      safeMode,
      sessionMode,
    ]
  );

  // #2270 (F25): pass the EFFECTIVE type so the summary matches the control.
  // Not memoized: it is a 4-element join, and the old memo keyed on `formState`,
  // whose identity changes on every form edit — so it never actually cached.
  const githubSummary = buildGitHubSummary({
    sessionMode,
    githubAccount,
    cloneRepo,
    detectedRepo,
    isWorktree: formState.effective.sessionType === "worktree",
    accountsUnavailable: githubAccountsUnavailable,
  });

  const isPending = spawnPending || schedulePending;

  return (
    <CreateDefaultsProvider value={defaultsApi}>
      <div className="flex h-full min-h-0 flex-col">
        {/* #3132: respawn pre-fill banner — surfaces the pending skill the
          capability-miss offer wanted to run, alongside the pre-selected capable
          harness. Pinned above the scroll stack so it is always visible. */}
        {props.pendingSkill ? (
          <div
            data-testid="pending-skill-banner"
            role="status"
            className="mx-3 mt-2 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
          >
            Respawning to run{" "}
            <code className="font-mono text-[var(--app-link)]">
              /{props.pendingSkill}
            </code>{" "}
            under a capable harness. It is pre-filled as the schedule prompt
            below.
          </div>
        ) : null}
        {/* Scrollable accordion stack — grows to fill the available height so the
          footer below pins flush to the viewport bottom (no dead space) regardless
          of how many sections are open (#1949 A2 / regression fix). */}
        {/* The scroll bar is hidden (scrollbar-width:none + the ::-webkit-scrollbar
        pseudo) so the sections scroll like the rest of the app with no visible
        scroll bar. With no scroll bar there is no width to reserve, so the
        sections always use the full width and never shift. */}
        <div
          ref={scrollStackRef}
          className="flex min-h-0 flex-1 flex-col divide-y divide-[var(--app-divider)] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <DefaultsActionsBar />
          {/* Section 1: Machine — Federation Node + Directory (locked V1 mock-up) */}
          <CollapsibleLayer
            title="Host Server"
            icon={<MonitorIcon className="h-[18px] w-[18px]" />}
            accentColor={SECTION_ACCENTS.machine}
            isOpen={openSections.machine}
            onToggle={() => toggleSection("machine")}
            summary={summaries.machine}
            openMaxHeightClass="max-h-[4000px]"
          >
            <div>
              <MachineSelector
                machines={props.machines}
                remoteNodes={props.remoteNodes}
                machineId={selectedValue}
                isLoading={props.isLoading}
                isDisabled={isFormDisabled}
                localSessionCount={sessions.length}
                localConnectedCount={sessions.filter(s => s.active).length}
                localDisconnectedCount={sessions.filter(s => !s.active).length}
                onChange={handleMachineChange}
                federationRefresh={federationRefresh}
              />
              <DirectorySection
                api={props.api}
                machineId={localMachineId}
                nodeId={remoteNodeId}
                nodeHomeDir={selectedNodeHomeDir}
                directory={directory}
                isDisabled={isFormDisabled}
                onDirectoryChange={handleDirectoryChange}
                recentPaths={recentPaths}
                onAddRecentPath={addRecentPath}
                onRemoveRecentPath={removeRecentPath}
              />
            </div>
          </CollapsibleLayer>

          {/* Section 2: Model — CLI Harness + Account + Launcher + Provider + Model */}
          <CollapsibleLayer
            title="Model"
            icon={<RobotIcon className="h-[18px] w-[18px]" />}
            accentColor={SECTION_ACCENTS.model}
            isOpen={openSections.model}
            onToggle={() => toggleSection("model")}
            summary={summaries.model}
            openMaxHeightClass="max-h-[4000px]"
          >
            <div>
              <div className="flex flex-col gap-1 px-3 py-1">
                {/* CLI Harness + Launcher side by side (Create-page layout round) */}
                <div className="flex gap-2">
                  <div className="min-w-0 flex-1">
                    <AgentSelector
                      agent={agent}
                      isDisabled={isFormDisabled}
                      onAgentChange={v => {
                        markTouched("cliHarness");
                        setAgent(v);
                      }}
                      availableAgents={availableAgents}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    {/* #4568: shows the EFFECTIVE launcher — SDK, greyed, with
                      "Required for API billing" while an API key is picked. */}
                    <LauncherSelector
                      launcher={formState.effective.launcher ?? launcher}
                      isDisabled={formState.fields.launcher.disabled}
                      note={formState.fields.launcher.note}
                      onChange={value => {
                        markTouched("launcher");
                        setLauncher(value);
                      }}
                    />
                  </div>
                </div>
                {/* #3314: full-width collapsible "Capabilities" subheading (see CapabilityChips.tsx). */}
                {props.api ? (
                  <CapabilityChips agent={agent} api={props.api} />
                ) : null}
                {/* #2626 (D): per-session output style — Claude-only session
                  config (output styles are a Claude concept). #4568: reads its
                  OWN field state — the launcher's disabled flag now also carries
                  the API-billing lock, which does not apply here. buildSpawnInput
                  gates the value (claude-only + omit when "default"), so a
                  non-Claude or default spawn stays byte-identical (R2). */}
                <OutputStyleSelector
                  styles={outputStyles}
                  value={outputStyle}
                  isDisabled={formState.fields.outputStyle.disabled}
                  onChange={value => {
                    markTouched("outputStyle");
                    setOutputStyle(value);
                  }}
                />
                {/* Account — Claude-only (R8); remote spawns use the node default,
                so the selector is hidden for remote targets. */}
                {!isRemoteTarget && (
                  <AccountSelector
                    accounts={accounts}
                    selectedUuid={accountUuid}
                    activeAccountUuid={activeAccount?.accountUuid ?? null}
                    isLoading={accountsLoading}
                    isDisabled={formState.fields.account.disabled}
                    label={formState.fields.account.label}
                    envCredentialFallback={envCredentialPresent}
                    // #4568: a Standard Claude session also offers the node's
                    // Anthropic API keys.
                    apiKeys={apiKeysOffered ? anthropicKeys : undefined}
                    selectedApiKeyId={
                      apiKeysOffered ? (pickedApiKey?.id ?? null) : null
                    }
                    onOpen={() => setAccountModalOpen(true)}
                  />
                )}
                {/* #1733/#2434: Provider chip + the flavor-conditional model
                  picker (OpenRouter for codex/opencode, Claude model-mode for
                  claude). Visibility is derived in formState, not here. */}
                <ProviderModelFields
                  fields={formState.fields}
                  agent={agent}
                  selectedModel={selectedModel}
                  onSelectedModelChange={v => {
                    markTouched("openrouterModel");
                    setSelectedModel(v);
                  }}
                  api={props.api}
                  rawModel={rawModel}
                  effort={effort}
                  onRawModelChange={v => {
                    markTouched("model");
                    setRawModel(v);
                  }}
                  onEffortChange={v => {
                    markTouched("effort");
                    setEffort(v);
                  }}
                  geminiModel={selectedGeminiModel}
                  onGeminiModelChange={setSelectedGeminiModel}
                  codexModel={selectedCodexModel}
                  onCodexModelChange={setSelectedCodexModel}
                  codexEffort={selectedCodexEffort}
                  onCodexEffortChange={setSelectedCodexEffort}
                  opencodeProvider={selectedOpencodeProvider}
                  onOpencodeProviderChange={setSelectedOpencodeProvider}
                  opencodeModel={selectedOpencodeModel}
                  onOpencodeModelChange={setSelectedOpencodeModel}
                  vaultKeys={vaultKeys ?? []}
                />
              </div>
            </div>
          </CollapsibleLayer>

          {/* Section 3: GitHub — Account + Repo + Git Session Type (locked V1 mock-up) */}
          <CollapsibleLayer
            title="GitHub"
            icon={<GitHubIcon className="h-[18px] w-[18px]" />}
            accentColor={SECTION_ACCENTS.github}
            isOpen={openSections.github}
            onToggle={() => toggleSection("github")}
            summary={githubSummary}
            openMaxHeightClass="max-h-[4000px]"
          >
            <div>
              {/* #1953 A6: GitHub-account → repo → clone-on-spawn. Standard mode
              only (R10) — the scheduled-event flow has no GitHub context. */}
              {sessionMode === "standard" && (
                <GitHubAccountRepoSelector
                  accounts={githubAccounts}
                  repos={githubRepos}
                  selectedAccount={githubAccount}
                  selectedRepo={cloneRepo}
                  detectedRepo={detectedRepo}
                  isLoadingAccounts={githubAccountsLoading}
                  isLoadingRepos={githubReposLoading}
                  accountsUnavailable={githubAccountsUnavailable}
                  accountsUnavailableReason={githubAccountsReason}
                  isDisabled={isFormDisabled}
                  onOpenAccount={() => setGithubAccountModalOpen(true)}
                  onOpenRepo={() => setGithubRepoModalOpen(true)}
                />
              )}
              <div className="flex flex-col gap-1 px-3 py-1">
                <SessionTypeSelector
                  // #2270 (F25): render from the EFFECTIVE type (may be
                  // downgraded to simple for a non-git dir). The type
                  // description renders INLINE in the heading row.
                  sessionType={formState.effective.sessionType}
                  isDisabled={isFormDisabled}
                  onSessionTypeChange={value => {
                    markTouched("gitType");
                    restoredGitTypeRef.current = null;
                    // #4481: Basic → current branch; Worktree → "New branch…".
                    branchSel.onGitTypeChange();
                    setSessionType(
                      coerceGitTypeForClone(
                        cloneLockFor(
                          cloneRepoRef.current,
                          sessionModeRef.current
                        ),
                        value
                      )
                    );
                    setSessionTypeUserSelected(true);
                  }}
                  // #3558: a clone-on-spawn repo (Standard mode only) disables
                  // Worktree; its reason replaces the F25 non-git hint (the
                  // not-yet-cloned destination is legitimately non-git too).
                  worktreeDisabled={formState.fields.gitType.worktreeDisabled}
                  // #4481: name the branch Basic runs on, once it is known.
                  description={describeSessionType(
                    formState.effective.sessionType,
                    {
                      dirLabel: branchSel.listing
                        ? directoryLabel(directory)
                        : null,
                      currentBranch: currentRefLabel(
                        branchSel.listing?.current ?? null
                      ),
                    }
                  )}
                  worktreeHint={
                    cloneLockFor(cloneRepo, sessionMode)
                      ? "Worktree needs an existing repo checkout in this directory. A first-time clone always runs as Basic."
                      : directoryIsGitRepo === false
                        ? "This directory is not a git repository — Worktree needs one."
                        : undefined
                  }
                />
              </div>
            </div>
          </CollapsibleLayer>

          {/* Section 4: Session — Linked Issue + Name + Branch + Permission + Safe + Mode */}
          <CollapsibleLayer
            title="Session"
            icon={<TerminalIcon className="h-[18px] w-[18px]" />}
            accentColor={SECTION_ACCENTS.session}
            isOpen={openSections.session}
            onToggle={() => toggleSection("session")}
            summary={summaries.session}
            openMaxHeightClass="max-h-[8000px]"
          >
            <div>
              <LinkIssueField
                api={props.api}
                issues={repoIssues}
                repo={detectedRepo}
                isLoading={issuesLoading}
                unavailable={issuesUnavailable}
                isDisabled={isFormDisabled}
                linkedIssue={linkedIssue}
                claimedIssues={claimedIssues}
                onLinkIssue={(issue: LinkedIssue | null) => {
                  setLinkedIssue(issue);
                  // #858: selecting an issue ALWAYS (re)populates the branch
                  // name — the selection is explicit and later in time, so it
                  // wins over any prior typed or auto-filled value.
                  if (issue) {
                    setWorktreeName(toBranchName(issue.number, issue.title));
                  }
                }}
                onAutoPopulateName={(name: string) => setSessionName(name)}
              />
              <SessionIdentitySection
                emoji={sessionEmoji}
                name={sessionName}
                isDisabled={isFormDisabled}
                onEmojiChange={setSessionEmoji}
                onNameChange={(name: string) => {
                  markTouched("sessionName");
                  hasUserEditedName.current = true;
                  setSessionName(name);
                }}
              />
              {/* Branch Name — only for Worktree sessions (Git Session Type lives
              in the GitHub section above). #2270 (F25): key on the EFFECTIVE type
              (formState.fields.worktreeBranch.visible) so it hides when a non-git
              dir downgrades the control to simple. */}
              {/* #4481: the Branch control (both Git Types) — falls back to
              today's Branch Name-only UI while loading / when unavailable. */}
              {branchSel.renderMode === "selector" && branchSel.listing ? (
                <BranchSelector
                  listing={branchSel.listing}
                  choice={branchSel.choice}
                  directory={directory}
                  sessionMode={sessionMode}
                  isDisabled={isFormDisabled}
                  onChoose={choice => {
                    restoredGitTypeRef.current = null;
                    branchSel.selectBranch(choice);
                  }}
                />
              ) : null}
              {branchSel.renderMode === "clone-readonly" ? (
                <BranchReadOnly
                  defaultBranch={
                    githubRepos.find(r => r.nameWithOwner === cloneRepo)
                      ?.defaultBranch
                  }
                />
              ) : null}
              {formState.fields.worktreeBranch.visible && (
                <BranchNameField
                  value={worktreeName}
                  isDisabled={isFormDisabled}
                  onChange={value => {
                    markTouched("branchName");
                    hasUserEditedBranch.current = true;
                    setWorktreeName(value);
                  }}
                  feedback={newBranchFb}
                  onUseExisting={() => {
                    const fb = newBranchFb;
                    restoredGitTypeRef.current = null;
                    if (fb?.collidesWithCurrent) {
                      branchSel.selectBranch({ kind: "current" });
                    } else if (fb?.collision && !fb.collisionBlockedReason) {
                      branchSel.selectBranch({
                        kind: "existing",
                        branch: fb.collision,
                      });
                    }
                  }}
                />
              )}
              {/* Permission Mode (half-width — its options are single words) shares
              a row with the Safe Mode toggle to save the vertical space the toggle
              previously took on its own row. */}
              <div className="flex items-start gap-4 px-3 py-1">
                <div className="w-1/2 min-w-0">
                  <PermissionModeSelector
                    permissionMode={permissionMode}
                    flavor={agent}
                    isDisabled={formState.fields.permissionMode.disabled}
                    onChange={v => {
                      markTouched("permissionMode");
                      setPermissionMode(v);
                    }}
                  />
                </div>
                <div className="shrink-0">
                  <SafeModeToggle
                    safeMode={safeMode}
                    isDisabled={formState.fields.safeMode.disabled}
                    onToggle={v => {
                      markTouched("safeMode");
                      setSafeMode(v);
                    }}
                  />
                </div>
              </div>
              {/* Session Mode — Standard vs Scheduled. ScheduleSection itself stays
              un-nested below this accordion so the scheduled-event form renders
              unchanged. */}
              <SessionModeSelector
                sessionMode={sessionMode}
                isRemoteTarget={isRemoteTarget}
                isDisabled={isFormDisabled}
                onChange={value => {
                  markTouched("sessionMode");
                  applySessionMode(value);
                }}
              />
              {/* Scheduled Event Settings — rendered INSIDE the Session content so
              the section's amber rail flows down over it and its fields align with
              the Session fields above (one unified Session subsection, not a
              separate block). */}
              {!isRemoteTarget && (
                <div
                  className={`overflow-hidden transition-all duration-300 ease-in-out ${
                    sessionMode === "scheduled"
                      ? "max-h-[6000px] opacity-100"
                      : "max-h-0 opacity-0"
                  }`}
                >
                  <ScheduleSection
                    state={scheduleState}
                    onChange={handleScheduleChange}
                    isDisabled={isFormDisabled}
                    api={props.api}
                    machineId={localMachineId}
                    nodeId={remoteNodeId}
                  />
                </div>
              )}
            </div>
          </CollapsibleLayer>
        </div>

        {/* #1949 A2: pinned footer — a `shrink-0` flex child of the full-height
          column (NOT `sticky`), so it sits FLUSH at the viewport bottom with no
          dead space regardless of how many sections are open. The preview is
          standard-mode only (R7); bg is opaque so scrolled content does not
          show through. */}
        {/* #2019: NO `env(safe-area-inset-bottom)` padding here. This footer sits
        ABOVE BrandedFrame's version-footer, which ALREADY handles the
        home-indicator safe area — so adding it here was double-compensation (the
        #661 bug class). In standalone PWA it injected a 34px dead band below the
        Create button (env(safe-area-inset-bottom)=34px on iPhone; =0 in a regular
        browser, which is why the gap was PWA-only). Measured on-device: button
        band bottom=810 vs content-area bottom=844 = exactly the 34px inset. */}
        <div className="shrink-0 z-10 border-t border-[var(--app-divider)] bg-[var(--app-bg)]">
          {/* Terminal toggle + saved-defaults bulk actions (FooterBar). */}
          <FooterBar
            sessionMode={sessionMode}
            selections={spawnSelections}
            display={spawnDisplay}
          />
          {/* #4417 (Task 8): advisory capacity notice for the selected target,
            directly above the Create button. Renders nothing below the recommended
            count; never disables the button (the daemon gate is the enforcement). */}
          <CapacityNotice capacity={spawnCapacity} />
          {/* #2270 (F22): spawn errors render HERE — inside the shrink-0 pinned
            footer, directly above the Create button — so a sync-path spawn
            failure (e.g. worktree-on-non-git) is ALWAYS visible right where the
            user tapped, instead of at the bottom of a scrollable form that may
            be off-screen. Form state (directory/name/options) is preserved on
            failure (the handler only calls setError), so this persists. */}
          {(error ?? spawnError) ? (
            <div
              role="alert"
              className="border-b border-[var(--app-divider)] bg-red-500/10 px-3 py-2 text-sm text-red-600 whitespace-pre-line"
            >
              {error ?? spawnError}
            </div>
          ) : null}
          <ActionButtons
            isPending={isPending}
            canCreate={canCreate}
            isDisabled={isFormDisabled}
            onCancel={props.onCancel}
            onCreate={handleCreate}
          />
        </div>

        {/* #1496: shared account picker in selection-only "spawn" scope. Selecting
          a row fires onSelect into form state and closes — no network mutation. */}
        <AccountSelectorModal
          isOpen={accountModalOpen}
          onClose={() => setAccountModalOpen(false)}
          api={props.api}
          scope="spawn"
          // #4464: an add from the picker stores the login on the spawn target.
          addTargetNodeId={remoteNodeId ?? undefined}
          // #3808 Task 5: scope the list to the chosen harness's provider so a
          // codex spawn offers OpenAI accounts, a gemini spawn Google accounts.
          providerScope={accountSelectorProvider ?? "anthropic"}
          selectedAccountUuid={accountUuid}
          onSelect={uuid => {
            markTouched("account");
            handleAccountChange(uuid);
            setAccountModalOpen(false);
          }}
          // #4568: the "API keys" section — a Standard Claude session on a local
          // target only (the modal also renders it only for the anthropic scope).
          apiKeys={apiKeysOffered ? anthropicKeys : undefined}
          selectedApiKeyId={apiKeysOffered ? (pickedApiKey?.id ?? null) : null}
          onSelectApiKey={
            apiKeysOffered && !isRemoteTarget
              ? id => {
                  markTouched("account");
                  handleApiKeyChange(id);
                  setAccountModalOpen(false);
                }
              : undefined
          }
        />

        {/* #2019: GitHub account + repo selection modals (selection-only, mirror
          the AccountSelectorModal spawn-scope pattern). */}
        <GitHubAccountSelectorModal
          isOpen={githubAccountModalOpen}
          onClose={() => setGithubAccountModalOpen(false)}
          accounts={githubAccounts}
          selectedAccount={githubAccount}
          isLoading={githubAccountsLoading}
          onSelect={login => {
            handleGithubAccountChange(login);
            setGithubAccountModalOpen(false);
          }}
        />
        <GitHubRepoSelectorModal
          isOpen={githubRepoModalOpen}
          onClose={() => setGithubRepoModalOpen(false)}
          repos={githubRepos}
          selectedRepo={cloneRepo}
          isLoading={githubReposLoading}
          onSelect={repo => {
            handleCloneRepoChange(repo);
            setGithubRepoModalOpen(false);
          }}
        />
      </div>
    </CreateDefaultsProvider>
  );
});
