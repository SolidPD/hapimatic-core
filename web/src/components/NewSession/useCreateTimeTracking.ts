// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Create page's Time Tracking adapter (#6780): gate, lock reasons, target,
 * refusals, summary, preview status and the retry snapshot. Mounted once in
 * `index.tsx`; everything derives from one value,
 * `active = mode === "on" && state.on && lockedReason === null`, so an inactive
 * group sends, blocks and shows nothing.
 *
 * Only primitives (`active`, `blocked`, `previewStatus`, `summary`) are meant for
 * `index.tsx`'s dependency lists. Nothing here logs or writes storage; a rate
 * never leaves the returned settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type ApiClient } from "@/api/client";
import {
  BILLABLE_SWITCH_CAPABILITY,
  BILLABLE_SWITCH_CLOSED_CAPABILITY,
  BILLABLE_TRACKING_CARRY_CAPABILITY,
  type BillableSwitchStartBody,
  type TrackingBillingStatus,
  type TrackingSettingsInput,
} from "@hapi/protocol";
import {
  billingCategoriesReasonSentence,
  describeBillingCategoryFailure,
} from "@/hooks/queries/useBillingCategories";
import { useVersion } from "@/hooks/useVersion";
import {
  categoryKey,
  fieldRefusalWords,
  NOTE_DEFAULT_MOVED_WORDS,
  NOTE_HUB_ASKS_WORDS,
  NOTE_REFETCH_FAILED_WORDS,
  trackingSummary,
  type ProjectShown,
  type TimeTrackingState,
  type TrackingField,
} from "@/components/timeTracking/timeTracking";
import {
  useTimeTrackingFields,
  type TimeTrackingGroupModel,
} from "@/components/timeTracking/useTimeTrackingFields";

export type BillableGateMode = "on" | "closed" | "off";

/** The selected target as the group needs it (null: none chosen yet). */
export type TrackingTarget =
  | { kind: "local" }
  | {
      kind: "remote";
      label: string;
      status: string;
      capabilities: readonly string[] | undefined;
    }
  | null;

/** What a submit sent: its sequence number, the settings, and the default shown. */
export type TrackingSent = {
  seq: number;
  settings: TrackingSettingsInput;
  shown: {
    categoryKey: string | null;
    defaultRateMinor: number | null;
    defaultCurrency: string | null;
  };
};

export type TrackingRefusalResult =
  | { kind: "shown"; words: string }
  | { kind: "dropped" }
  | null;

export const SCHEDULED_WORDS = "Scheduled sessions are not tracked";
export const CLOSED_HERE_WORDS = "Billable sessions are closed on this server.";
export const GATE_GONE_WORDS =
  "Time Tracking is no longer available on this node; this session will start untracked.";

/** A remote target: unable (known), unknown (a hint), or able. */
export function targetAbility(target: TrackingTarget): {
  cannot: string | null;
  hint: string | null;
} {
  if (target === null || target.kind === "local") {
    return { cannot: null, hint: null };
  }
  const caps = target.capabilities;
  if (!Array.isArray(caps) || target.status === "offline") {
    return {
      cannot: null,
      hint: `${target.label} has not answered yet. Try again in a moment.`,
    };
  }
  if (caps.includes(BILLABLE_SWITCH_CLOSED_CAPABILITY)) {
    return {
      cannot: `Billable sessions are closed on ${target.label}, so a tracked session cannot start there.`,
      hint: null,
    };
  }
  if (
    caps.includes(BILLABLE_SWITCH_CAPABILITY) &&
    caps.includes(BILLABLE_TRACKING_CARRY_CAPABILITY)
  ) {
    return { cannot: null, hint: null };
  }
  return {
    cannot: `${target.label} cannot start a tracked session: billable sessions are not on there, or it runs an older version.`,
    hint: null,
  };
}

type RefusalRow = {
  at: TrackingField | "toggle" | "banner";
  words: string;
  refetch?: "list" | "version";
  /** The note row whose words a refetched default refines (item L5). */
  noteRequired?: boolean;
};

function readBody(err: ApiError): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(err.body ?? "");
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Answer 4's table: a tracked start's refusal mapped to the web's own words
 * and where they show. Reads the status and the body's fields (its own parse,
 * because the shared error schema strips `nodeLabel`), never the message.
 */
export function trackingRefusal(
  err: unknown,
  targetLabel: string
): RefusalRow | null {
  if (!(err instanceof ApiError)) return null;
  const body = readBody(err);
  const str = (k: string) =>
    typeof body[k] === "string" ? (body[k] as string) : undefined;
  const code = str("code");
  const node = str("nodeLabel");
  switch (code) {
    case "billable_feature_unsupported":
      return {
        at: "banner",
        words: `Billable sessions are off on ${node ?? "this node"}, the node this app runs on. Create again to start the session untracked.`,
        refetch: "version",
      };
    case "billable_feature_closed":
      return {
        at: "toggle",
        words: `Billable sessions are closed on ${node ?? "this node"}, the node this app runs on, so a session cannot start tracked from it.`,
        refetch: "version",
      };
    case "tracking_unsupported":
      return {
        at: "toggle",
        words: `${node ?? targetLabel} cannot start a tracked session: billable sessions are not on there, or it runs an older version.`,
      };
    case "node_not_reachable_yet":
      return {
        at: "toggle",
        words: `${node ?? targetLabel} has not answered yet. Try again in a moment.`,
      };
    case "namespace_mismatch":
      return {
        at: "toggle",
        words: `${targetLabel} has no machine online for you, so a tracked session cannot start there. Choose another node, or try again when it is back.`,
      };
    case "invalid_field":
    case "invalid_tracking": {
      const field = str("field");
      if (code === "invalid_field" && field !== undefined) {
        const row = fieldRefusalWords(field, str("reason") ?? "");
        if (!row) return null;
        const noteRequired =
          field === "rateNote" && str("reason") === "note_required";
        return {
          ...row,
          refetch: row.at === "category" || noteRequired ? "list" : undefined,
          noteRequired,
        };
      }
      return {
        at: "toggle",
        words: `${targetLabel} refused the tracking settings; it may run an older version. Start the session on another node, or untracked.`,
      };
    }
  }
  const failure = describeBillingCategoryFailure(err);
  if (failure.kind === "unavailable") {
    return {
      at: "category",
      words: billingCategoriesReasonSentence(
        failure.reason,
        failure.ownerLabel,
        failure.owners
      ),
      refetch: "list",
    };
  }
  if (code === "categories_unavailable") {
    return {
      at: "category",
      words: "The billing categories cannot be read right now.",
      refetch: "list",
    };
  }
  return null;
}

type StoredRefusal = {
  at: TrackingField | "toggle";
  words: string;
  seq: number;
  /** A note refusal whose list could not be read again (F2): a good Retry clears it. */
  noteRefetch?: true;
};

export function useCreateTimeTracking(input: {
  api: ApiClient | null;
  mode: BillableGateMode;
  scheduled: boolean;
  target: TrackingTarget;
  /** A stable key of the target: a change clears a target's refusal. */
  targetKey: string;
  disabled: boolean;
  project: ProjectShown;
  initial?: TimeTrackingState;
  /** One banner line (the gate went away while the toggle was on). */
  onNotice?: (line: string) => void;
}) {
  const { mode, scheduled, target, targetKey, project, onNotice } = input;
  const ability = targetAbility(target);
  const targetLabel =
    target && target.kind === "remote" ? target.label : "This node";

  // The fields read only while this is true AND their own toggle is on; the
  // third lock reason (a known-unable target) applies only while off, when
  // nothing is read anyway.
  const fields = useTimeTrackingFields({
    api: input.api,
    active: mode === "on" && !scheduled,
    initial: input.initial,
  });
  const { state, derived, setters } = fields;
  const lockedReason =
    mode === "closed"
      ? CLOSED_HERE_WORDS
      : scheduled
        ? SCHEDULED_WORDS
        : !state.on && ability.cannot
          ? ability.cannot
          : null;
  const active = mode === "on" && state.on && lockedReason === null;

  // B9 (item 12): the gate, once read as `on`, read as anything else during
  // the mount while the toggle is on, sets it off and says so once.
  const seenOn = useRef(false);
  useEffect(() => {
    if (mode === "on") {
      seenOn.current = true;
      return;
    }
    if (seenOn.current && state.on) {
      setters.setOn(false);
      onNotice?.(GATE_GONE_WORDS);
    }
  }, [mode, state.on, setters, onNotice]);

  const [refusal, setRefusal] = useState<StoredRefusal | null>(null);
  useEffect(() => {
    setRefusal(r => (r && r.at === "toggle" ? null : r));
  }, [targetKey]);
  const clearAt = useCallback((at: StoredRefusal["at"]) => {
    setRefusal(r => (r && r.at === at ? null : r));
  }, []);

  const targetCannot = ability.cannot !== null;
  const settings = active ? derived.settings : null;
  const start: BillableSwitchStartBody | undefined = useMemo(
    () =>
      active && !targetCannot && settings ? { tracking: settings } : undefined,
    [active, targetCannot, settings]
  );
  const blocked =
    active && (derived.settings === null || targetCannot || project.pending);
  const summary = active ? trackingSummary(state, derived, blocked) : null;
  const previewStatus: TrackingBillingStatus | undefined = active
    ? state.status
    : undefined;
  const snapshot = start ? state : undefined;

  const seq = useRef(0);
  const shown = useMemo(
    () => ({
      categoryKey: state.categoryKey,
      defaultRateMinor: derived.defaultRate?.minor ?? null,
      defaultCurrency: derived.defaultRate?.currency ?? null,
    }),
    [state.categoryKey, derived.defaultRate]
  );
  /** Called once per submit: the next sequence number, and what is sent. */
  const capture = useCallback((): TrackingSent | undefined => {
    seq.current += 1;
    setRefusal(null);
    return start
      ? { seq: seq.current, settings: start.tracking, shown }
      : undefined;
  }, [start, shown]);

  const version = useVersion();
  const refetchVersion = (version as { refetch?: () => unknown }).refetch;
  const { refetchList } = fields;
  /**
   * Synchronous (item 8): the words now, the refetch the table names in the
   * background (it only refines the note line). Null for an untracked start
   * or an answer the table has no row for; `dropped` for an older submit's.
   */
  const refuse = useCallback(
    (err: unknown, sent: TrackingSent | undefined): TrackingRefusalResult => {
      if (!sent) return null;
      const row = trackingRefusal(err, targetLabel);
      if (!row) return null;
      if (sent.seq !== seq.current) return { kind: "dropped" };
      if (row.at !== "banner") {
        setRefusal({ at: row.at, words: row.words, seq: sent.seq });
      }
      if (row.refetch === "version") void refetchVersion?.();
      if (row.refetch === "list") {
        void refetchList().then(list => {
          if (!row.noteRequired) return;
          if (!list) {
            // F2 (ruled 2026-11-26, option 3): the list cannot be read again,
            // so the form cannot show the hub's default and no field takes a
            // note. Category says what happened, with Retry, and the banner
            // stops at the same words; a good Retry clears them.
            if (sent.seq !== seq.current) return;
            setRefusal(r =>
              r && r.seq === sent.seq && r.at === "note"
                ? {
                    at: "category",
                    words: NOTE_REFETCH_FAILED_WORDS,
                    seq: r.seq,
                    noteRefetch: true,
                  }
                : r
            );
            onNotice?.(NOTE_REFETCH_FAILED_WORDS);
            return;
          }
          if (sent.shown.categoryKey === null) return;
          const now = list.local.categories.find(
            c => categoryKey(c) === sent.shown.categoryKey
          );
          const moved =
            (now?.defaultRate?.minor ?? null) !== sent.shown.defaultRateMinor ||
            (now?.defaultRate?.currency ?? null) !== sent.shown.defaultCurrency;
          if (!moved) return;
          setRefusal(r =>
            r && r.seq === sent.seq && r.at === "note"
              ? { ...r, words: NOTE_DEFAULT_MOVED_WORDS }
              : r
          );
        });
      }
      // A note refusal arrives only while the note field is hidden, so the
      // banner reports it and never asks for a note (F2).
      return {
        kind: "shown",
        words: row.noteRequired ? NOTE_HUB_ASKS_WORDS : row.words,
      };
    },
    [targetLabel, refetchVersion, refetchList, onNotice]
  );

  /** Retry at Category: a read that succeeds clears a note refusal's line (F2). */
  const retryList = useCallback(() => {
    void refetchList().then(list => {
      if (list) setRefusal(r => (r?.noteRefetch ? null : r));
    });
  }, [refetchList]);

  const groupSetters = useMemo(
    () => ({
      setOn: (on: boolean) => {
        clearAt("toggle");
        setters.setOn(on);
      },
      setStatus: (s: TrackingBillingStatus) => {
        clearAt("toggle");
        setters.setStatus(s);
      },
      pickCategory: (item: Parameters<typeof setters.pickCategory>[0]) => {
        clearAt("category");
        clearAt("note");
        setters.pickCategory(item);
      },
      typeRate: (text: string) => {
        clearAt("rate");
        clearAt("note");
        setters.typeRate(text);
      },
      setNote: (text: string) => {
        clearAt("note");
        setters.setNote(text);
      },
      restoreDefault: () => {
        clearAt("rate");
        clearAt("note");
        setters.restoreDefault();
      },
      keepRate: () => {
        clearAt("rate");
        clearAt("note");
        setters.keepRate();
      },
    }),
    [setters, clearAt]
  );

  const group: TimeTrackingGroupModel | null =
    mode === "off"
      ? null
      : {
          state,
          derived,
          offered: fields.offered,
          loading: fields.loading,
          listFailed: fields.listFailed,
          project,
          lockedReason,
          toggleError:
            refusal?.at === "toggle"
              ? refusal.words
              : active
                ? ability.cannot
                : null,
          toggleHint: active ? ability.hint : null,
          errors:
            refusal && refusal.at !== "toggle"
              ? { ...derived.errors, [refusal.at]: refusal.words }
              : derived.errors,
          categoryRetry: fields.refetchFailed,
          disabled: input.disabled,
          setters: groupSetters,
          retry: retryList,
        };

  return {
    group,
    active,
    /** The person's settings while active (#6805 stores them with a schedule). */
    settings,
    start,
    summary,
    previewStatus,
    blocked,
    snapshot,
    capture,
    refuse,
  };
}
