// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The re-login message, action and deep link for an `account_unrefreshable`
 * refusal (issue #4461, epic #4460 A — R8, R9).
 *
 * ONE builder for both toasts of one refusal. A reconnect refusal reaches the
 * browser twice — the HTTP 409 and the `account-unrefreshable` SSE event — and
 * ToastProvider deduplicates by exact text only (`Toast.tsx`, `DEDUP_WINDOW_MS`).
 * If the two sides built their text differently the user would get two toasts; if
 * only one side attached the action, the action would vanish whenever the other
 * side fired first. So both sides call {@link buildReloginToast} with the
 * server-stamped `nodeId` / `nodeLabel` alone, and get identical text AND the same
 * action. Only the switch path (which has no SSE twin) may add an account name.
 *
 * The action dispatches the `hapi:relogin` window event (the `hapi:spawnFailed`
 * precedent); `ReloginLinkListener` (App.tsx) turns it into a navigation to
 * `/settings/account-usage?relogin=anthropic&node=<id>`, which opens the add flow
 * when this UI can store a login on that node and otherwise explains why not
 * (D-A1 = A: never a login on the wrong node's store).
 */
import { AccountUnrefreshableErrorSchema } from "@hapi/protocol";
import { ApiError } from "@/api/client";

/** The window event a re-login request travels on. */
export const RELOGIN_EVENT = "hapi:relogin";

/** The only provider a re-login is requested for today. */
export type ReloginProvider = "anthropic";

export type ReloginRequest = {
  provider: ReloginProvider;
  nodeId: string;
  accountUuid?: string;
};

/** The two deep-link search keys on `/settings/account-usage`. */
export type ReloginSearch = {
  relogin?: ReloginProvider;
  node?: string;
};

/** Upper bound on a node id read from a URL (ids are short config slugs). */
const MAX_NODE_ID_LENGTH = 128;

/** "Re-login required on <node>" / "Re-login required for <account> on <node>". */
export function formatReloginMessage({
  nodeLabel,
  accountLabel,
}: {
  nodeLabel: string;
  accountLabel?: string;
}): string {
  return accountLabel
    ? `Re-login required for ${accountLabel} on ${nodeLabel}`
    : `Re-login required on ${nodeLabel}`;
}

/** Ask the app to open the re-login flow for `nodeId`. */
export function requestRelogin(request: ReloginRequest): void {
  window.dispatchEvent(
    new CustomEvent<ReloginRequest>(RELOGIN_EVENT, { detail: request })
  );
}

/** The toast message plus its "Log in" action for one refusal. */
export function buildReloginToast({
  nodeId,
  nodeLabel,
  accountUuid,
  accountLabel,
}: {
  nodeId: string;
  nodeLabel: string;
  accountUuid?: string;
  accountLabel?: string;
}): { message: string; action: { label: string; onClick: () => void } } {
  return {
    message: formatReloginMessage({ nodeLabel, accountLabel }),
    action: {
      label: "Log in",
      onClick: () =>
        requestRelogin({
          provider: "anthropic",
          nodeId,
          ...(accountUuid ? { accountUuid } : {}),
        }),
    },
  };
}

/**
 * Validate the deep-link keys from a raw search object. An unknown provider or a
 * missing / empty / oversized node yields `{}` for that key, so a hand-edited URL
 * never opens a flow for a node it did not name.
 */
export function parseReloginSearch(
  search: Record<string, unknown>
): ReloginSearch {
  const out: ReloginSearch = {};
  if (search.relogin === "anthropic") out.relogin = "anthropic";
  const node = search.node;
  if (
    typeof node === "string" &&
    node.trim().length > 0 &&
    node.length <= MAX_NODE_ID_LENGTH
  ) {
    out.node = node;
  }
  return out;
}

/** The search object for a re-login request (the inverse of the parser). */
export function buildReloginSearch(
  request: Pick<ReloginRequest, "provider" | "nodeId">
): Required<ReloginSearch> {
  return { relogin: request.provider, node: request.nodeId };
}

/**
 * The re-login toast for an `account_unrefreshable` ApiError whose body names
 * its node, or `null` — for any other error, or a body without a node (a
 * pre-#4461 node, whose callers keep their own wording). The ONE parse used by
 * the switch path (`mapSwitchError`) and the reconnect path
 * (`getReconnectErrorToastOptions`), so both read the server stamp the same way.
 */
export function reloginToastFromError(
  err: unknown
): { message: string; action: { label: string; onClick: () => void } } | null {
  if (!(err instanceof ApiError) || err.code !== "account_unrefreshable") {
    return null;
  }
  let parsed: unknown = null;
  try {
    parsed = err.body ? (JSON.parse(err.body) as unknown) : null;
  } catch {
    return null;
  }
  const body = AccountUnrefreshableErrorSchema.safeParse(parsed);
  if (!body.success) return null;
  return buildReloginToast({
    nodeId: body.data.nodeId,
    nodeLabel: body.data.nodeLabel,
    accountUuid: body.data.accountUuid,
  });
}
