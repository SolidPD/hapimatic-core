// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import { LOCAL_NODE_ID, type NodeProviderAuthState } from "@hapi/protocol";
import type {
  OnboardingProviderKind,
  RedactedApiKey,
} from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import type { AgentType } from "@/components/NewSession/types";
import { useAccounts } from "@/hooks/queries/useAccounts";
import { useApiKeys } from "@/hooks/queries/useApiKeys";
import { useFederationNodesInfo } from "@/hooks/queries/useFederationHealthAvailable";
import { useProviderAuthState } from "@/hooks/queries/useProviderAuthState";
import type { Machine, RedactedAccount } from "@/types/api";

/**
 * Where a connected provider comes from: a stored account, this instance's own
 * credential, a stored API key, or a CLI login on this node (Codex, Gemini).
 * Whether a session needs a choice on Create to use it depends on the source and
 * the kind together (see `startRoutes`).
 */
export type ModelConnectionSource =
  | "account"
  | "instance"
  | "key"
  | "node-login";

export type ModelConnectionProvider = {
  kind: OnboardingProviderKind;
  /** The account or key's name. Never key material. */
  label: string;
  /** The harness a session on this provider runs by default. */
  harness: AgentType;
  source: ModelConnectionSource;
};

/** What Create still needs before a session there uses the provider (#6275 S1). */
export type StartChoice = "pick-key" | "pick-model";

/** A provider to start on; `harness` is the one its route runs on this node. */
export type StartProvider = ModelConnectionProvider & { choice?: StartChoice };

export type ModelConnection = {
  status: "connected" | "none" | "unknown";
  providers: ModelConnectionProvider[];
  /**
   * Every read answered. `connected` can come from one read while another is
   * still out or failed, so `providers` may then be partial.
   */
  complete: boolean;
};

/** What each read answered; `null` for one that failed or has not answered. */
export type ModelConnectionSources = {
  accounts: {
    accounts: RedactedAccount[];
    envCredentialPresent: boolean;
  } | null;
  apiKeys: RedactedApiKey[] | null;
  /** This node's row. */
  authState: NodeProviderAuthState | null;
};

const KIND_ORDER: OnboardingProviderKind[] = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "custom",
];

const KEY_PROVIDER: Record<
  string,
  { kind: OnboardingProviderKind; harness: AgentType; name: string }
> = {
  anthropic: {
    kind: "anthropic",
    harness: "claude",
    name: "Anthropic API key",
  },
  // Codex never reads an OpenAI key from the vault; OpenCode's native picker runs it.
  openai: { kind: "openai", harness: "opencode", name: "OpenAI API key" },
  gemini: { kind: "google", harness: "gemini", name: "Gemini API key" },
  google: { kind: "google", harness: "gemini", name: "Gemini API key" },
  openrouter: {
    kind: "openrouter",
    harness: "opencode",
    name: "OpenRouter API key",
  },
  custom: { kind: "custom", harness: "opencode", name: "Custom API key" },
};

const ACCOUNT_PROVIDER: Record<
  NonNullable<RedactedAccount["provider"]>,
  { kind: OnboardingProviderKind; harness: AgentType }
> = {
  anthropic: { kind: "anthropic", harness: "claude" },
  openai: { kind: "openai", harness: "codex" },
  google: { kind: "google", harness: "gemini" },
};

/**
 * The one answer to "does this node have a model" (#6211 R11). `none` needs every
 * source to have answered empty, so a failed or pending read can only give
 * `unknown`, which no surface may act on. A source that did find a provider is
 * enough for `connected` while another read is still out.
 *
 * Spawn stays the authority: a key whose harness is not installed still reads as
 * connected, and its spawn reports why.
 *
 * A Codex row with mode `unknown` counts as nothing. Every VM has one, for a Codex
 * home with no `auth.json`, so treating it as a failed read would hide the nudge on
 * exactly the new VMs it is for. The cost is a keyring-only Codex login reading as
 * none, which is unusual on a headless VM and only ever shows a dismissible nudge.
 */
export function deriveModelConnection(
  sources: ModelConnectionSources
): ModelConnection {
  const { accounts, apiKeys, authState } = sources;
  const providers: ModelConnectionProvider[] = [];

  for (const account of accounts?.accounts ?? []) {
    providers.push({
      ...ACCOUNT_PROVIDER[account.provider ?? "anthropic"],
      label: account.nickname || account.emailAddress || account.displayName,
      source: "account",
    });
  }
  if (accounts?.envCredentialPresent) {
    providers.push({
      kind: "anthropic",
      harness: "claude",
      label: "Instance credential",
      source: "instance",
    });
  }

  for (const key of apiKeys ?? []) {
    const known = KEY_PROVIDER[key.provider] ?? KEY_PROVIDER.custom!;
    providers.push({
      kind: known.kind,
      harness: known.harness,
      label: key.label || known.name,
      source: "key",
    });
  }

  const storedAccounts = new Set(accounts?.accounts.map(a => a.accountUuid));
  for (const row of authState?.openai ?? []) {
    if (row.mode !== "chatgpt" && row.mode !== "api-key") continue;
    if (row.accountUuid && storedAccounts.has(row.accountUuid)) continue;
    providers.push({
      kind: "openai",
      harness: "codex",
      label: row.email || row.label || "OpenAI (Codex)",
      source: "node-login",
    });
  }

  const google = authState?.google;
  const googleSignedIn =
    google &&
    (google.bound ||
      google.selectedAuthType === "google-login" ||
      google.selectedAuthType === "vertex");
  if (googleSignedIn && !providers.some(p => p.kind === "google")) {
    providers.push({
      kind: "google",
      harness: "gemini",
      label: "Gemini",
      source: "node-login",
    });
  }

  const complete = accounts !== null && apiKeys !== null && authState !== null;
  if (providers.length > 0) {
    providers.sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    );
    return { status: "connected", providers, complete };
  }
  return { status: complete ? "none" : "unknown", providers, complete };
}

/**
 * The harnesses this node's daemon reports, read as the Create page reads them: no answer
 * means anything goes. Its default target on a fresh install is the first machine.
 */
export function nodeAgents(machines: Machine[]): AgentType[] | undefined {
  const agents = machines[0]?.metadata?.capabilities
    ?.filter(c => c.startsWith("agent:"))
    .map(c => c.slice("agent:".length) as AgentType);
  return agents && agents.length > 0 ? agents : undefined;
}

type StartRoute = { harness: AgentType; choice?: StartChoice };

/**
 * The harnesses a provider can start on, in order, with what Create still needs for each. An
 * account or a node login is used by default. OpenRouter also runs through Codex (#1733), and
 * every gateway key needs a model. Of the other stored keys (#6275 S1): Claude Code uses an
 * Anthropic key only once it is picked under Provider Account; Codex never reads an OpenAI key
 * from the vault (`cli/src/daemon/sessionSpawner.ts`), so OpenCode's native picker runs it, with
 * a model; Gemini reads its key at spawn.
 */
function startRoutes(provider: ModelConnectionProvider): StartRoute[] {
  if (provider.kind === "openrouter") {
    return [
      { harness: "opencode", choice: "pick-model" },
      { harness: "codex", choice: "pick-model" },
    ];
  }
  if (provider.kind === "custom") {
    return [{ harness: "opencode", choice: "pick-model" }];
  }
  if (provider.source === "key" && provider.kind === "anthropic") {
    return [{ harness: "claude", choice: "pick-key" }];
  }
  if (provider.source === "key" && provider.kind === "openai") {
    return [{ harness: "opencode", choice: "pick-model" }];
  }
  return [{ harness: provider.harness }];
}

/**
 * The connected provider a first session here should start on, with the harness it runs on here
 * and any choice Create still needs. One that needs no choice wins over an earlier one that does.
 * None means no connected model can run here, and preselecting a harness the node lacks only
 * fails the first session.
 */
export function startProvider(
  providers: ModelConnectionProvider[],
  available: AgentType[] | undefined
): StartProvider | undefined {
  let needsChoice: StartProvider | undefined;
  for (const provider of providers) {
    const route = startRoutes(provider).find(
      r => !available || available.includes(r.harness)
    );
    if (!route) continue;
    if (!route.choice) return { ...provider, harness: route.harness };
    needsChoice ??= {
      ...provider,
      harness: route.harness,
      choice: route.choice,
    };
  }
  return needsChoice;
}

/** This node's provider-auth row, under either name the envelope uses for it. */
function localAuthRow(
  nodes: NodeProviderAuthState[],
  localNodeId: string | undefined
): NodeProviderAuthState | null {
  const row =
    nodes.find(n => n.nodeId === LOCAL_NODE_ID) ??
    nodes.find(n => n.nodeId === localNodeId) ??
    (nodes.length === 1 ? nodes[0] : undefined);
  return row && row.status === "ok" ? row : null;
}

/**
 * This node's answer, composed from reads the app already makes. It reads this
 * node only, because a node with no model cannot start a local session; a caller
 * with a remote target should not gate on it. The shared query keys mean an add
 * elsewhere (`useInvalidateAfterAdd`) updates every consumer.
 *
 * The provider-auth read fans out across the federation and polls every 60 s, so a
 * surface that only needs the status holds it until the accounts and keys have both
 * answered with nothing. `everyProvider` keeps it on, for the wizard's full
 * Connected list.
 */
export function useModelConnection(
  api: ApiClient | null,
  options: { everyProvider?: boolean } = {}
): ModelConnection {
  const accounts = useAccounts(api, true);
  const apiKeys = useApiKeys(api);
  const foundWithoutAuthRead =
    accounts.accounts.length > 0 ||
    accounts.envCredentialPresent ||
    (apiKeys.data?.length ?? 0) > 0;
  const authState = useProviderAuthState(
    api,
    options.everyProvider === true ||
      (accounts.answered && apiKeys.isFetched && !foundWithoutAuthRead)
  );
  const federation = useFederationNodesInfo(api);

  const accountList = accounts.accounts;
  const envCredentialPresent = accounts.envCredentialPresent;
  const accountsAnswered = accounts.answered;
  const keyList = apiKeys.isSuccess ? apiKeys.data : null;
  const authNodes = authState.nodes;
  const authAnswered = !authState.awaitingAnswer && authState.error === null;
  const localNodeId = federation.data?.localNode?.nodeId;

  return useMemo(
    () =>
      deriveModelConnection({
        accounts: accountsAnswered
          ? { accounts: accountList, envCredentialPresent }
          : null,
        apiKeys: keyList,
        authState: authAnswered ? localAuthRow(authNodes, localNodeId) : null,
      }),
    [
      accountList,
      accountsAnswered,
      authAnswered,
      authNodes,
      envCredentialPresent,
      keyList,
      localNodeId,
    ]
  );
}
