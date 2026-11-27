// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Time Tracking's fields (#6780): the state (`useState`, so nothing of it is
 * ever saved as a default), the category read, the one prefill and the derived
 * settings. Shared by the Create page's adapter and later forms (#6805, #6784).
 *
 * `active` (the caller's "allowed": the gate on and nothing locks the group),
 * AND-ed with the state's own `on`, alone enables the read and the prefill
 * effect. "Settled" is exactly
 * `status === "success" && fetchStatus === "idle"` of the same render: a cache
 * older than the read's 15 s is still refetching, and a refetch that fails over
 * a cache reads `error` with the old data kept, so neither prefills (item 5).
 * The hook calls no `useQueryClient` itself.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "@/api/client";
import type {
  BillingCategoryList,
  BillingCategoryListItem,
  TrackingBillingStatus,
} from "@hapi/protocol";
import {
  billingCategoriesReasonSentence,
  describeBillingCategoryFailure,
  useBillingCategoryList,
} from "@/hooks/queries/useBillingCategories";
import {
  deriveTimeTracking,
  INITIAL_TIME_TRACKING,
  keepRate,
  offeredCategories,
  pickCategory,
  prefillOnce,
  selectedCategory,
  typeRate,
  type ProjectShown,
  type TimeTrackingDerived,
  type TimeTrackingState,
  type TrackingField,
  type TrackingListContext,
} from "./timeTracking";

export const CATEGORIES_UNREADABLE =
  "The billing categories could not be read.";

/** The sentence for a list read that failed: the reason's, else a plain one. */
export function listFailureSentence(err: unknown): string {
  const f = describeBillingCategoryFailure(err);
  return f.kind === "unavailable"
    ? billingCategoriesReasonSentence(f.reason, f.ownerLabel, f.owners)
    : CATEGORIES_UNREADABLE;
}

export type TimeTrackingSetters = {
  setOn: (on: boolean) => void;
  setStatus: (status: TrackingBillingStatus) => void;
  pickCategory: (item: BillingCategoryListItem) => void;
  typeRate: (text: string) => void;
  setNote: (text: string) => void;
  /** "Use it": the chosen category's current default, as picking it again. */
  restoreDefault: () => void;
  /** "Keep it": the rate of a removed default, kept in its own currency. */
  keepRate: () => void;
};

export function useTimeTrackingFields(input: {
  api: ApiClient | null;
  active: boolean;
  initial?: TimeTrackingState;
}) {
  const [state, setState] = useState<TimeTrackingState>(
    input.initial ?? INITIAL_TIME_TRACKING
  );
  const { api } = input;
  const active = input.active && state.on;
  const query = useBillingCategoryList(api, { enabled: active });
  const data = query.data;
  const settled = query.status === "success" && query.fetchStatus === "idle";
  const prefilled = state.prefilled;

  useEffect(() => {
    if (!active || prefilled || !settled || !data) return;
    setState(s => prefillOnce(s, data));
  }, [active, prefilled, settled, data]);

  const errorSentence =
    query.status === "error" ? listFailureSentence(query.error) : null;
  const ctx: TrackingListContext = useMemo(() => {
    if (data)
      return { kind: "ready", list: data, refetchFailed: errorSentence };
    if (errorSentence !== null)
      return { kind: "failed", sentence: errorSentence };
    return { kind: "loading" };
  }, [data, errorSentence]);
  const derived = useMemo(() => deriveTimeTracking(state, ctx), [state, ctx]);
  const offered = useMemo(() => (data ? offeredCategories(data) : []), [data]);

  const refetch = query.refetch;
  const refetchList = useCallback(async (): Promise<
    BillingCategoryList | undefined
  > => {
    if (!active) return undefined;
    // Only a read that succeeded answers: a failed refetch keeps the old data
    // in the query, which is not the list as it stands now (F2).
    const result = await refetch();
    return result.isError ? undefined : result.data;
  }, [active, refetch]);

  const setters: TimeTrackingSetters = useMemo(
    () => ({
      setOn: on => setState(s => (s.on === on ? s : { ...s, on })),
      setStatus: status =>
        setState(s => (s.status === status ? s : { ...s, status })),
      pickCategory: item => setState(s => pickCategory(s, item)),
      typeRate: text => setState(s => typeRate(s, text)),
      setNote: note => setState(s => (s.note === note ? s : { ...s, note })),
      restoreDefault: () =>
        setState(s => {
          const item = data ? selectedCategory(s, data) : null;
          return item ? pickCategory(s, item) : s;
        }),
      keepRate: () => setState(s => keepRate(s)),
    }),
    [data]
  );

  return {
    state,
    setters,
    derived,
    offered,
    /** "Loading categories…" shows only while a read runs before the prefill. */
    loading: query.fetchStatus === "fetching" && !prefilled,
    listFailed: ctx.kind === "failed" ? ctx.sentence : null,
    /** A refetch over a loaded list failed: Category offers Retry. */
    refetchFailed: ctx.kind === "ready" && ctx.refetchFailed !== null,
    refetchList,
  };
}

/** What the group component renders: the adapter's view of the fields. */
export type TimeTrackingGroupModel = {
  state: TimeTrackingState;
  derived: TimeTrackingDerived;
  offered: BillingCategoryListItem[];
  loading: boolean;
  /** The list was never read: its sentence replaces the fields row. */
  listFailed: string | null;
  project: ProjectShown;
  /** The toggle shows off and disabled with this reason (closed, Scheduled, target). */
  lockedReason: string | null;
  /** A refusal or a known-unable target, under the toggle row. */
  toggleError: string | null;
  /** A target not known yet: a hint, never a block. */
  toggleHint: string | null;
  errors: Partial<Record<TrackingField, string>>;
  /** A refetch over a loaded list failed: Retry shows beside the Category line. */
  categoryRetry: boolean;
  disabled: boolean;
  setters: TimeTrackingSetters;
  retry: () => void;
};
