// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@/api/client";
import type {
  AccountsResponse,
  AccountUsageResponse,
  RedactedAccount,
  InVmLoginStartResponse,
  SetSessionPaymentMethodRequest,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/components/Toast";
import { reloginToastFromError } from "@/lib/reloginLink";
import {
  markActionPending,
  clearActionPending,
} from "@/lib/session-action-pending";

/**
 * Mutations backing the AccountSelectorModal (epic #1446, Sub-Issue H).
 *
 * `selectAccount` branches on scope:
 *   - per-session → `POST /api/sessions/:id/account` (Sub-Issue J #1456)
 *   - per-node    → `POST /api/nodes/:nodeId/active-account` (Sub-Issue F #1452)
 * `removeAccount` → `DELETE /api/accounts/:uuid` (Sub-Issue E #1451).
 *
 * A 409 `last_account` rejection is deliberately left to propagate so the
 * calling `ConfirmDialog` surfaces it and stays open (R7).
 */
/**
 * One (account × node) removal outcome from the multi-account mutation (issue
 * #2131 — generalized from the #2054 single-account shape by tagging each result
 * with its `accountUuid` so the aggregated toast + per-account optimistic restore
 * can attribute failures correctly).
 */
export type RemoveFromNodesResult =
  | { accountUuid: string; nodeId: string; ok: true }
  | {
      accountUuid: string;
      nodeId: string;
      ok: false;
      code?: string;
      message: string;
    };

/** Variables for the multi-account, multi-node removal mutation (issue #2131). */
export type RemoveAccountsFromNodesVars = {
  /** The (account → checked nodes) pairs the user selected in the modal. */
  removals: { accountUuid: string; nodeIds: string[] }[];
  /** The currently-viewed node — drives optimistic card removal (R7). */
  currentNodeId: string | null;
  /** nodeId → label, so the partial-success toast can name nodes (R7). */
  nodeLabels?: Record<string, string>;
};

/**
 * Issue #2300 (Task 1, R1): map an account-SWITCH failure to an actionable toast
 * instead of the hardcoded generic string. Switches on the server's
 * `ApiError.code` (a code LITERAL since #2300 Task 6's parseErrorCode fix). The
 * default falls back to the server's human `error` message from the JSON body —
 * NOT `err.message`, which is the transport `HTTP <status>: <raw body>` composite.
 */
export function mapSwitchError(err: unknown): {
  message: string;
  action?: { label: string; onClick: () => void };
} {
  const code = err instanceof ApiError ? err.code : undefined;
  if (code === "account_unrefreshable") {
    // Issue #4461 (R8): name the node whose store refused and offer the re-login
    // for THAT node. A pre-#4461 peer's body carries no node — keep today's text.
    return (
      reloginToastFromError(err) ?? {
        message: "Re-login required for this account before it can be used.",
      }
    );
  }
  return { message: mapSwitchErrorText(err, code) };
}

function mapSwitchErrorText(err: unknown, code: string | undefined): string {
  switch (code) {
    case "at_capacity":
      return "This node is full — free a session (disconnect or delete one) and retry the switch.";
    case "switch_failed_rollback_failed":
      return "Switch failed and the session is disconnected — reconnect it.";
    // Issue #4823: a key target the session cannot take (refused before any kill —
    // the session is still running on its old binding).
    case "api_key_launcher_unsupported":
      return "API-key billing requires the SDK launcher — start a new session on an API key.";
    case "api_key_local_mode_unsupported":
      return "Return the session to remote mode to switch it to an API key.";
    case "api_key_remote_unsupported":
      return "API keys are node-local — switch from the node that owns this session.";
    case "api_key_agent_unsupported":
      return "API-key billing is available for Claude Code sessions only.";
    case "api_key_not_found":
      return "That API key is no longer in this node's vault.";
    default: {
      if (err instanceof ApiError && err.body) {
        try {
          const parsed = JSON.parse(err.body) as { error?: unknown };
          if (typeof parsed.error === "string" && parsed.error) {
            return parsed.error;
          }
        } catch {
          // Non-JSON body — fall through to the generic message below.
        }
      }
      return err instanceof Error ? err.message : "Failed to switch account";
    }
  }
}

export function useAccountActions(
  api: ApiClient | null,
  opts?: { sessionId?: string; nodeId?: string }
): {
  selectAccount: (accountUuid: string) => Promise<void>;
  /** Issue #4823: switch the SESSION onto a node-vault Anthropic API key (by
   *  vault id). Session scope only — rejects for a node-scoped instance. */
  selectApiKey: (apiKeyId: string) => Promise<void>;
  removeAccount: (accountUuid: string) => Promise<void>;
  /**
   * Multi-account, multi-node credential removal (issue #2131, generalized from
   * #2054). Fires one DELETE per (account × node) pair in parallel (non-blocking)
   * and reports partial failures via an aggregated toast. Optimistically removes
   * each targeted account's card from the accountUsage cache when the current
   * node is one of its targets (R7).
   */
  removeAccountsFromNodes: (vars: RemoveAccountsFromNodesVars) => void;
  /** True while a bulk removal is in flight — drives the modal's pending state. */
  isRemovingFromNodes: boolean;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const sessionId = opts?.sessionId;
  const nodeId = opts?.nodeId;

  const selectMutation = useMutation({
    // Issue #4823: the target is a payment method — an account (every existing
    // scope) or an Anthropic API key (session scope only: a key binds ONE
    // session, never a node default).
    mutationFn: async (target: SetSessionPaymentMethodRequest) => {
      if (!api) {
        throw new Error("API unavailable");
      }
      if (sessionId) {
        if ("apiKeyId" in target) {
          await api.setSessionPaymentMethod(sessionId, target);
        } else {
          await api.setSessionAccount(sessionId, target.accountUuid);
        }
      } else if (nodeId) {
        if ("apiKeyId" in target) {
          throw new Error("An API key binds a session, not a node default");
        }
        await api.setNodeActiveAccount(nodeId, target.accountUuid);
      } else {
        throw new Error("No session or node target for account selection");
      }
    },
    // Issue #1902: account SWITCH is non-blocking — the modal closes immediately,
    // and a spinner appears near the account badge (per-session scope) while the
    // switch runs in the background. Cleared on settle, or by the 90s TTL.
    onMutate: () => {
      if (sessionId) markActionPending(sessionId, "switch");
    },
    onError: (err: unknown) => {
      if (sessionId) clearActionPending(sessionId, "switch");
      const { message, action } = mapSwitchError(err);
      showToast(message, { type: "error", action });
    },
    onSettled: () => {
      if (sessionId) clearActionPending(sessionId, "switch");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
      if (sessionId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.session(sessionId),
        });
      } else if (nodeId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.nodeActiveAccount(nodeId),
        });
      }
    },
  });

  // R6 (Sub-Issue K #1457): optimistic removal — the account row vanishes
  // immediately on confirm and is restored if the DELETE rejects. Mirrors the
  // TanStack optimistic idiom used by useSessionActions + federation overrides.
  const removeMutation = useMutation({
    mutationFn: async (accountUuid: string) => {
      if (!api) {
        throw new Error("API unavailable");
      }
      await api.deleteAccount(accountUuid);
    },
    onMutate: async (accountUuid: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.accounts });
      const previous = queryClient.getQueryData<AccountsResponse>(
        queryKeys.accounts
      );
      queryClient.setQueryData<AccountsResponse>(queryKeys.accounts, old =>
        old
          ? {
              accounts: old.accounts.filter(a => a.accountUuid !== accountUuid),
            }
          : old
      );
      return { previous };
    },
    onError: (_err, _accountUuid, context) => {
      // Roll the optimistic removal back. The rejection still propagates so the
      // calling dialog surfaces the error (R5 — e.g. 409 last_account).
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.accounts, context.previous);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
    },
  });

  // Issue #2131: multi-account, federation-aware credential removal for the
  // Account Usage page's bulk "Remove Accounts" flow (generalized from #2054's
  // single-account fan-out). ADDITIVE — leaves removeMutation (the modal path
  // targeting queryKeys.accounts) untouched. This one targets
  // queryKeys.accountUsage (the page's cache) and fans out one DELETE per
  // (account × node) pair the user selected.
  const removeAccountsFromNodesMutation = useMutation({
    mutationFn: async (
      vars: RemoveAccountsFromNodesVars
    ): Promise<RemoveFromNodesResult[]> => {
      if (!api) {
        throw new Error("API unavailable");
      }
      // Flatten the (account → nodes) selection into (account, node) pairs and
      // fire them all in parallel — a per-pair failure never blocks the rest.
      const pairs = vars.removals.flatMap(r =>
        r.nodeIds.map(nodeId => ({ accountUuid: r.accountUuid, nodeId }))
      );
      const settled = await Promise.allSettled(
        pairs.map(p => api.removeAccountOnNode(p.nodeId, p.accountUuid))
      );
      return pairs.map((p, i) => {
        const res = settled[i];
        if (res.status === "fulfilled") {
          return { accountUuid: p.accountUuid, nodeId: p.nodeId, ok: true };
        }
        const err = res.reason;
        return {
          accountUuid: p.accountUuid,
          nodeId: p.nodeId,
          ok: false,
          code: err instanceof ApiError ? err.code : undefined,
          message: err instanceof Error ? err.message : "Removal failed",
        };
      });
    },
    onMutate: async (vars: RemoveAccountsFromNodesVars) => {
      // R7 / D3: optimistically drop from the accountUsage cache EVERY account
      // whose removal set includes the currently-viewed node. Per-account restore
      // below if that node's removal turns out to have failed for an account.
      await queryClient.cancelQueries({ queryKey: queryKeys.accountUsage });
      const previous = queryClient.getQueryData<AccountUsageResponse>(
        queryKeys.accountUsage
      );
      const { currentNodeId } = vars;
      const optimisticUuids = new Set(
        currentNodeId != null
          ? vars.removals
              .filter(r => r.nodeIds.includes(currentNodeId))
              .map(r => r.accountUuid)
          : []
      );
      if (optimisticUuids.size > 0) {
        queryClient.setQueryData<AccountUsageResponse>(
          queryKeys.accountUsage,
          old =>
            old
              ? {
                  usage: old.usage.filter(
                    a => !optimisticUuids.has(a.accountUuid)
                  ),
                }
              : old
        );
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      // Whole mutation threw (e.g. API unavailable) — restore + surface.
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.accountUsage, context.previous);
      }
      showToast("Failed to remove accounts", { type: "error" });
    },
    onSuccess: (results, vars, context) => {
      const failed = results.filter(
        (r): r is Extract<RemoveFromNodesResult, { ok: false }> => !r.ok
      );
      if (failed.length === 0) {
        return; // clean full success — cards already gone, no toast
      }
      // R7 / OR2 (highest-value correctness surface): for each account whose
      // CURRENT-node removal failed, undo its optimistic card removal so the user
      // isn't misled into thinking its creds were removed there. Restore
      // per-account (a full snapshot restore would wrongly resurrect the accounts
      // that DID succeed on the current node); onSettled's refetch reconciles.
      const { currentNodeId } = vars;
      const currentFailedUuids = new Set(
        currentNodeId != null
          ? failed
              .filter(f => f.nodeId === currentNodeId)
              .map(f => f.accountUuid)
          : []
      );
      const previous = context?.previous;
      if (currentFailedUuids.size > 0 && previous) {
        queryClient.setQueryData<AccountUsageResponse>(
          queryKeys.accountUsage,
          old => {
            if (!old) return old;
            const present = new Set(old.usage.map(a => a.accountUuid));
            const restore = previous.usage.filter(
              a =>
                currentFailedUuids.has(a.accountUuid) &&
                !present.has(a.accountUuid)
            );
            return restore.length > 0
              ? { usage: [...old.usage, ...restore] }
              : old;
          }
        );
      }
      const label = (id: string) => vars.nodeLabels?.[id] ?? id;
      const failList = failed
        .map(
          f =>
            label(f.nodeId) +
            (f.code === "last_account" ? " (only account)" : "")
        )
        .join(", ");
      const succeeded = results.length - failed.length;
      showToast(
        succeeded > 0
          ? `Removed ${succeeded} of ${results.length} credential(s). Failed: ${failList}`
          : `Removal failed on ${failList}`,
        { type: "error" }
      );
    },
    onSettled: async () => {
      // Reconcile ground truth. This refetch reflects the deletion only because
      // the server clears the usage snapshot on delete (ruling D1); without it,
      // getCachedOrRefresh() would serve the stale TTL snapshot and the card
      // would resurrect until the next 2-min sampler tick. An account that still
      // lives on unselected nodes reappears here (D3, expected).
      await queryClient.invalidateQueries({ queryKey: queryKeys.accountUsage });
    },
  });

  return {
    selectAccount: (accountUuid: string) =>
      selectMutation.mutateAsync({ accountUuid }),
    selectApiKey: (apiKeyId: string) =>
      selectMutation.mutateAsync({ apiKeyId }),
    removeAccount: removeMutation.mutateAsync,
    removeAccountsFromNodes: removeAccountsFromNodesMutation.mutate,
    isRemovingFromNodes: removeAccountsFromNodesMutation.isPending,
    isPending: selectMutation.isPending || removeMutation.isPending,
  };
}

/**
 * Issue #1720 / #2300 / #4462: rethrow a login failure as an `ApiError` whose
 * `.message` is the server's clean `error` text (not the raw `HTTP <status>:
 * <json>` transport string the wizard would otherwise print) while keeping the
 * `status`, `code` and `body`, so callers (the wizard, #4464) can branch on the
 * code — `login_session_lost`, `node_offline`, `login_outcome_unknown`, …. An
 * `ApiError` without a body (the client's own timeout answer) passes unchanged.
 */
function cleanLoginError(err: unknown): unknown {
  if (!(err instanceof ApiError) || !err.body) return err;
  let message = err.message;
  try {
    const parsed = JSON.parse(err.body) as { error?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
  } catch {
    // Non-JSON body — keep the transport-message fallback.
  }
  return new ApiError(message, err.status, err.code, err.body);
}

/**
 * Web-initiated OAuth login mutations (issue #1263), backing `AddAccountWizard`.
 * `start` requests the Anthropic authorize URL; `complete` exchanges the pasted
 * code and, on success, invalidates the account queries so the new account
 * appears. Both reject with an `ApiError` carrying the server's clean message
 * and its `code` (see {@link cleanLoginError}).
 *
 * #4462: `nodeId` stores the login on that federation node; `complete` needs no
 * node, because the token returned by `start` routes it.
 */
export function useAccountLogin(
  api: ApiClient | null,
  opts?: { nodeId?: string }
): {
  start: () => Promise<{ loginToken: string; authorizeUrl: string }>;
  complete: (args: {
    loginToken: string;
    code: string;
  }) => Promise<RedactedAccount>;
  isStarting: boolean;
  isCompleting: boolean;
} {
  const queryClient = useQueryClient();
  const nodeId = opts?.nodeId;

  const startMutation = useMutation({
    mutationFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      try {
        return await api.startAccountLogin(nodeId);
      } catch (err) {
        throw cleanLoginError(err);
      }
    },
  });

  const completeMutation = useMutation({
    mutationFn: async ({
      loginToken,
      code,
    }: {
      loginToken: string;
      code: string;
    }) => {
      if (!api) {
        throw new Error("API unavailable");
      }
      try {
        const { account } = await api.completeAccountLogin(loginToken, code);
        return account;
      } catch (err) {
        throw cleanLoginError(err);
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.accounts }),
        queryClient.invalidateQueries({ queryKey: queryKeys.accountUsage }),
        queryClient.invalidateQueries({ queryKey: queryKeys.accountHealth }),
      ]);
    },
  });

  return {
    start: startMutation.mutateAsync,
    complete: completeMutation.mutateAsync,
    isStarting: startMutation.isPending,
    isCompleting: completeMutation.isPending,
  };
}

/**
 * Issue #4349: the in-VM sign-in a tenant VM uses instead of the web OAuth login. `start` creates
 * an empty per-account config dir and returns the command to run in a terminal on the VM; `check`
 * asks the server whether Claude Code's own `/login` has finished there — it resolves `null` while
 * not yet signed in, and the new account once registered (refreshing the account list). No token
 * passes through any of these calls.
 */
export function useInVmAccountLogin(api: ApiClient | null): {
  start: () => Promise<InVmLoginStartResponse>;
  check: (loginToken: string) => Promise<RedactedAccount | null>;
  cancel: (loginToken: string) => Promise<void>;
} {
  const queryClient = useQueryClient();
  return {
    start: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.startInVmAccountLogin();
    },
    check: async loginToken => {
      if (!api) throw new Error("API unavailable");
      try {
        const res = await api.completeInVmAccountLogin(loginToken);
        if (!res.ok) return null; // not_signed_in (HTTP 202): keep waiting
        await queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
        return res.account;
      } catch (err) {
        // Surface the body's human `error` (e.g. already_added), not the transport string. A rate
        // limit or server error passes through unchanged so the dialog keeps waiting.
        if (err instanceof ApiError && err.status !== 429 && err.status < 500) {
          let message = err.message;
          if (err.body) {
            try {
              const parsed = JSON.parse(err.body) as { error?: unknown };
              if (typeof parsed.error === "string") message = parsed.error;
            } catch {
              // Non-JSON body — keep the transport-message fallback.
            }
          }
          throw new Error(message);
        }
        throw err;
      }
    },
    cancel: async loginToken => {
      if (!api) return;
      await api.cancelInVmAccountLogin(loginToken).catch(() => undefined);
    },
  };
}
