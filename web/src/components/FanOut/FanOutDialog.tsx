// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { LOCAL_NODE_ID } from "@hapi/protocol";
import type { EffortLevel } from "@hapi/protocol";
import { resolveSpawnPermissionMode } from "@hapi/protocol/modes";
import type { ApiClient } from "@/api/client";
import type { Machine, Session } from "@/types/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/Textarea";
import { Spinner } from "@/components/Spinner";
import { AccountSelectorModal } from "@/components/AccountSelectorModal";
import { AgentSelector } from "@/components/NewSession/AgentSelector";
import { AccountSelector } from "@/components/NewSession/AccountSelector";
import {
  MachineSelector,
  MACHINE_PREFIX,
  NODE_PREFIX,
  parseSpawnTarget,
} from "@/components/NewSession/MachineSelector";
import { SessionTypeSelector } from "@/components/NewSession/SessionTypeSelector";
import { ProviderModelFields } from "@/components/NewSession/ProviderModelFields";
import { deriveFormState } from "@/components/NewSession/formState";
import { buildSpawnInput } from "@/components/NewSession/spawnCommand";
import { useLauncherSelection } from "@/components/NewSession/useLauncherSelection";
import { useSpawnCapacity } from "@/components/NewSession/useSpawnCapacity";
import type { AgentType, SessionType } from "@/components/NewSession/types";
import { useMachines } from "@/hooks/queries/useMachines";
import { useAccounts, useNodeActiveAccount } from "@/hooks/queries/useAccounts";
import { useDaemonCapacity } from "@/hooks/queries/useDaemonCapacity";
import {
  useFederatedSessions,
  type FederationRemoteNode,
} from "@/hooks/queries/useFederatedSessions";
import { useAdminPreferences } from "@/hooks/useAdminPreferences";
import { getCurrentBranchV2, parseStatusSummaryV2 } from "@/lib/gitParsers";
import {
  FAN_OUT_MAX,
  FAN_OUT_MIN,
  REFUSAL_LABEL,
  buildPeerInput,
  computeFanOutCapacity,
  remoteCutBranch,
  useFanOutSpawn,
  type FanOutCapacityNotice,
  type FanOutParent,
  type FanOutPeerOutcome,
  type FanOutPeerRequest,
} from "./useFanOutSpawn";

/**
 * Fan-out dialog (#3818 Slice 2, ruling D3 = A). Launched from the session
 * header's kebab; the open session becomes the parent. One prompt + a peer
 * repeater (N = 2…5): per peer the harness, model, account (hub peers only —
 * a node spawns on its own default account) and target — the
 * create page's own selector components, on a machine of the hub the browser
 * is connected to or (#4497) another federation node. Each peer defaults to a
 * worktree off the parent's directory so the peers do not edit the same files.
 */
type PeerDraft = {
  key: string;
  agent: AgentType;
  machineId: string | null;
  /** #4497: a remote target (mutually exclusive with `machineId`). */
  nodeId: string | null;
  /** #4497: the directory on the remote node (prefilled with the parent's). */
  directory: string;
  accountUuid: string | null;
  sessionType: SessionType;
  selectedModel: string;
  rawModel: string;
  effort: EffortLevel | "";
  geminiModel: string;
  codexModel: string;
  codexEffort: string;
  opencodeProvider: string;
  opencodeModel: string;
};

const KNOWN_AGENTS: readonly AgentType[] = [
  "claude",
  "codex",
  "gemini",
  "opencode",
];

let peerSeq = 0;
function newPeer(
  agent: AgentType,
  machineId: string | null,
  directory: string
): PeerDraft {
  peerSeq += 1;
  return {
    key: `peer-${peerSeq}`,
    agent,
    machineId,
    nodeId: null,
    directory,
    accountUuid: null,
    sessionType: "worktree",
    selectedModel: "",
    rawModel: "",
    effort: "",
    geminiModel: "",
    codexModel: "",
    codexEffort: "",
    opencodeProvider: "",
    opencodeModel: "",
  };
}

/** A peer's target capabilities: its hub machine's, or (#4497) its node's. */
function targetCaps(
  machines: Machine[],
  remoteNodes: readonly FederationRemoteNode[],
  p: Pick<PeerDraft, "machineId" | "nodeId">
): string[] | undefined {
  if (p.nodeId)
    return remoteNodes.find(n => n.nodeId === p.nodeId)?.capabilities;
  return machines.find(m => m.id === p.machineId)?.metadata?.capabilities;
}

function agentsFor(caps: string[] | undefined) {
  if (!caps) return undefined; // no capability info: optimistic
  const agents = caps
    .filter(c => c.startsWith("agent:"))
    .map(c => c.slice("agent:".length) as AgentType);
  return agents.length > 0 ? agents : undefined;
}

function providerFor(agent: AgentType) {
  return agent === "codex"
    ? "openai"
    : agent === "gemini"
      ? "google"
      : undefined;
}

/** #4497: the separator of a remote directory check's node + path key. */
const NUL = String.fromCharCode(0);
const DIR_CHECK_DEBOUNCE_MS = 300;

function outcomeLine(o: FanOutPeerOutcome): string {
  const where = o.nodeLabel ? ` (on ${o.nodeLabel})` : "";
  if (o.status === "unconfirmed") {
    // The message already names the node.
    return `unconfirmed — ${o.message}`;
  }
  if (o.status === "refused") {
    return `refused (${REFUSAL_LABEL[o.refusal]}) — ${o.message}${where}`;
  }
  // Both facts are reported: the link state never hides a failed prompt.
  const prompt = o.prompt.ok
    ? "prompt queued"
    : `prompt not queued — ${o.prompt.error}`;
  const link =
    o.linked === false
      ? " — not linked to this session"
      : o.linked === undefined
        ? " (link not verified)"
        : "";
  return `spawned, ${prompt}${link}${where}`;
}

/** #4497: one target's capacity notice text (over capacity, or past the
 *  recommended count). */
function capacityLine(
  notice: Exclude<FanOutCapacityNotice, { kind: "none" }>,
  target: string | null
): string {
  if (notice.kind === "over") {
    const head = target ? `On ${target}: ` : "";
    return `${head}${notice.requested} peers requested, ${notice.free} of ${notice.max} slots free (${notice.effectiveCount} running) — the extra spawns will be refused.`;
  }
  return `${notice.requested} more sessions takes ${target ?? "this hub"} past its recommended ${notice.recommended} (${notice.effectiveCount} running).`;
}

export function FanOutDialog(props: {
  isOpen: boolean;
  onClose: () => void;
  api: ApiClient | null;
  /** The open session — the fan-out's parent. */
  parent: Session;
  parentTitle: string;
}) {
  const { isOpen, onClose, api, parent, parentTitle } = props;
  const parentDirectory = parent.metadata?.path ?? "";
  const parentAgent: AgentType = KNOWN_AGENTS.includes(
    parent.metadata?.flavor as AgentType
  )
    ? (parent.metadata?.flavor as AgentType)
    : "claude";

  const { machines, isLoading: machinesLoading } = useMachines(api, isOpen);
  const { accounts, isLoading: accountsLoading } = useAccounts(api, isOpen);
  const { activeAccount } = useNodeActiveAccount(api, LOCAL_NODE_ID, isOpen);
  const { globalDefaultLauncher } = useLauncherSelection();
  const { prefs } = useAdminPreferences();
  const capacity = useSpawnCapacity(api, isOpen ? { kind: "local" } : null);
  const capSource = useDaemonCapacity(api, { enabled: isOpen }).data?.capSource;
  const { remoteNodes } = useFederatedSessions(api);
  const { fanOut, isPending } = useFanOutSpawn(api);

  // The cut point (epic #4406 T27): the parent's CURRENT branch. Read through
  // the core git-status route (not the git-rpc extension); null = detached HEAD,
  // unreadable status or an inactive parent — peers then cut from the default.
  // #4497: the same read also yields the branch's upstream (`origin/<b>`), the
  // only cut point a remote node can resolve.
  const branchQuery = useQuery({
    queryKey: ["fan-out-parent-branch", parent.id],
    queryFn: async (): Promise<{
      branch: string | null;
      upstream: string | null;
    }> => {
      if (!api) return { branch: null, upstream: null };
      const res = await api.getGitStatus(parent.id);
      if (!res.success) return { branch: null, upstream: null };
      const summary = parseStatusSummaryV2(res.stdout ?? "");
      return {
        branch: getCurrentBranchV2(summary),
        upstream: summary.branch.upstream ?? null,
      };
    },
    enabled: isOpen && parent.active && Boolean(api),
    staleTime: 10_000,
    retry: false,
  });
  const parentBranch = parent.active
    ? (branchQuery.data?.branch ?? null)
    : null;
  const parentUpstream = parent.active
    ? (branchQuery.data?.upstream ?? null)
    : null;
  const remoteCut = remoteCutBranch(parentUpstream);

  const defaultMachineId =
    (machines.find(m => m.id === parent.metadata?.machineId) ?? machines[0])
      ?.id ?? null;

  const [prompt, setPrompt] = useState("");
  const [peers, setPeers] = useState<PeerDraft[]>([]);
  // #4497: the submitted peers (shown at once) and each one's outcome as it
  // settles; `done` once the whole batch returned.
  const [submitted, setSubmitted] = useState<FanOutPeerRequest[] | null>(null);
  const [settled, setSettled] = useState<Record<string, FanOutPeerOutcome>>({});
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountFor, setAccountFor] = useState<string | null>(null);

  // Every opening starts from two peers on the parent's harness and machine.
  useEffect(() => {
    if (!isOpen) return;
    setPrompt("");
    setSubmitted(null);
    setSettled({});
    setDone(false);
    setError(null);
    setPeers([
      newPeer(parentAgent, defaultMachineId, parentDirectory),
      newPeer(parentAgent, defaultMachineId, parentDirectory),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [isOpen]);

  // Fill a machine in once the machine list arrives.
  useEffect(() => {
    if (!defaultMachineId) return;
    setPeers(ps =>
      ps.map(p =>
        p.machineId || p.nodeId ? p : { ...p, machineId: defaultMachineId }
      )
    );
  }, [defaultMachineId]);

  const update = (key: string, patch: Partial<PeerDraft>) =>
    setPeers(ps => ps.map(p => (p.key === key ? { ...p, ...patch } : p)));

  const formStates = useMemo(
    () =>
      peers.map(p =>
        deriveFormState({
          agent: p.agent,
          sessionType: p.sessionType,
          isRemoteTarget: Boolean(p.nodeId),
          isFormDisabled: isPending,
          directoryHasGitRepo: parentBranch != null,
          directoryIsGitRepo: parentBranch != null ? true : undefined,
          sessionTypeUserSelected: true,
          cloneRepo: null,
          permissionMode: resolveSpawnPermissionMode(
            prefs.defaultSpawnPermissionMode,
            p.agent
          ),
          safeMode: false,
          launcher: globalDefaultLauncher,
          worktreeName: "",
          existingBranch: null,
          accountUuid: p.accountUuid,
          accountsCount: accounts.length,
          apiKeyId: null,
          agentSupportsOpenRouter:
            targetCaps(machines, remoteNodes, p)?.includes(
              "gateway:openrouter"
            ) ?? false,
          selectedModel: p.selectedModel,
          selectedModelMode: "default",
          selectedEffort: p.effort,
          selectedRawModel: p.rawModel,
          selectedGeminiModel: p.geminiModel,
          selectedCodexModel: p.codexModel,
          selectedCodexEffort: p.codexEffort,
          selectedOpencodeProvider: p.opencodeProvider,
          selectedOpencodeModel: p.opencodeModel,
        })
      ),
    [
      peers,
      isPending,
      parentBranch,
      prefs.defaultSpawnPermissionMode,
      globalDefaultLauncher,
      accounts.length,
      machines,
      remoteNodes,
    ]
  );

  // #4497 R8: check each remote peer's directory on its node (debounced; an
  // unanswered check never blocks — the node then refuses with its message).
  const remoteDirsKey = peers
    .filter(p => p.nodeId)
    .map(p => `${p.nodeId}${NUL}${p.directory.trim()}`)
    .join("\n");
  const [checkedDirsKey, setCheckedDirsKey] = useState(remoteDirsKey);
  useEffect(() => {
    const t = setTimeout(
      () => setCheckedDirsKey(remoteDirsKey),
      DIR_CHECK_DEBOUNCE_MS
    );
    return () => clearTimeout(t);
  }, [remoteDirsKey]);
  const dirPairs = useMemo(
    () =>
      Array.from(new Set(checkedDirsKey ? checkedDirsKey.split("\n") : []))
        .map(k => k.split(NUL) as [string, string])
        .filter(([, dir]) => dir.length > 0),
    [checkedDirsKey]
  );
  const dirChecks = useQueries({
    queries: dirPairs.map(([nodeId, dir]) => ({
      queryKey: ["fan-out-node-path", nodeId, dir],
      queryFn: async (): Promise<boolean | null> => {
        if (!api) return null;
        const res = await api.checkNodePathsExists(nodeId, [dir]);
        return res.exists?.[dir] ?? null;
      },
      enabled: isOpen && Boolean(api),
      staleTime: 30_000,
      retry: false,
    })),
  });
  /** true = exists, false = confirmed missing, null = unknown / pending. */
  const remoteDirExists = (p: PeerDraft): boolean | null => {
    const i = dirPairs.findIndex(
      ([n, d]) => n === p.nodeId && d === p.directory.trim()
    );
    return i >= 0 ? (dirChecks[i]?.data ?? null) : null;
  };
  const nodeLabelOf = (nodeId: string) =>
    remoteNodes.find(n => n.nodeId === nodeId)?.nodeLabel ?? nodeId;

  // #4497 R9: one notice per target that warns — the hub from its daemon, a
  // node from its federation summary (a missing field = unknown, no notice).
  const capacityNotices: {
    key: string;
    target: string | null;
    notice: Exclude<FanOutCapacityNotice, { kind: "none" }>;
  }[] = [];
  const localCount = peers.filter(p => !p.nodeId).length;
  if (localCount > 0) {
    const notice = computeFanOutCapacity(localCount, capacity);
    if (notice.kind !== "none") {
      capacityNotices.push({ key: "local", target: null, notice });
    }
  }
  for (const nodeId of new Set(
    peers.flatMap(p => (p.nodeId ? [p.nodeId] : []))
  )) {
    const node = remoteNodes.find(n => n.nodeId === nodeId);
    const notice = computeFanOutCapacity(
      peers.filter(p => p.nodeId === nodeId).length,
      {
        effectiveCount: node?.effectiveCount ?? null,
        max: node?.maxConcurrent ?? null,
        recommended: node?.recommendedConcurrent ?? null,
      }
    );
    if (notice.kind !== "none") {
      capacityNotices.push({
        key: nodeId,
        target: nodeLabelOf(nodeId),
        notice,
      });
    }
  }
  const anyRemote = peers.some(p => p.nodeId);
  const anyShared = peers.some(
    (_, i) => formStates[i]?.effective.sessionType !== "worktree"
  );
  const trimmed = prompt.trim();
  const canSubmit =
    !isPending &&
    submitted === null &&
    trimmed.length > 0 &&
    parentDirectory.length > 0 &&
    peers.length >= FAN_OUT_MIN &&
    peers.every(p => p.machineId || p.nodeId) &&
    peers.every(
      p =>
        !p.nodeId ||
        (p.directory.trim().length > 0 && remoteDirExists(p) !== false)
    );

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError(null);
    const fanParent: FanOutParent = {
      id: parent.id,
      directory: parentDirectory,
      branch: parentBranch,
      upstream: parentUpstream,
    };
    const requests: FanOutPeerRequest[] = peers.map((p, i) => {
      const eff = formStates[i]!.effective;
      const base = buildSpawnInput({
        target: p.nodeId
          ? { kind: "remote", nodeId: p.nodeId }
          : { kind: "local", machineId: p.machineId! },
        directory: p.nodeId ? p.directory : parentDirectory,
        agent: eff.agent,
        yolo: eff.yolo,
        safeMode: eff.safeMode,
        launcher: eff.launcher ?? globalDefaultLauncher,
        globalDefaultLauncher,
        sessionType: eff.sessionType,
        worktreeName: "",
        name: `${parentTitle} · peer ${i + 1}`,
        accountUuid: eff.accountUuid ?? null,
        hasStoredAccounts: accounts.length > 0,
        model: eff.model,
        modelRouting: eff.modelRouting,
        modelMode: eff.modelMode,
        effort: eff.effort,
        rawModel: eff.rawModel,
        geminiModel: eff.geminiModel,
        codexModel: eff.codexModel,
        codexReasoningEffort: eff.codexReasoningEffort,
        cloneRepo: null,
      });
      const { input, cutFrom } = buildPeerInput(base, fanParent);
      return {
        key: p.key,
        label: `Peer ${i + 1}`,
        input,
        cutFrom,
        ...(p.nodeId ? { nodeLabel: nodeLabelOf(p.nodeId) } : {}),
      };
    });
    // #4497 R7: the outcome list shows at once; each peer fills in as it settles.
    setSubmitted(requests);
    setSettled({});
    setDone(false);
    try {
      const final = await fanOut(parent.id, trimmed, requests, o =>
        setSettled(s => ({ ...s, [o.key]: o }))
      );
      setSettled(Object.fromEntries(final.map(o => [o.key, o])));
      setDone(true);
    } catch (err) {
      setSubmitted(null);
      setError(err instanceof Error ? err.message : "Fan-out failed");
    }
  };

  const editingPeer = peers.find(p => p.key === accountFor);

  return (
    // Escape, an outside click and the close button are ignored while the
    // peers spawn: unmounting mid-run would lose every outcome and allow a
    // second fan-out.
    <Dialog
      open={isOpen}
      onOpenChange={open => {
        if (!open && !isPending) onClose();
      }}
    >
      <DialogContent className="max-w-lg max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Fan out from this session</DialogTitle>
          <DialogDescription className="mt-2">
            Spawn {FAN_OUT_MIN}–{FAN_OUT_MAX} peer sessions on this hub or
            another federation node, linked to this session, and queue the same
            prompt to each.
          </DialogDescription>
        </DialogHeader>

        {submitted ? (
          <div
            className="mt-3 space-y-2"
            data-testid="fan-out-outcomes"
            data-state={done ? "done" : "running"}
          >
            <ul className="space-y-1 text-sm">
              {submitted.map(r => {
                const o = settled[r.key];
                return (
                  <li key={r.key} data-testid={`fan-out-outcome-${r.key}`}>
                    <span className="font-semibold">{r.label}:</span>{" "}
                    {o ? (
                      <>
                        {outcomeLine(o)}
                        {o.cutFrom === "repo-default" &&
                        o.status === "spawned" ? (
                          <span className="text-[var(--app-hint)]">
                            {" "}
                            (cut from the repo's default branch)
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[var(--app-hint)]">
                        <Spinner size="sm" label={null} />
                        waiting…
                        {r.nodeLabel ? ` (on ${r.nodeLabel})` : ""}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {done ? (
              <div className="flex justify-end">
                <Button type="button" variant="secondary" onClick={onClose}>
                  Close
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="mt-3">
              <Textarea
                aria-label="Prompt"
                placeholder="Prompt to queue to every peer"
                rows={4}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                disabled={isPending}
                autoFocus
              />
            </div>
            <p
              className="mt-2 text-[length:var(--text-caption)] text-[var(--app-hint)]"
              data-testid="fan-out-cut"
            >
              {parentBranch
                ? `Worktree peers start from this session's branch (${parentBranch}) at its last commit; uncommitted changes are not carried over.`
                : "Worktree peers start from the repo's default branch (this session's branch is unknown)."}
              {anyRemote
                ? remoteCut
                  ? ` Peers on another node start from origin/${remoteCut} and do not carry unpushed commits.`
                  : " Peers on another node start from their repo's default branch (this session's branch has no upstream on origin)."
                : ""}
            </p>
            {anyShared ? (
              <p
                className="mt-1 text-[length:var(--text-caption)] text-[var(--app-badge-warning-text)]"
                data-testid="fan-out-shared-files"
              >
                A Basic peer runs in this session's directory, so the peers will
                share files.
              </p>
            ) : null}
            {capacityNotices.map(({ key, target, notice }) => (
              <p
                key={key}
                className="mt-1 text-[length:var(--text-caption)] text-[var(--app-badge-warning-text)]"
                data-testid="fan-out-capacity"
              >
                {capacityLine(notice, target)}
                {target === null && capSource
                  ? ` Cap source: ${capSource}.`
                  : ""}
              </p>
            ))}

            <div className="mt-3 space-y-3">
              {peers.map((p, i) => {
                const fs = formStates[i]!;
                return (
                  <div
                    key={p.key}
                    className="rounded-md border border-[var(--app-border)] py-1"
                    data-testid="fan-out-peer"
                  >
                    <div className="flex items-center justify-between px-3 pt-1">
                      <span className="text-sm font-semibold">
                        Peer {i + 1}
                      </span>
                      {peers.length > FAN_OUT_MIN ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setPeers(ps => ps.filter(x => x.key !== p.key))
                          }
                          disabled={isPending}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                    <MachineSelector
                      machines={machines}
                      remoteNodes={remoteNodes}
                      machineId={
                        p.nodeId
                          ? `${NODE_PREFIX}${p.nodeId}`
                          : p.machineId
                            ? `${MACHINE_PREFIX}${p.machineId}`
                            : null
                      }
                      isLoading={machinesLoading}
                      isDisabled={isPending}
                      onChange={value => {
                        const t = parseSpawnTarget(value);
                        if (t?.kind === "local") {
                          update(p.key, {
                            machineId: t.machineId,
                            nodeId: null,
                          });
                        } else if (t?.kind === "remote") {
                          // A remote spawn uses the node's default account.
                          update(p.key, {
                            nodeId: t.nodeId,
                            machineId: null,
                            accountUuid: null,
                          });
                        }
                      }}
                    />
                    {p.nodeId ? (
                      <RemoteDirectoryField
                        nodeLabel={nodeLabelOf(p.nodeId)}
                        value={p.directory}
                        exists={remoteDirExists(p)}
                        isDisabled={isPending}
                        onChange={directory => update(p.key, { directory })}
                      />
                    ) : null}
                    <div className="px-3 py-1.5">
                      <AgentSelector
                        agent={p.agent}
                        isDisabled={isPending}
                        availableAgents={agentsFor(
                          targetCaps(machines, remoteNodes, p)
                        )}
                        onAgentChange={agent =>
                          update(p.key, { agent, accountUuid: null })
                        }
                      />
                    </div>
                    <div className="px-3 py-1.5">
                      <ProviderModelFields
                        fields={fs.fields}
                        agent={p.agent}
                        selectedModel={p.selectedModel}
                        onSelectedModelChange={v =>
                          update(p.key, { selectedModel: v })
                        }
                        api={api}
                        rawModel={p.rawModel}
                        effort={p.effort}
                        onRawModelChange={v => update(p.key, { rawModel: v })}
                        onEffortChange={v => update(p.key, { effort: v })}
                        geminiModel={p.geminiModel}
                        onGeminiModelChange={v =>
                          update(p.key, { geminiModel: v })
                        }
                        codexModel={p.codexModel}
                        onCodexModelChange={v =>
                          update(p.key, { codexModel: v })
                        }
                        codexEffort={p.codexEffort}
                        onCodexEffortChange={v =>
                          update(p.key, { codexEffort: v })
                        }
                        opencodeProvider={p.opencodeProvider}
                        onOpencodeProviderChange={v =>
                          update(p.key, { opencodeProvider: v })
                        }
                        opencodeModel={p.opencodeModel}
                        onOpencodeModelChange={v =>
                          update(p.key, { opencodeModel: v })
                        }
                        vaultKeys={[]}
                      />
                    </div>
                    {fs.fields.account.visible ? (
                      <div className="px-3 py-1.5">
                        <AccountSelector
                          accounts={accounts}
                          selectedUuid={p.accountUuid}
                          activeAccountUuid={activeAccount?.accountUuid ?? null}
                          isLoading={accountsLoading}
                          isDisabled={fs.fields.account.disabled}
                          label={fs.fields.account.label}
                          onOpen={() => setAccountFor(p.key)}
                        />
                      </div>
                    ) : null}
                    <div className="px-3 py-1.5">
                      <SessionTypeSelector
                        sessionType={p.sessionType}
                        isDisabled={isPending}
                        onSessionTypeChange={sessionType =>
                          update(p.key, { sessionType })
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {peers.length < FAN_OUT_MAX ? (
              <div className="mt-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setPeers(ps => [
                      ...ps,
                      newPeer(parentAgent, defaultMachineId, parentDirectory),
                    ])
                  }
                  disabled={isPending}
                >
                  Add peer
                </Button>
              </div>
            ) : null}

            {error ? (
              <div className="mt-3 rounded-md bg-red-900/20 p-3 text-sm text-red-400">
                {error}
              </div>
            ) : null}

            <div className="mt-4 flex gap-2 justify-end">
              <Button
                type="button"
                variant="secondary"
                onClick={onClose}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="secondary"
                data-testid="fan-out-submit"
                onClick={handleSubmit}
                disabled={!canSubmit}
              >
                {isPending ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner size="sm" label={null} className="!text-inherit" />
                    Spawning...
                  </span>
                ) : (
                  `Spawn ${peers.length} peers`
                )}
              </Button>
            </div>
          </>
        )}

        <AccountSelectorModal
          isOpen={accountFor !== null}
          onClose={() => setAccountFor(null)}
          api={api}
          scope="spawn"
          providerScope={
            (editingPeer && providerFor(editingPeer.agent)) ?? "anthropic"
          }
          selectedAccountUuid={editingPeer?.accountUuid ?? null}
          onSelect={uuid => {
            if (accountFor) update(accountFor, { accountUuid: uuid });
            setAccountFor(null);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** #4497 R8: the directory a remote peer runs in, on its own node. */
function RemoteDirectoryField(props: {
  nodeLabel: string;
  value: string;
  exists: boolean | null;
  isDisabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="px-3 py-1.5" data-testid="fan-out-remote-directory">
      <label className="block text-[length:var(--text-caption)] text-[var(--app-hint)]">
        Directory on {props.nodeLabel}
        <input
          type="text"
          className="mt-1 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm text-[var(--app-fg)]"
          value={props.value}
          disabled={props.isDisabled}
          onChange={e => props.onChange(e.target.value)}
        />
      </label>
      {props.exists === false ? (
        <p className="mt-1 text-[length:var(--text-caption)] text-[var(--app-badge-warning-text)]">
          not found on {props.nodeLabel}
        </p>
      ) : null}
    </div>
  );
}
