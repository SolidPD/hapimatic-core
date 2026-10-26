// SPDX-License-Identifier: AGPL-3.0-only
/**
 * EditSessionParamsModal (issue #2149) — the Session Details "Edit → relaunch"
 * surface. A portal modal opened from the SessionHeader action row that lets a
 * user edit a running session's launch parameters and apply them, routing each
 * changed field to the correct plane:
 *
 *  - **Live-plane** params (modelMode / effort / rawModel / permission mode / MCP
 *    set) apply IN PLACE via their existing mutations — no teardown, no cache bust
 *    beyond the field's own (KD-2). This is why most acceptance criteria are met
 *    without any new respawn machinery.
 *  - **Spawn-frozen** flags (launcher / safeMode) are NOT on this surface (E9,
 *    epic #3285, operator ruling 2026-09-06): they are spawn-time flags that the
 *    earlier modal "applied" by tearing the session down and respawning it, so
 *    they were never settings. They stay on the Create page; "Copy params"
 *    still emits the session's CURRENT launcher and safe-mode flags.
 *
 * Layout (E9 `claudedocs/design-mockups/e9/settings-modal.html`):
 *   Row 1 — Account | Permission Mode · Row 2 — Model | Effort. The right column
 *   is ONE fixed width (`NARROW_COL_PX`) sized for the wider of its two
 *   worst-case labels ("safe-YOLO" / "Extra High"), so Permission Mode and Effort
 *   share a left edge; Account and Model take everything to their left. Between
 *   the two rows, a full-width block shows the shown account's usage meters
 *   (#4523, D-4523-1 A — inside neither row, so the grid is untouched). Then
 *   MCP Servers, and a footer row with "Copy params" at the lower-left and
 *   Cancel / Save-or-Apply at the right (round 12).
 *
 * A prompt-cache-impact estimate (R8) updates as the draft diverges from the
 * session's current params, keyed off WHICH fields changed (a live MCP toggle
 * busts the cache; an effort-only change does not).
 *
 * Host: the shared Radix `Dialog` (`ui/dialog.tsx`) since epic #3285 round 14 —
 * see the note on `EditSessionParamsModal` below (nested-dialog stacking when
 * opened from inside the fullscreen prompt editor). Before that it was a raw
 * `createPortal` overlay like the MCP-detail modal in `AssistantChat/StatusBar.tsx`.
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  EFFORT_LEVEL_LABELS,
  formatModelName,
  isYoloEquivalentMode,
  LOCAL_NODE_ID,
  MODEL_MODE_LABELS,
  stripModelTierSuffix,
  type EffortLevel,
  type ModelMode,
  type PermissionMode,
} from "@hapi/protocol";
import type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";
import type { Session } from "@/types/api";
import type { ApiClient } from "@/api/client";
import type { AgentType } from "@/components/NewSession/types";
import type { SpawnInput } from "@/hooks/mutations/useSpawnSession";
import { effortLevelsForCurrent } from "@/components/AssistantChat/ModelModePicker";
import { UiSelect } from "@/components/NewSession/controls";
import { useClaudeModels } from "@/hooks/queries/useClaudeModels";
import {
  useAccountLabel,
  useAccountMonogram,
} from "@/hooks/queries/useAccountLabels";
import { AccountChip } from "@/components/session/AccountChip";
import { useAppContext } from "@/lib/app-context";
import { PermissionModeSelector } from "@/components/NewSession/PermissionModeSelector";
import { deriveFormState } from "@/components/NewSession/formState";
import {
  assembleSpawnCommand,
  type SpawnDisplayContext,
} from "@/components/NewSession/spawnCommand";
import { estimateCacheImpact, type EditableField } from "@/lib/cacheImpact";
import { useSessionActions } from "@/hooks/mutations/useSessionActions";
import { useMcpStatus } from "@/hooks/useMcpStatus";
import { useSessionTokenStats } from "@/hooks/queries/useSessionTokenStats";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { ChevronIcon } from "@/components/icons";
import { FormField } from "@/components/NewSession/FormField";
import { AccountSelectorModal } from "@/components/AccountSelectorModal";
import { McpServersSection } from "@/components/session/McpServersSection";
import {
  SessionAccountUsageMeters,
  findAccountUsage,
} from "@/components/session/SessionAccountUsageMeters";
import {
  API_KEY_CHIP_IDENTITY,
  apiKeyCredentialLabel,
  useSessionAccountEmail,
} from "@/hooks/queries/useSessionAccountEmail";
import { useAccounts } from "@/hooks/queries/useAccounts";
import { useAccountUsage } from "@/hooks/queries/useAccountUsage";
import { useAccountActions } from "@/hooks/mutations/useAccountActions";
import { useApiKeys } from "@/hooks/queries/useApiKeys";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import { apiKeyDisplayName } from "@/lib/apiKeyStatus";

/**
 * Issue #4823: the session's payment method — a subscription account or a
 * node-vault Anthropic API key (by vault id). The Account row stages one of
 * these; "Apply changes" switches the session onto it.
 */
type PaymentMethod =
  | { kind: "account"; accountUuid: string }
  | { kind: "api-key"; apiKeyId: string };

function samePaymentMethod(
  a: PaymentMethod | null,
  b: PaymentMethod | null
): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "account" && b.kind === "account") {
    return a.accountUuid === b.accountUuid;
  }
  if (a.kind === "api-key" && b.kind === "api-key") {
    return a.apiKeyId === b.apiKeyId;
  }
  return false;
}

/**
 * E9 `.col.narrow { width: 118px }` — the fixed right column (Permission Mode on
 * Row 1, Effort on Row 2), sized for the wider worst-case label ("safe-YOLO" /
 * "Extra High") so the two drop-downs share one left edge. Inline `style` — an
 * exact component dimension with no named spacing token.
 */
const NARROW_COL_PX = 118;

/** Model-select value prefix for a mode-only selection (see `modelSelectValue`). */
const MODE_OPTION_PREFIX = "mode:";

/**
 * #3288: the exact fields `EditSessionParamsForm` reads. Both the full `Session`
 * (instance header) and the list card's lighter `SessionSummary` are assignable —
 * the full-Session-only fields (`effort` / `rawModel` / `metadata.safeMode`) are
 * OPTIONAL, so a summary-sourced open degrades to the modal's built-in defaults
 * for them. The apply path is changed-fields-only (`applyLivePlaneChanges`), so an
 * un-touched degraded field is never sent — degradation is lossless, not a reset.
 */
export type EditSessionParamsInput = {
  id: string;
  modelMode?: Session["modelMode"];
  effort?: Session["effort"];
  rawModel?: Session["rawModel"];
  permissionMode?: Session["permissionMode"];
  resolvedModel?: Session["resolvedModel"];
  thinking?: Session["thinking"];
  /** #3290: disconnected → Apply disabled with "reconnect to apply" copy (R6). */
  active?: Session["active"];
  /** Round 15: the session's federation node (rows enriched by
   *  useFederatedSessions carry it) — the node whose ACTIVE account names a
   *  session that recorded none. Absent → the LOCAL_NODE_ID sentinel. */
  nodeId?: string;
  /** Issue #4823: local mode (`controlledByUser`) — a local-mode session cannot
   *  switch to an API key. Only the full `Session` carries it; a list-row
   *  `SessionSummary` does not, and the server refusal still applies there. */
  agentState?: { controlledByUser?: boolean | null } | null;
  metadata?: {
    flavor?: string | null;
    path?: string;
    launcherKind?: string;
    safeMode?: boolean;
    /** Round 14 (item 7): the bound account uuid (`metadata.accountUuid`) —
     *  the baseline the staged Account row diffs against. */
    accountUuid?: string;
    /** Issue #4823: the bound API key's vault id (`metadata.apiKeyId`; the list
     *  row's `SessionSummary` projects it too) — the current key, if any. */
    apiKeyId?: string;
    /** #3290: the session's Claude account (for the Account row + selector). */
    claudeAccount?: { email?: string } | null;
    /** Round 11: the durable pins — what a DISCONNECTED session's save wrote
     *  (and what the CLI stamps on a live change). The draft seeds from the
     *  live runtime field first, then from these, so a reopened modal shows the
     *  saved values while the session is still disconnected. */
    modelMode?: Session["modelMode"];
    effort?: Session["effort"];
    rawModel?: Session["rawModel"];
    permissionMode?: Session["permissionMode"];
    /** #3348: the non-claude native model recorded at spawn — the display source
     *  for the gemini/codex active-model row. */
    nativeModel?: string;
  } | null;
};

type EditSessionParamsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  session: EditSessionParamsInput;
  api: ApiClient | null;
  /** Federation node label — rendered in the copied `--on` line when present. */
  nodeLabel?: string;
  /** Issue #4823: the mount's federation node id (the header / chat know it;
   *  a full `Session` carries `nodeId` only via federation fallback). Decides
   *  whether the session is remote, which disables the API-key group. */
  nodeId?: string;
};

/** Narrow the free-form flavor to the AgentType union (defaulting to claude). */
function toAgentType(flavor: string | null | undefined): AgentType {
  return flavor === "codex" || flavor === "gemini" || flavor === "opencode"
    ? flavor
    : "claude";
}

export function EditSessionParamsModal(props: EditSessionParamsModalProps) {
  if (!props.isOpen) return null;
  // The form's hooks (MCP status, token stats, mutations) run only while open —
  // mounting a fresh child on each open also re-seeds the draft from the session.
  // Epic #3285 round 14 (item 2): hosted in the shared Radix Dialog (was a raw
  // createPortal overlay). A raw portal opened from INSIDE another Radix modal
  // dialog — the fullscreen prompt editor, whose config cluster opens this — is
  // unusable: the outer dialog's body `pointer-events: none` and focus trap
  // still govern it (measured on wt :3010 — Apply not clickable, selects lose
  // focus). Nested Radix dialogs stack by open order and hand focus to the top
  // one, so this is the fix; it also gives the modal Escape-to-close for free.
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        hideCloseButton
        description="Edit this session's live parameters"
        // Radix auto-focuses the first focusable (the header ✕), which paints a
        // focus ring on every open — keep focus on the container instead.
        onOpenAutoFocus={e => e.preventDefault()}
        // A transparent, padding-less shell: the form below keeps its own card
        // chrome (width, border, background, 85vh cap) unchanged.
        className="w-auto max-w-none border-0 bg-transparent p-0 shadow-none"
      >
        <EditSessionParamsForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

/** The editable (live-plane) draft. Launcher / safeMode are deliberately absent
 *  (E9) — read from `current` only, for field gating + the copied command. */
type Draft = {
  modelMode: ModelMode;
  effort: EffortLevel | undefined;
  rawModel: string;
  permissionMode: PermissionMode;
  /** name → enabled. Seeded from the session's live MCP status. */
  mcpDesired: Record<string, boolean>;
  /** Epic #3285 round 14 (item 7) → issue #4823: the STAGED payment method — an
   *  account or an API key. Seeded from the session's binding; differs from
   *  `current.paymentMethod` only after the user picks another account or key —
   *  "Apply changes" performs the switch. One field, so an account and a key can
   *  never be staged together. */
  paymentMethod: PaymentMethod | null;
};

function EditSessionParamsForm({
  onClose,
  session,
  api,
  nodeLabel,
  nodeId,
}: EditSessionParamsModalProps) {
  const flavor = session.metadata?.flavor ?? null;
  const agent = toAgentType(flavor);
  const projectDir = session.metadata?.path;

  const actions = useSessionActions(api, session.id, flavor);
  const mcp = useMcpStatus(projectDir);
  const { data: tokenStats } = useSessionTokenStats(api, session.id);
  const { copied, copy } = useCopyToClipboard();

  // Current (session) values — the diff baseline.
  const current = useMemo(
    () => ({
      // Round 11: live runtime field first (a connected session's truth), else
      // the durable pin (what a disconnected session's save wrote / what the
      // respawn will apply), else the default.
      modelMode: (session.modelMode ??
        session.metadata?.modelMode ??
        "default") as ModelMode,
      effort: session.effort ?? session.metadata?.effort,
      rawModel: session.rawModel ?? session.metadata?.rawModel ?? "",
      permissionMode: (session.permissionMode ??
        session.metadata?.permissionMode ??
        "default") as PermissionMode,
      launcher: (session.metadata?.launcherKind ??
        "sdk") as ClaudeRemoteLauncherKind,
      safeMode: session.metadata?.safeMode ?? false,
      // Round 14 → #4823: the payment method this session is bound to — an API
      // key first (a key session binds no account), else an account (absent →
      // host fallback).
      paymentMethod: (session.metadata?.apiKeyId
        ? { kind: "api-key", apiKeyId: session.metadata.apiKeyId }
        : session.metadata?.accountUuid
          ? { kind: "account", accountUuid: session.metadata.accountUuid }
          : null) as PaymentMethod | null,
    }),
    [session]
  );

  // The current MCP desired set (name → enabled) — a server is enabled unless it
  // is in `disabledServers`. Seeded once; the diff baseline for the MCP field.
  const currentMcp = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const s of mcp.servers) {
      map[s.name] = !mcp.disabledServers.includes(s.name);
    }
    return map;
  }, [mcp.servers, mcp.disabledServers]);

  const [draft, setDraft] = useState<Draft>(() => ({
    modelMode: current.modelMode,
    effort: current.effort,
    rawModel: current.rawModel,
    permissionMode: current.permissionMode,
    mcpDesired: currentMcp,
    paymentMethod: current.paymentMethod,
  }));
  // Reconcile the draft's MCP map once the (async) MCP status arrives, WITHOUT
  // clobbering user edits: only add servers the draft has never seen.
  useEffect(() => {
    setDraft(d => {
      let changed = false;
      const next = { ...d.mcpDesired };
      for (const [name, enabled] of Object.entries(currentMcp)) {
        if (!(name in next)) {
          next[name] = enabled;
          changed = true;
        }
      }
      return changed ? { ...d, mcpDesired: next } : d;
    });
  }, [currentMcp]);

  const [error, setError] = useState<string | null>(null);
  const [accountModalOpen, setAccountModalOpen] = useState(false);

  // R6 → round 11 (epic #3285, 2026-09-07): a disconnected session keeps every
  // control LIVE and the primary action becomes "Save changes" — the server
  // stages each change on the session's durable pins and applies them on the
  // respawn (staged-apply, the follow-up expert-review D4(a) deferred).
  const isDisconnected = session.active === false;

  // R4 → round 15 (epic #3285, operator ruling 2026-09-08): the Account row
  // names the LITERAL account, never "default". A Claude session records its
  // bound account at spawn; one that recorded none runs on the node's active
  // account, which the shared resolver names by email (source "node"). Non-
  // Claude sessions have no switchable account (undefined).
  const resolvedAccount = useSessionAccountEmail(api, session);
  const accountEmail = resolvedAccount.email;

  // Epic #3285 round 14 (item 7): the Account row is STAGED like every other
  // field. The selector (scope="stage") only records the pick in the draft;
  // "Apply changes" performs the switch — which restarts the session, a fact
  // the R8 impact copy states ("account" is in FORCES_RELAUNCH). The row and
  // the selector's "Current" marker both show the STAGED account while one is
  // pending, so what the user sees is what Apply will do.
  const accountActions = useAccountActions(api, { sessionId: session.id });
  // Issue #4823: a staged change of payment method — another account, a key, or
  // a key → account move. Staging is selection-only; Apply performs the switch.
  const accountStaged =
    draft.paymentMethod != null &&
    !samePaymentMethod(draft.paymentMethod, current.paymentMethod);
  const stagedKind = accountStaged ? draft.paymentMethod?.kind : undefined;
  const draftAccountUuid =
    draft.paymentMethod?.kind === "account"
      ? draft.paymentMethod.accountUuid
      : undefined;
  const draftApiKeyId =
    draft.paymentMethod?.kind === "api-key"
      ? draft.paymentMethod.apiKeyId
      : undefined;
  const { accounts } = useAccounts(
    api,
    accountModalOpen || stagedKind === "account"
  );
  const stagedAccount =
    stagedKind === "account"
      ? accounts.find(a => a.accountUuid === draftAccountUuid)
      : undefined;

  // Issue #4823: the node's Anthropic vault keys, offered beside the accounts
  // for a Claude session (keys are node-local, so a remote session lists none).
  const claudeSession = agent === "claude";
  const { data: vaultKeys } = useApiKeys(api, {
    enabled: claudeSession && (accountModalOpen || stagedKind === "api-key"),
  });
  const anthropicKeys = useMemo(
    () => (vaultKeys ?? []).filter(k => k.provider === "anthropic"),
    [vaultKeys]
  );
  const stagedKey =
    stagedKind === "api-key"
      ? anthropicKeys.find(k => k.id === draftApiKeyId)
      : undefined;
  // The row names the STAGED binding while one is pending: a staged key shows
  // no email (an account switch's email must not linger beside it).
  const shownEmail =
    stagedKind === "api-key"
      ? undefined
      : (stagedAccount?.emailAddress ?? accountEmail);

  // Issue #4523 (D-4523-4): the usage meters follow the binding the Account row
  // SHOWS — the staged one while a change is pending, else the session's own. A
  // key binds no account (#4568 / #4823), so a shown key gets no meters and no
  // usage query (R8). Gate on the resolver, not `agent`: `toAgentType` reads an
  // unknown flavor as claude, and the CLI stamps `metadata.accountUuid` for every
  // flavor — a disabled query still returns cached rows, so the LOOKUP is gated
  // too. `draftAccountUuid` is the current account's uuid until a pick is
  // staged; the email follows the staged kind (NOT `shownEmail`, which falls
  // back to the current account while a staged account is still loading). An
  // errored usage query renders no block (R5): TanStack keeps the last rows
  // after a failed refetch, so the rows alone would show stale meters as live.
  const keySession =
    resolvedAccount.source === "api-key" ||
    current.paymentMethod?.kind === "api-key";
  const keyShown = stagedKind ? stagedKind === "api-key" : keySession;
  const meterTarget = resolvedAccount.source !== "not-claude" && !keyShown;
  const { usage, error: usageError } = useAccountUsage(api, meterTarget);
  const accountUsage =
    meterTarget && usageError == null
      ? findAccountUsage(
          usage,
          draftAccountUuid,
          stagedKind === "account" ? stagedAccount?.emailAddress : accountEmail
        )
      : undefined;

  // Issue #4823 (R6): the keys group is disabled — with the reason — when the
  // server would refuse a key target. Launcher: the RAW recorded kind (a missing
  // kind is refused: the respawn would use the node's default launcher; NOT
  // `current.launcher`, which defaults it to "sdk"). Remote: keys are node-local.
  // Local mode: a live session the terminal controls (a stopped session stages).
  const { localNode } = useFederatedSessions(api);
  const effectiveNodeId = nodeId ?? session.nodeId;
  const isRemoteSession =
    effectiveNodeId != null &&
    effectiveNodeId !== LOCAL_NODE_ID &&
    localNode != null &&
    effectiveNodeId !== localNode.nodeId;
  const keysDisabledReason =
    session.metadata?.launcherKind !== "sdk"
      ? "API-key billing requires the SDK launcher — start a new session on an API key."
      : isRemoteSession
        ? "API keys are node-local — switch from the node that owns this session."
        : session.active !== false &&
            session.agentState?.controlledByUser === true
          ? "Return to remote mode to switch to an API key."
          : undefined;

  // Field gating reuses the Create-page engine in edit mode (R10) — no fork.
  const fields = deriveFormState({
    agent,
    sessionType: "simple",
    isRemoteTarget: false,
    isFormDisabled: actions.isPending,
    directoryHasGitRepo: false,
    directoryIsGitRepo: undefined,
    sessionTypeUserSelected: false,
    permissionMode: draft.permissionMode,
    // E9: launcher / safeMode are not editable here — gate on the session's own.
    safeMode: current.safeMode,
    launcher: current.launcher,
    worktreeName: "",
    accountUuid: null,
    accountsCount: 0,
    agentSupportsOpenRouter: false,
    selectedModel: "",
    selectedModelMode: draft.modelMode,
    selectedEffort: draft.effort ?? "",
    selectedRawModel: draft.rawModel,
    // #3348: the edit modal does not re-select a gemini/codex native model
    // (a codex model change recreates the session — ruling D2(a)); it DISPLAYS
    // the active model. Pass empty so the derivation's `fields.{gemini,codex}Model`
    // gate purely on the flavor axis (used only to know whether to show the
    // active-model row), never carrying a staged selection here.
    selectedGeminiModel: "",
    selectedCodexModel: "",
    selectedCodexEffort: "",
    // #3349: same as the gemini/codex native fields above — the edit modal does
    // not re-select an opencode native provider/model (empty → the derivation's
    // opencodeNativeModel gate reads the flavor axis only, no staged selection).
    selectedOpencodeProvider: "",
    selectedOpencodeModel: "",
    isEditMode: true,
  }).fields;

  // Which editable fields diverge from the session's current params.
  const changedFields = useMemo(() => {
    const s = new Set<EditableField>();
    if (draft.modelMode !== current.modelMode) s.add("modelMode");
    if (draft.rawModel !== current.rawModel) s.add("rawModel");
    if (draft.effort !== current.effort) s.add("effort");
    if (draft.permissionMode !== current.permissionMode)
      s.add("permissionMode");
    for (const [name, enabled] of Object.entries(draft.mcpDesired)) {
      if (currentMcp[name] !== undefined && currentMcp[name] !== enabled) {
        s.add("mcp");
        break;
      }
    }
    if (accountStaged) s.add("account");
    return s;
  }, [draft, current, currentMcp, accountStaged]);

  const hasChanges = changedFields.size > 0;

  // Prompt-cache impact (R8). Context ≈ the last turn's prompt tokens (input +
  // cache read + cache write); the model comes from the last turn or the session.
  const lastTurn = tokenStats?.turns?.[tokenStats.turns.length - 1];
  const contextUsedTokens = lastTurn
    ? (lastTurn.tokIn ?? 0) +
      (lastTurn.tokCacheRead ?? 0) +
      (lastTurn.tokCacheWrite ?? 0)
    : 0;
  const pricingModel =
    tokenStats?.totals?.lastModelId ??
    session.resolvedModel ??
    (session.rawModel || undefined);
  const impact = estimateCacheImpact({
    changedFields,
    contextUsedTokens,
    model: pricingModel,
  });

  // R3 (pass 2): the Effort select lists the levels the EFFECTIVE model supports
  // — live catalog when available, the shared static heuristic otherwise — via
  // the same resolver the ModelModePicker's effort submenu uses.
  const { api: appApi } = useAppContext();
  const { models: claudeModels } = useClaudeModels(appApi, {
    enabled: fields.modelMode.visible,
  });
  const effortLevels = effortLevelsForCurrent(
    draft.modelMode,
    session.resolvedModel,
    draft.rawModel || undefined,
    claudeModels
  );
  // R4 (pass 2, E6 `settings-modal.html`): the Account row shows the shared
  // entity chip (nickname monogram + label) beside the email.
  const accountLabel = useAccountLabel(appApi, shownEmail);
  const accountMonogram = useAccountMonogram(appApi, shownEmail);

  // Round 10 (2026-09-07): the Model control is the Create page's flat catalog
  // select. Its value is the draft's raw model id; a mode-only session (set via
  // the in-chat picker, no raw id) selects its mode entry; "" is Default (mode
  // default + no raw id).
  const modelSelectValue = draft.rawModel
    ? draft.rawModel
    : draft.modelMode !== "default"
      ? `${MODE_OPTION_PREFIX}${draft.modelMode}`
      : "";
  // The session's pin can carry a context-tier suffix ("claude-opus-5-5[1m]")
  // that catalog ids never have, so it matched no catalog entry and showed up
  // twice ("Opus 5.5" + "Claude Opus 5.5"). The catalog entry for the pinned
  // model takes the exact pin as its value instead: the select shows one
  // entry, an untouched select is not a change, and re-picking it keeps [1m].
  const pinnedCatalogId = stripModelTierSuffix(current.rawModel);
  const catalogOptionValue = (id: string) =>
    current.rawModel && id === pinnedCatalogId ? current.rawModel : id;
  const onModelSelect = (value: string) =>
    setDraft(d =>
      value === ""
        ? { ...d, modelMode: "default", rawModel: "" }
        : value.startsWith(MODE_OPTION_PREFIX)
          ? {
              ...d,
              modelMode: value.slice(MODE_OPTION_PREFIX.length) as ModelMode,
              rawModel: "",
            }
          : { ...d, rawModel: value }
    );

  function buildCopyText(): string {
    const spawnInput: SpawnInput = {
      machineId: "local",
      directory: projectDir ?? "",
      agent,
      yolo: isYoloEquivalentMode(draft.permissionMode),
      // E9: the copied command still carries the session's launcher + safe-mode
      // flags — read from the session, since they are no longer editable here.
      safeMode: current.safeMode || undefined,
      launcher: current.launcher,
      modelMode: draft.modelMode !== "default" ? draft.modelMode : undefined,
      effort: draft.effort || undefined,
      rawModel: draft.rawModel || undefined,
    };
    const display: SpawnDisplayContext = {
      machineLabel: nodeLabel ?? "this machine",
    };
    const enabledMcp = Object.entries(draft.mcpDesired)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .sort();
    return assembleSpawnCommand(spawnInput, display, enabledMcp);
  }

  async function applyLivePlaneChanges() {
    if (changedFields.has("modelMode"))
      await actions.setModelMode(draft.modelMode);
    if (changedFields.has("rawModel"))
      await actions.setSessionRawModel(draft.rawModel);
    if (changedFields.has("effort") && draft.effort)
      await actions.setSessionEffort(draft.effort);
    if (changedFields.has("permissionMode"))
      await actions.setPermissionMode(draft.permissionMode);
    if (changedFields.has("mcp")) {
      // Send only the changed servers — setMcpDesired merges into the existing set.
      const delta: Record<string, boolean> = {};
      for (const [name, enabled] of Object.entries(draft.mcpDesired)) {
        if (currentMcp[name] !== undefined && currentMcp[name] !== enabled) {
          delta[name] = enabled;
        }
      }
      if (Object.keys(delta).length > 0) await actions.setMcpDesired(delta);
    }
    // Round 14: the account switch goes LAST — it restarts the session, and the
    // live-plane fields above must already be persisted on the record first.
    // Issue #4823: the staged payment method may be an account OR an API key.
    if (changedFields.has("account") && draftAccountUuid)
      await accountActions.selectAccount(draftAccountUuid);
    else if (changedFields.has("account") && draftApiKeyId)
      await accountActions.selectApiKey(draftApiKeyId);
  }

  async function handleApply() {
    setError(null);
    try {
      // Every field on this surface is live-plane (E9) — no relaunch path.
      await applyLivePlaneChanges();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply changes");
    }
  }

  // R5: MCP toggle handlers passed to the extracted McpServersSection — the
  // draft (mcpDesired) stays the single source of MCP truth here.
  const setMcpServer = (name: string, enabled: boolean) =>
    setDraft(d => ({
      ...d,
      mcpDesired: { ...d.mcpDesired, [name]: enabled },
    }));
  const setAllMcpServers = (enabled: boolean) =>
    setDraft(d => {
      const next = { ...d.mcpDesired };
      for (const s of mcp.servers) next[s.name] = enabled;
      return { ...d, mcpDesired: next };
    });

  return (
    <>
      <div
        className="flex w-[min(32rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl"
        style={{ maxHeight: "85vh" }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-4 py-3">
          {/* Round 14: a real DialogTitle (the Radix host labels the dialog by it). */}
          <DialogTitle className="text-sm font-semibold text-[var(--app-fg)]">
            Session Configuration
          </DialogTitle>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto h-auto rounded-full p-1 font-normal"
          >
            ✕
          </Button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-3 overflow-y-auto px-4 py-3">
          {/* Row 1 (E9) — Account | Permission Mode. Account takes everything
            to the left; Permission Mode is the fixed narrow right column. */}
          <div className="flex items-start gap-2" data-testid="config-row-1">
            {/* Account (R4) — a Create-page-style row opening the shared
              AccountSelectorModal in `stage` scope (round 14: selection only —
              the pick lands in the draft and Apply performs the switch),
              filtered by the session's CLI. E9 `.ddl`: entity chip · email
              (ellipsized) · `›`. Shows the STAGED account while one is pending. */}
            <div className="min-w-0 flex-1">
              <FormField label="Account">
                <BareButton
                  type="button"
                  onClick={() => setAccountModalOpen(true)}
                  data-testid="config-account-trigger"
                  className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2 text-xs text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
                >
                  {shownEmail ? (
                    <>
                      {/* E9 `.ddl`: the entity chip keeps its full nickname
                        (shrink-0); the EMAIL is the element that ellipsizes. */}
                      <AccountChip
                        email={shownEmail}
                        label={accountLabel}
                        monogram={accountMonogram}
                        className="shrink-0"
                      />
                      <span className="min-w-0 truncate text-[var(--app-hint)]">
                        {shownEmail}
                      </span>
                    </>
                  ) : stagedKey ? (
                    <>
                      {/* #4823: a STAGED key names itself the way a bound key
                        does — "Anthropic API · <label>" (label, else masked). */}
                      <AccountChip
                        email={API_KEY_CHIP_IDENTITY}
                        label={apiKeyDisplayName(stagedKey)}
                        className="shrink-0"
                      />
                      <span
                        data-testid="config-account-api-key"
                        className="min-w-0 truncate text-[var(--app-hint)]"
                      >
                        {apiKeyCredentialLabel(apiKeyDisplayName(stagedKey))}
                      </span>
                    </>
                  ) : resolvedAccount.source === "api-key" &&
                    resolvedAccount.label ? (
                    <>
                      {/* #4568: an API-key session names its KEY — it binds no
                        account (a staged account switch above still wins). */}
                      <AccountChip
                        email={API_KEY_CHIP_IDENTITY}
                        label={resolvedAccount.keyName}
                        className="shrink-0"
                      />
                      <span
                        data-testid="config-account-api-key"
                        className="min-w-0 truncate text-[var(--app-hint)]"
                      >
                        {resolvedAccount.label}
                      </span>
                    </>
                  ) : (
                    <span className="truncate text-[var(--app-hint)]">
                      {resolvedAccount.source === "pending"
                        ? "Resolving account…"
                        : resolvedAccount.source === "not-claude"
                          ? "No provider account"
                          : "No account recorded"}
                    </span>
                  )}
                  <ChevronIcon
                    className="ml-auto h-3 w-3 shrink-0 text-[var(--app-hint)]"
                    collapsed
                  />
                </BareButton>
              </FormField>
            </div>
            {/* Permission Mode — LIVE plane (#3350 Task 5). `plane="live"` sources
              options from the IN-SESSION-switchable set: claude/codex render their
              full mode dropdown; gemini/opencode expose no in-session modes, so the
              picker renders one grayed-out "default" instead of a spawn pair. This
              closes the live incoherence where the modal offered gemini a YOLO that
              threw client-side / 400'd server-side (useSessionActions flavor gate). */}
            <div
              className="shrink-0"
              style={{ width: NARROW_COL_PX }}
              data-testid="config-narrow-col-1"
            >
              {/* `compactLabel` (round 10): "Permission Mode" stays on ONE line
                inside the 118px column, info icon pinned to the column's right. */}
              <PermissionModeSelector
                permissionMode={draft.permissionMode}
                flavor={agent}
                isDisabled={fields.permissionMode.disabled}
                compactLabel
                plane="live"
                onChange={mode =>
                  setDraft(d => ({ ...d, permissionMode: mode }))
                }
              />
            </div>
          </div>

          {/* Issue #4523 (D-4523-1 A): the shown account's usage meters — a
            full-width sibling between Row 1 and Row 2, inside neither row, so
            the E9 grid and its fixed right column are untouched. Account-global
            usage, the same envelope as the Account Usage page; nothing renders
            without an envelope, for a non-Claude session or a shown key. */}
          {accountUsage && <SessionAccountUsageMeters usage={accountUsage} />}

          {/* Row 2 (E9 → round 10) — Model | Effort (Claude only). TWO native
            drop-downs, each under its OWN heading. Model = the Create page's
            catalog select (`ModelEffortRow`'s `UiSelect` over `useClaudeModels`:
            "Default" + every live Anthropic model, one flat list — operator
            ruling 2026-09-07: NOT the in-chat ModelModePicker menu, which
            buried older models under "More models" and duplicated the Effort
            control). Effort = a native select over the levels the effective
            model supports (live catalog, static fallback). Effort sits in the
            SAME fixed narrow column as Permission Mode above, so the two share
            a left edge. */}
          {fields.modelMode.visible && (
            <div className="flex items-start gap-2" data-testid="config-row-2">
              <div className="min-w-0 flex-1">
                <FormField label="Model">
                  <UiSelect
                    value={modelSelectValue}
                    disabled={fields.modelMode.disabled}
                    data-testid="config-model-select"
                    onChange={e => onModelSelect(e.target.value)}
                  >
                    {/* Issue #2506 (2026-09-08 addendum AC1): when the session
                      is genuinely on the default (no mode/raw pin), NAME the
                      running model here instead of a bare "Default", so this
                      select agrees with the composer chip (which shows
                      resolvedModel). Only in the genuine-default case does
                      resolvedModel represent what "" resolves to — a mode/raw
                      pin resolves elsewhere, so those keep the generic label. */}
                    <option value="">
                      {current.modelMode === "default" &&
                      !current.rawModel &&
                      session.resolvedModel
                        ? formatModelName(session.resolvedModel)
                        : "Default"}
                    </option>
                    {/* A session running on a MODE (set via the in-chat picker,
                      no raw id) keeps that as a selectable current entry. */}
                    {current.modelMode !== "default" && (
                      <option
                        value={`${MODE_OPTION_PREFIX}${current.modelMode}`}
                      >
                        {MODEL_MODE_LABELS[current.modelMode]}
                      </option>
                    )}
                    {/* A raw id the live catalog does not list (custom /
                      retired) stays selectable so the select never shows a
                      wrong value. */}
                    {draft.rawModel &&
                      !claudeModels.some(
                        m => catalogOptionValue(m.id) === draft.rawModel
                      ) && (
                        <option value={draft.rawModel}>
                          {formatModelName(draft.rawModel)}
                        </option>
                      )}
                    {claudeModels.map(m => (
                      <option key={m.id} value={catalogOptionValue(m.id)}>
                        {m.displayName}
                      </option>
                    ))}
                  </UiSelect>
                </FormField>
              </div>
              <div
                className="shrink-0"
                style={{ width: NARROW_COL_PX }}
                data-testid="config-narrow-col-2"
              >
                <FormField label="Effort">
                  <UiSelect
                    value={draft.effort ?? ""}
                    disabled={fields.modelMode.disabled}
                    data-testid="config-effort-select"
                    onChange={e =>
                      setDraft(d => ({
                        ...d,
                        effort: (e.target.value || undefined) as
                          | EffortLevel
                          | undefined,
                      }))
                    }
                  >
                    <option value="">Default</option>
                    {effortLevels.map(level => (
                      <option key={level} value={level}>
                        {EFFORT_LEVEL_LABELS[level]}
                      </option>
                    ))}
                  </UiSelect>
                </FormField>
              </div>
            </div>
          )}

          {/* #3348: non-claude ACTIVE-model display (read-only). The claude Row 2
            above is gated by fields.modelMode.visible (the claude-modes catalog);
            gemini/codex show their ACTIVE model here instead — sourced from the
            spawn selection recorded on metadata.nativeModel (a flavor whose CLI
            does not report resolvedModel to Hapimatic). A codex model change
            RECREATES the session — there is NO in-place relaunch here (ruling
            D2(a)): the relaunch substrate is claude-hardcoded end-to-end, so this
            is DISPLAY + honest copy, never an editable picker.
            TODO(follow-up-issue): agent-generic relaunch substrate —
            server/src/sync/respawnBase.ts:42 hardcodes agent:"claude";
            sessionLifecycleOps.ts:343-357/:407-409 gates model restart to claude;
            sessionRelaunch.ts:137-143 returns not_claude. Generalizing these
            (per-flavor respawn base + flavor-aware relaunch delegate) is what
            unlocks an in-place codex model switch; until then the honest
            "recreate" copy from #3348 Task 5 stands. */}
          {agent !== "claude" && (
            <div
              className="flex flex-col gap-1"
              data-testid="config-native-model"
            >
              <FormField label="Model">
                <div
                  className="flex h-9 items-center rounded-md border border-dashed border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2.5 text-sm text-[var(--app-hint)]"
                  data-testid="config-native-model-value"
                >
                  {session.metadata?.nativeModel ??
                    session.resolvedModel ??
                    "Default"}
                </div>
              </FormField>
              {agent === "codex" && (
                <p className="text-xs text-[var(--app-hint)]">
                  Changing the model recreates the session — create a new Codex
                  session with the model you want.
                </p>
              )}
            </div>
          )}

          {/* MCP Servers (live plane) — collapsible subsection (R5): the
            subheading IS the header, Enable/Disable-All only when expanded. */}
          {fields.mcpServers.visible && (
            <McpServersSection
              mcp={mcp}
              desired={draft.mcpDesired}
              disabled={fields.mcpServers.disabled}
              onToggleServer={setMcpServer}
              onSetAll={setAllMcpServers}
            />
          )}

          {/* Cache-impact estimate (R8) — heuristic, shown BEFORE applying. */}
          {hasChanges && impact.bustsCache && (
            <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-xs text-[var(--app-fg)]">
              <span className="font-medium text-amber-500">
                ⚠ Prompt-cache impact
              </span>
              <p className="mt-1 text-[var(--app-hint)]">{impact.reason}</p>
              {impact.estimatedUsd != null && (
                <p className="mt-0.5 text-[var(--app-hint)]">
                  Est. ≈ ${impact.estimatedUsd.toFixed(2)} on the next turn
                  (heuristic).
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-[var(--app-badge-error-text)] bg-[var(--app-secondary-bg)] px-3 py-2 text-xs text-[var(--app-badge-error-text)]">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 border-t border-[var(--app-border)] px-4 py-3">
          {isDisconnected && (
            <div
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-xs text-[var(--app-hint)]"
              data-testid="config-disconnected-note"
            >
              This session is disconnected — saved changes apply automatically
              when it reconnects.
            </div>
          )}
          <div className="flex items-center gap-2">
            {/* Copy params (R7) — footer lower-left (operator round 12,
                2026-09-07: "move the 'copy launch params' button down to the
                lower left corner … change the text to just 'Copy params'").
                `mr-auto` pins it left; Cancel / Save-or-Apply keep the right. */}
            <Button
              type="button"
              variant="outline"
              onClick={() => void copy(buildCopyText())}
              data-testid="config-copy-params"
              className="mr-auto h-auto rounded-md px-2 py-1 text-xs font-normal text-[var(--app-hint)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
            >
              {copied ? "Copied ✓" : "Copy params"}
            </Button>
            <Button
              type="button"
              variant="ghostStatic"
              onClick={onClose}
              className="h-auto rounded-md px-3 py-1.5 text-xs font-normal hover:text-[var(--app-fg)]"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="accent"
              onClick={() => void handleApply()}
              disabled={
                !hasChanges || actions.isPending || accountActions.isPending
              }
              data-testid="config-apply"
              className="inline-flex h-auto items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-[var(--app-accent-fg)] hover:opacity-100"
            >
              {(actions.isPending || accountActions.isPending) && (
                <Spinner
                  size="sm"
                  label={isDisconnected ? "Saving" : "Applying"}
                  className="h-3 w-3"
                />
              )}
              {isDisconnected ? "Save changes" : "Apply changes"}
            </Button>
          </div>
        </div>
      </div>
      <AccountSelectorModal
        isOpen={accountModalOpen}
        onClose={() => setAccountModalOpen(false)}
        api={api}
        // Round 14 (item 7): stage the pick; `handleApply` performs the switch.
        scope="stage"
        sessionId={session.id}
        // #4464: an add from the picker stores the login on the session's node.
        addTargetNodeId={effectiveNodeId ?? undefined}
        currentAccountEmail={shownEmail}
        sessionFlavor={flavor}
        selectedAccountUuid={draftAccountUuid}
        onSelect={uuid =>
          setDraft(d => ({
            ...d,
            paymentMethod: { kind: "account", accountUuid: uuid },
          }))
        }
        // Issue #4823: the node's Anthropic keys beside the accounts (Claude
        // sessions only). A pick stages the key; Apply performs the switch.
        apiKeys={claudeSession ? anthropicKeys : undefined}
        selectedApiKeyId={draftApiKeyId ?? null}
        onSelectApiKey={
          claudeSession
            ? apiKeyId =>
                setDraft(d => ({
                  ...d,
                  paymentMethod: { kind: "api-key", apiKeyId },
                }))
            : undefined
        }
        apiKeysDisabledReason={keysDisabledReason}
      />
    </>
  );
}
