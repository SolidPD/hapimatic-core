// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6779, Task 14: the web's data layer for billing categories.
 *
 * Two rules hold here (plan, Task 14; R11, R12):
 * - No error reaches a report or a toast with a rate. The client declares every
 *   answer below 500 expected, so none is reported, and a failure is described
 *   from its status, `code`, `reason`, `field` and the owners' labels only,
 *   never from `err.message`, which carries the whole body.
 * - No write rejects: each resolves to an outcome, so no rejection can reach
 *   the window's unhandled-rejection reporter (`main.tsx`).
 *
 * The pattern is #6646's `useBillableSwitch.ts`: a bare 404 is the gate turned
 * off, and it (or a closed refusal) refetches the version read.
 */
import { useCallback } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  BILLING_CATEGORIES_UNAVAILABLE_REASONS,
  BILLING_CATEGORY_LIMIT,
  BILLING_CATEGORY_NAME_MESSAGES,
  BillingCategoryErrorBodySchema,
  type BillingCategoriesUnavailableReason,
  type BillingCategoryList,
  type BillingCategoryNameRefusal,
  type BillingCategoryOwnerRef,
  type BillingRate,
} from "@hapi/protocol";
import { ApiError, type ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/components/Toast";
import { useVersion } from "@/hooks/useVersion";

/** The history rows the page shows (the last 20, plan section 6). */
export const BILLING_HISTORY_PAGE = 20;

// ─── what a failure means ──────────────────────────────────────────────────

export type BillingCategoryFailure =
  | { kind: "gate-off" }
  | { kind: "closed" }
  | { kind: "agent" }
  | { kind: "on-hub"; ownerLabel: string | null }
  | {
      kind: "unavailable";
      reason: BillingCategoriesUnavailableReason;
      ownerLabel: string | null;
      owners: BillingCategoryOwnerRef[];
    }
  | { kind: "stale" }
  | { kind: "not-found" }
  | { kind: "name-taken" }
  | { kind: "field"; field: string; reason: string }
  | { kind: "refused"; code: string }
  | { kind: "other" };

const REASONS = new Set<string>(BILLING_CATEGORIES_UNAVAILABLE_REASONS);

/** The 503 codes, each with the reason it stands for when the body has none. */
const UNAVAILABLE_CODES: Readonly<
  Record<string, BillingCategoriesUnavailableReason>
> = {
  categories_unavailable: "no-owner",
  categories_owner_unreachable: "owner-unreachable",
  categories_owner_not_reachable_yet: "owner-not-polled",
  categories_storage_not_ready: "storage-not-ready",
};

function parseErrorBody(body: string | undefined) {
  if (!body) return null;
  try {
    const parsed = BillingCategoryErrorBodySchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * What a failed billing category request means. Reads the status and the
 * error body's fields (parsed with the shared, stripping schema); never the
 * error's message text.
 */
export function describeBillingCategoryFailure(
  err: unknown
): BillingCategoryFailure {
  if (!(err instanceof ApiError)) return { kind: "other" };
  const body = parseErrorBody(err.body);
  if (err.status === 404 && body === null) return { kind: "gate-off" };
  if (!body) return { kind: "other" };
  const ownerLabel = body.ownerLabel ?? null;
  switch (body.code) {
    case "agent_billing_categories_refused":
      return { kind: "agent" };
    case "billable_feature_closed":
      return { kind: "closed" };
    case "categories_on_hub":
      return { kind: "on-hub", ownerLabel };
    case "stale_token":
      return { kind: "stale" };
    case "category_not_found":
      return { kind: "not-found" };
    case "name_taken":
      return { kind: "name-taken" };
    case "invalid_field":
      return {
        kind: "field",
        field: body.field ?? "body",
        reason: body.reason ?? "invalid",
      };
  }
  const fallback = UNAVAILABLE_CODES[body.code];
  if (fallback) {
    const reason =
      body.reason && REASONS.has(body.reason)
        ? (body.reason as BillingCategoriesUnavailableReason)
        : fallback;
    return {
      kind: "unavailable",
      reason,
      ownerLabel,
      owners: body.owners ?? [],
    };
  }
  return { kind: "refused", code: body.code };
}

/**
 * The one sentence for each reason no list can be read (plan section 6), used
 * by the page and offered to #6780.
 */
export function billingCategoriesReasonSentence(
  reason: BillingCategoriesUnavailableReason,
  ownerLabel: string | null,
  owners: readonly BillingCategoryOwnerRef[] = []
): string {
  switch (reason) {
    case "no-owner":
      return "No node keeps the billing category list right now, so none can be offered.";
    case "two-owners": {
      const labels = owners.map(o => o.nodeLabel);
      const named =
        labels.length >= 2
          ? ` (${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]})`
          : "";
      return `More than one node keeps a billing category list${named}, so none is offered until that is fixed.`;
    }
    case "owner-not-polled":
      return "This node has not reached the node that keeps the list yet. Try again in a minute.";
    case "owner-offline":
    case "owner-unreachable":
      return `The node that keeps the list${ownerLabel ? ` (${ownerLabel})` : ""} cannot be reached right now.`;
    case "owner-unsupported":
      return `The node that keeps the list${ownerLabel ? ` (${ownerLabel})` : ""} runs an older version without billing categories.`;
    case "storage-not-ready":
      return "The billing category list could not be opened on this node. Check its server log.";
  }
}

/** The closed gate's line: under the page's header, and a write's toast. */
export const BILLING_CLOSED_LINE =
  "Billable sessions are closed on this node; the list can be read, not changed.";

/** A stale token's line: in the edit dialog, and a write's toast. */
export const BILLING_STALE_LINE =
  "The list changed while you were editing. Check the values and save again.";

const REFUSED_MESSAGES: Readonly<Record<string, string>> = {
  category_limit: `The list already holds ${BILLING_CATEGORY_LIMIT} categories.`,
  category_retired: "That category is retired.",
  default_category_retire: "The default category cannot be retired.",
  order_mismatch: "The list changed. Try the move again.",
};

/** A field refusal in words: the shared name messages, else a generic line. */
export function billingCategoryFieldMessage(
  field: string,
  reason: string
): string {
  if (field === "name" && reason in BILLING_CATEGORY_NAME_MESSAGES) {
    return BILLING_CATEGORY_NAME_MESSAGES[reason as BillingCategoryNameRefusal];
  }
  if (reason === "unknown-currency") {
    return "This version does not know that currency.";
  }
  return "A value was refused. Check it and try again.";
}

/** The line a person reads for a failure. Names no rate, ever. */
export function billingCategoryFailureMessage(
  failure: BillingCategoryFailure
): string {
  switch (failure.kind) {
    case "gate-off":
      return "Billable sessions were turned off on this server.";
    case "closed":
      return BILLING_CLOSED_LINE;
    case "agent":
      return "The request was refused.";
    case "on-hub":
      return `Kept on ${failure.ownerLabel ?? "another node"}. Change it there.`;
    case "unavailable":
      return billingCategoriesReasonSentence(
        failure.reason,
        failure.ownerLabel,
        failure.owners
      );
    case "stale":
      return BILLING_STALE_LINE;
    case "not-found":
      return "That category no longer exists.";
    case "name-taken":
      return "A category with this name already exists.";
    case "field":
      return billingCategoryFieldMessage(failure.field, failure.reason);
    case "refused":
      return (
        REFUSED_MESSAGES[failure.code] ??
        "The billing categories could not be changed."
      );
    case "other":
      return "The billing categories could not be changed. Try again.";
  }
}

/**
 * Refetch what a failure may have changed: the version read for the gate, and
 * the list for a stale token, a missing category or a list kept elsewhere.
 * Resolves when the list has been read again.
 */
async function refreshAfterFailure(
  queryClient: QueryClient,
  failure: BillingCategoryFailure
): Promise<void> {
  if (failure.kind === "gate-off" || failure.kind === "closed") {
    void queryClient.invalidateQueries({ queryKey: queryKeys.version });
  }
  if (
    failure.kind === "stale" ||
    failure.kind === "not-found" ||
    failure.kind === "on-hub" ||
    failure.kind === "refused" ||
    failure.kind === "closed"
  ) {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.billingCategories,
    });
  }
}

// ─── the reads ─────────────────────────────────────────────────────────────

/** The server's billable gate; `off` until the version read answers. */
function useGateMode(): "on" | "closed" | "off" {
  const { data } = useVersion();
  return data?.billableSwitch ?? "off";
}

/** The list, retired categories included; read while the gate is on or closed. */
export function useBillingCategoryList(api: ApiClient | null) {
  const mode = useGateMode();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.billingCategories,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      try {
        return await api.getBillingCategories({ retired: true });
      } catch (err) {
        const failure = describeBillingCategoryFailure(err);
        if (failure.kind === "gate-off") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.version });
        }
        throw err;
      }
    },
    enabled: Boolean(api) && mode !== "off",
    staleTime: 15_000,
    retry: false,
  });
}

/** The last rows of the history; read only while its section is open. */
export function useBillingCategoryHistory(
  api: ApiClient | null,
  open: boolean
) {
  return useQuery({
    queryKey: queryKeys.billingCategoryHistory,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getBillingCategoryHistory({
        limit: BILLING_HISTORY_PAGE,
      });
    },
    enabled: Boolean(api) && open,
    staleTime: 0,
    retry: false,
  });
}

// ─── the writes ────────────────────────────────────────────────────────────

export type BillingCategoryWriteRequest =
  | { op: "add"; name: string; defaultRate: BillingRate | null }
  | {
      op: "update";
      id: string;
      name?: string;
      defaultRate?: BillingRate | null;
      retired?: boolean;
    }
  | { op: "order"; ids: string[] }
  | { op: "settings"; defaultCategoryId?: string; currency?: string };

export type BillingCategoryWriteOutcome =
  | { ok: true }
  | { ok: false; failure: BillingCategoryFailure };

/**
 * Failures a caller shows in place instead of a toast (the edit dialog shows a
 * stale token, a refused field and a taken name beside its fields).
 */
export type InlineFailureKinds = ReadonlyArray<BillingCategoryFailure["kind"]>;

function send(
  api: ApiClient,
  token: number,
  request: BillingCategoryWriteRequest
): Promise<BillingCategoryList> {
  switch (request.op) {
    case "add":
      return api.addBillingCategory({
        token,
        name: request.name,
        defaultRate: request.defaultRate,
      });
    case "update": {
      const { op: _op, id, ...rest } = request;
      return api.updateBillingCategory(id, { token, ...rest });
    }
    case "order":
      return api.reorderBillingCategories({ token, ids: request.ids });
    case "settings": {
      const { op: _op, ...rest } = request;
      return api.setBillingCategorySettings({ token, ...rest });
    }
  }
}

/**
 * The page's one write: sends the list's token, and on success reads the list
 * (and the history) again before it resolves. A failure is toasted in words
 * unless the caller shows its kind in place; it never rejects.
 */
export function useBillingCategoryWrite(api: ApiClient | null) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const mutation = useMutation<
    BillingCategoryList,
    unknown,
    BillingCategoryWriteRequest
  >({
    mutationFn: async request => {
      const token = queryClient.getQueryData<BillingCategoryList>(
        queryKeys.billingCategories
      )?.token;
      if (!api || token === undefined) throw new Error("No list to change.");
      return await send(api, token, request);
    },
  });
  const { mutateAsync } = mutation;

  const write = useCallback(
    async (
      request: BillingCategoryWriteRequest,
      inline: InlineFailureKinds = []
    ): Promise<BillingCategoryWriteOutcome> => {
      try {
        await mutateAsync(request);
      } catch (err) {
        const failure = describeBillingCategoryFailure(err);
        await refreshAfterFailure(queryClient, failure);
        if (!inline.includes(failure.kind)) {
          showToast(billingCategoryFailureMessage(failure), { type: "error" });
        }
        return { ok: false, failure };
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.billingCategories,
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.billingCategoryHistory,
        }),
      ]);
      return { ok: true };
    },
    [mutateAsync, queryClient, showToast]
  );

  return { write, pending: mutation.isPending };
}
