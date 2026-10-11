// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import type { Machine, RedactedAccount } from "@/types/api";
import type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";
import { EFFORT_LEVELS, type EffortLevel } from "@hapi/protocol";
import type { PermissionMode } from "@hapi/protocol/modes";
import type { AgentType, SessionMode, SessionType } from "./types";
import type { CreateDefaultsApi } from "./bookmarkContext";
import { parseSpawnTarget, type RemoteNode } from "./MachineSelector";
import { defaultScheduleState, type ScheduleState } from "./ScheduleSection";
import type { GitBranchListing } from "@hapi/protocol/gitBranches";
import { resolveRestoredBranch, type BranchChoice } from "./branchSelection";

/**
 * The Create-Session saved-defaults ENGINE (bookmark feature).
 *
 * One hook, mounted by `index.tsx` (where ALL Create-page state lives),
 * responsible for the full lifecycle of per-field saved defaults:
 *
 * 1. **Hydrate** the saved map once from `GET /api/preferences/create-defaults`
 *    (sibling of the accordion-sections blob — separate settings key so the two
 *    fire-and-forget writers can never clobber each other).
 * 2. **Restore** each stored bookmark into its field after hydration — skipping
 *    fields the user already touched this visit, waiting (bounded, 10s) for
 *    async data a value must validate against (machines list, accounts list),
 *    and dropping stale values (a machine/account that no longer exists).
 * 3. **Indicator semantics**: the icon is filled ⟺ the field is currently
 *    SHOWING its bookmarked value. Editing a field never writes to the store —
 *    it merely unfills the icon. Only explicit clicks mutate the store: an
 *    unfilled click stores the current value; a filled click deletes the
 *    bookmark (the field keeps its value this visit; the NEXT visit falls back
 *    to the system default). `restoreAll` re-applies stored values on demand.
 * 4. **Persist** changes back via PUT, debounced + flushed on unmount.
 *
 * Field values are stored opaquely (JSON) keyed by stable field ids. Standard
 * fields map 1:1 to `index.tsx` state; scheduled-mode fields map through
 * {@link SCHEDULE_FIELD_KEYS} onto `ScheduleState` keys (composite ids like
 * `schedule.timezone` bundle several keys into one small object).
 */

export type SavedDefaults = Record<string, unknown>;

/** Standard-mode field ids (scheduled-mode ids live in SCHEDULE_FIELD_KEYS). */
export const STANDARD_FIELD_IDS = [
  "federationNode",
  "directory",
  "cliHarness",
  "account",
  "launcher",
  "model",
  "effort",
  "outputStyle",
  "openrouterModel",
  "githubAccount",
  "repo",
  "gitType",
  "sessionName",
  "branchName",
  // hapimatic-private#4481: the Branch control choice (after gitType + branchName
  // so a restored existing-branch pick wins over a restored Git Type).
  "branch",
  "permissionMode",
  "safeMode",
  "sessionMode",
] as const;

export type StandardFieldId = (typeof STANDARD_FIELD_IDS)[number];

/**
 * Field ids removed from the bookmark system, stripped from any stored map on
 * hydrate so a stale server-side value can never re-apply: `linkIssue` (a
 * session's linked issue should never have a default) and `provider` (always
 * derived from the CLI harness — auto-inherited fields are ineligible for
 * saved defaults; the on-page inheritance takes precedence).
 */
export const RETIRED_FIELD_IDS = ["linkIssue", "provider"] as const;

/** Drop retired ids from a stored defaults map (pure; used at hydrate). */
export function stripRetiredIds(map: SavedDefaults): SavedDefaults {
  const next = { ...map };
  for (const id of RETIRED_FIELD_IDS) delete next[id];
  return next;
}

/**
 * Scheduled-mode bookmark ids → the `ScheduleState` keys each one covers.
 * Single-key ids store the raw value; multi-key ids store a `{key: value}`
 * object (e.g. Timezone bundles the zone + the DST checkbox).
 */
export const SCHEDULE_FIELD_KEYS: Record<
  string,
  readonly (keyof ScheduleState)[]
> = {
  "schedule.status": ["scheduleEnabled"],
  "schedule.prompt": ["prompt"],
  "schedule.overlap": ["overlapPolicy"],
  "schedule.notify": ["notifyOn"],
  "schedule.maxRuntime": ["maxRuntimeMinutes"],
  "schedule.preWork": ["preWorkInstructions"],
  "schedule.closing": ["closingInstructions"],
  "schedule.timezone": ["timezone", "dstAdjustment"],
  "schedule.lifetimeStart": ["lifetimeStart"],
  "schedule.lifetimeEnd": ["lifetimeEnd"],
  "schedule.everyNWeeks": ["everyNWeeks"],
  "schedule.activeDays": ["activeDays"],
  "schedule.clockIn": ["clockIn"],
  "schedule.clockOut": ["clockOut"],
  "schedule.interval": ["intervalMs"],
  "schedule.eventCountLimit": ["eventCountLimit"],
  "schedule.backoff": ["backoffEnabled"],
  "schedule.backoffMultiplier": ["backoffMultiplier"],
  "schedule.backoffThreshold": ["backoffThreshold"],
  "schedule.jitter": ["jitterMs"],
  "schedule.suppression": ["responseSuppression"],
  "schedule.heartbeat": ["heartbeatMode"],
  "schedule.standingOrders": [
    "standingOrdersMode",
    "standingOrdersText",
    "standingOrdersFile",
  ],
  "schedule.ackToken": ["ackToken"],
  "schedule.rotation": [
    "rotationMode",
    "rotationDays",
    "rotationTime",
    "rotationCount",
  ],
  "schedule.runOnce": ["runOnceAtCreation"],
};

/** Current values of every scheduled-mode bookmark id. */
export function buildScheduleValues(state: ScheduleState): SavedDefaults {
  const out: SavedDefaults = {};
  for (const [id, keys] of Object.entries(SCHEDULE_FIELD_KEYS)) {
    out[id] =
      keys.length === 1
        ? state[keys[0]]
        : Object.fromEntries(keys.map(k => [k, state[k]]));
  }
  return out;
}

/** Loose shape check against the known-good default value (arrays vs scalars). */
function typeMatches(v: unknown, reference: unknown): boolean {
  if (Array.isArray(reference)) return Array.isArray(v);
  return typeof v === typeof reference;
}

/**
 * Convert one saved scheduled-mode default into a `ScheduleState` partial.
 * Returns null when the id is unknown or the value fails the shape check
 * (a stale/corrupt blob degrades to "no restore", never a broken form).
 */
export function scheduleDefaultToPartial(
  id: string,
  value: unknown
): Partial<ScheduleState> | null {
  const keys = SCHEDULE_FIELD_KEYS[id];
  if (!keys) return null;
  if (keys.length === 1) {
    const k = keys[0];
    if (!typeMatches(value, defaultScheduleState[k])) return null;
    return { [k]: value } as Partial<ScheduleState>;
  }
  if (typeof value !== "object" || value === null) return null;
  const partial: Record<string, unknown> = {};
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v !== undefined && typeMatches(v, defaultScheduleState[k])) {
      partial[k] = v;
    }
  }
  return Object.keys(partial).length > 0
    ? (partial as Partial<ScheduleState>)
    : null;
}

/** Setters the restore pass drives. Each lambda (built in `index.tsx`) also
 *  sets the same "user edited"/"initialized" guards a real user interaction
 *  would, so the existing auto-default effects never clobber a restored value. */
export type DefaultsFieldSetters = {
  federationNode: (value: string) => void;
  directory: (value: string) => void;
  cliHarness: (value: AgentType) => void;
  account: (value: string | null) => void;
  launcher: (value: ClaudeRemoteLauncherKind) => void;
  model: (value: string) => void;
  effort: (value: EffortLevel | "") => void;
  outputStyle: (value: string) => void;
  openrouterModel: (value: string) => void;
  githubAccount: (value: string | null) => void;
  repo: (value: string | null) => void;
  gitType: (value: SessionType) => void;
  sessionName: (value: string) => void;
  branchName: (value: string) => void;
  /** #4481: apply a restored Branch choice (already validated against the listing). */
  branch: (value: BranchChoice) => void;
  permissionMode: (value: PermissionMode) => void;
  safeMode: (value: boolean) => void;
  sessionMode: (value: SessionMode) => void;
  schedule: (partial: Partial<ScheduleState>) => void;
};

const AGENT_TYPES: readonly string[] = [
  "claude",
  "codex",
  "gemini",
  "opencode",
];
const LAUNCHER_KINDS: readonly string[] = ["sdk", "tmux", "pty"];

type ApplyResult = "applied" | "wait" | "drop";

/** Debounced, unmount-flushed server persistence for the saved-defaults map. */
function useDefaultsStore(api: ApiClient | null): {
  defaults: SavedDefaults;
  hydrated: boolean;
  update: (updater: (prev: SavedDefaults) => SavedDefaults) => void;
} {
  const [defaults, setDefaults] = useState<SavedDefaults>({});
  const [hydrated, setHydrated] = useState(false);
  const hydrateStartedRef = useRef(false);
  const dirtyRef = useRef(false);
  const latestRef = useRef<SavedDefaults>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const client = apiRef.current;
    if (!client || !dirtyRef.current) return;
    dirtyRef.current = false;
    void Promise.resolve()
      .then(() =>
        client.setCreateSessionDefaults({ defaults: latestRef.current })
      )
      .catch(() => {
        /* best-effort; in-memory state already reflects the user's intent */
      });
  }, []);

  useEffect(() => {
    if (!api || hydrateStartedRef.current) return;
    hydrateStartedRef.current = true;
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.getCreateSessionDefaults())
      .then(prefs => {
        if (cancelled) return;
        // A toggle made before the fetch resolved wins over the fetched blob.
        if (!dirtyRef.current && prefs?.defaults) {
          const cleaned = stripRetiredIds(prefs.defaults);
          latestRef.current = cleaned;
          setDefaults(cleaned);
          // A retired id was stored server-side — persist the cleaned map so
          // the stale value can never come back on a future visit.
          if (
            Object.keys(cleaned).length !== Object.keys(prefs.defaults).length
          ) {
            dirtyRef.current = true;
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(flush, 500);
          }
        }
        setHydrated(true);
      })
      .catch(() => {
        if (!cancelled) setHydrated(true); // degrade to "no saved defaults"
      });
    return () => {
      cancelled = true;
    };
  }, [api, flush]);

  const update = useCallback(
    (updater: (prev: SavedDefaults) => SavedDefaults) => {
      setDefaults(prev => {
        const next = updater(prev);
        latestRef.current = next;
        dirtyRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flush, 500);
        return next;
      });
    },
    [flush]
  );

  // Flush a pending write when the Create page unmounts.
  useEffect(() => flush, [flush]);

  return { defaults, hydrated, update };
}

export function useCreateDefaultsEngine(params: {
  api: ApiClient | null;
  /** Current values of the standard-mode fields (fresh object each render). */
  values: Record<StandardFieldId, unknown>;
  scheduleState: ScheduleState;
  /** Async data some restores must validate against before applying. */
  data: {
    machines: Machine[];
    remoteNodes?: RemoteNode[];
    accounts: RedactedAccount[];
    /** True while the selected directory's repo is auto-detected — the
     *  on-page inheritance owns the repo field, so its saved default is
     *  ineligible (never applied over a detected repo). */
    repoAutoDetected: boolean;
    /** #4481: the selected directory's branch listing — `undefined` while
     *  loading; `branchListingUnavailable` when the lookup failed. */
    branchListing?: GitBranchListing;
    branchListingUnavailable?: boolean;
  };
  set: DefaultsFieldSetters;
}): {
  defaultsApi: CreateDefaultsApi;
  /** Mark a field as user-edited this visit (cancels its pending restore). */
  markTouched: (id: string) => void;
  /** ScheduleSection onChange wrapper — diffs keys to mark touched ids. */
  handleScheduleChange: (next: ScheduleState) => void;
} {
  const { defaults, hydrated, update } = useDefaultsStore(params.api);

  const touchedRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Set<string> | null>(null); // null until hydrated
  const currentValuesRef = useRef<SavedDefaults>({});
  const setRef = useRef(params.set);
  setRef.current = params.set;
  const dataRef = useRef(params.data);
  dataRef.current = params.data;
  const scheduleRef = useRef(params.scheduleState);
  scheduleRef.current = params.scheduleState;

  // Merged current-value snapshot (standard + scheduled ids), every render.
  currentValuesRef.current = {
    ...params.values,
    ...buildScheduleValues(params.scheduleState),
  };

  // True when the CURRENT cloneRepo value came from a defaults restore (not a
  // user pick). Lets the precedence effect below clear a restored repo when
  // auto-detection lands later, without ever touching a user's explicit choice.
  const repoRestoredRef = useRef(false);

  const markTouched = useCallback((id: string) => {
    touchedRef.current.add(id);
    pendingRef.current?.delete(id);
    // A user interaction with the repo field supersedes any restored value.
    if (id === "repo") repoRestoredRef.current = false;
  }, []);

  const handleScheduleChange = useCallback(
    (next: ScheduleState) => {
      const prev = scheduleRef.current;
      for (const [id, keys] of Object.entries(SCHEDULE_FIELD_KEYS)) {
        if (keys.some(k => !Object.is(prev[k], next[k]))) markTouched(id);
      }
      setRef.current.schedule(next);
    },
    [markTouched]
  );

  /** Attempt one restore. "wait" = data not loaded yet, retry on next pass. */
  const applyOne = useCallback((id: string, value: unknown): ApplyResult => {
    const set = setRef.current;
    const data = dataRef.current;
    if (id.startsWith("schedule.")) {
      const partial = scheduleDefaultToPartial(id, value);
      if (partial) set.schedule(partial);
      return partial ? "applied" : "drop";
    }
    switch (id as StandardFieldId) {
      case "federationNode": {
        if (typeof value !== "string" || !value) return "drop";
        const target = parseSpawnTarget(value);
        if (!target) return "drop";
        if (target.kind === "local") {
          if (data.machines.length === 0) return "wait";
          if (!data.machines.some(m => m.id === target.machineId))
            return "drop"; // stale machine id
        } else {
          if (!data.remoteNodes || data.remoteNodes.length === 0) return "wait";
          if (!data.remoteNodes.some(n => n.nodeId === target.nodeId))
            return "drop";
        }
        set.federationNode(value);
        return "applied";
      }
      case "directory":
        if (typeof value !== "string") return "drop";
        set.directory(value);
        return "applied";
      case "cliHarness":
        if (typeof value !== "string" || !AGENT_TYPES.includes(value))
          return "drop";
        set.cliHarness(value as AgentType);
        return "applied";
      case "account": {
        if (value === null) {
          set.account(null);
          return "applied";
        }
        if (typeof value !== "string") return "drop";
        if (dataRef.current.accounts.length === 0) return "wait";
        if (!dataRef.current.accounts.some(a => a.accountUuid === value))
          return "drop"; // account no longer stored
        set.account(value);
        return "applied";
      }
      case "launcher":
        if (typeof value !== "string" || !LAUNCHER_KINDS.includes(value))
          return "drop";
        set.launcher(value as ClaudeRemoteLauncherKind);
        return "applied";
      case "model":
        if (typeof value !== "string") return "drop";
        set.model(value);
        return "applied";
      case "effort":
        if (
          typeof value !== "string" ||
          (value !== "" &&
            !(EFFORT_LEVELS as readonly string[]).includes(value))
        )
          return "drop";
        set.effort(value as EffortLevel | "");
        return "applied";
      case "outputStyle":
        // #2626 (D): free-form style name (built-in or custom); no enum
        // validation — an unknown name is silently no-op'd at spawn (Task 1 spike).
        if (typeof value !== "string") return "drop";
        set.outputStyle(value);
        return "applied";
      case "openrouterModel":
        if (typeof value !== "string") return "drop";
        set.openrouterModel(value);
        return "applied";
      case "githubAccount":
        if (value !== null && typeof value !== "string") return "drop";
        set.githubAccount(value as string | null);
        return "applied";
      case "repo":
        if (value !== null && typeof value !== "string") return "drop";
        // Auto-inherited fields are immune to saved defaults: while the
        // directory's repo is auto-detected, the detected repo owns this
        // field — never apply the saved default over it.
        if (data.repoAutoDetected) return "drop";
        repoRestoredRef.current = true;
        set.repo(value as string | null);
        return "applied";
      case "gitType":
        if (value !== "simple" && value !== "worktree") return "drop";
        set.gitType(value);
        return "applied";
      case "sessionName":
        if (typeof value !== "string") return "drop";
        set.sessionName(value);
        return "applied";
      case "branchName":
        if (typeof value !== "string") return "drop";
        set.branchName(value);
        return "applied";
      case "branch": {
        // #4481: `{kind:"current"|"new"}` applies directly; an existing branch
        // waits for the directory's listing and is applied only while still
        // selectable (present, not current, not held by another worktree).
        if (typeof value !== "object" || value === null) return "drop";
        const v = value as { kind?: unknown; branch?: unknown };
        if (v.kind === "current" || v.kind === "new") {
          set.branch({ kind: v.kind });
          return "applied";
        }
        if (v.kind !== "existing") return "drop";
        const b = v.branch as { name?: unknown; remote?: unknown } | undefined;
        if (!b || typeof b.name !== "string" || typeof b.remote !== "boolean")
          return "drop";
        if (dataRef.current.branchListingUnavailable) return "drop";
        const listing = dataRef.current.branchListing;
        if (!listing) return "wait";
        if (!listing.isGitRepo) return "drop";
        const resolved = resolveRestoredBranch(
          { name: b.name, remote: b.remote },
          listing
        );
        if (!resolved) return "drop";
        set.branch({ kind: "existing", branch: resolved });
        return "applied";
      }
      case "permissionMode":
        if (typeof value !== "string") return "drop";
        set.permissionMode(value as PermissionMode);
        return "applied";
      case "safeMode":
        if (typeof value !== "boolean") return "drop";
        set.safeMode(value);
        return "applied";
      case "sessionMode":
        if (value !== "standard" && value !== "scheduled") return "drop";
        set.sessionMode(value);
        return "applied";
      default:
        return "drop"; // unknown id from a newer/older client — ignore
    }
  }, []);

  // Restore pass. Seeds the pending set once hydration lands, then retries
  // "wait" ids whenever the async data lists change. A 10s bound gives up on
  // ids whose data never arrives (e.g. a saved remote node while federation is
  // down) so a dead entry doesn't keep retrying forever.
  useEffect(() => {
    if (!hydrated) return;
    if (pendingRef.current === null) {
      pendingRef.current = new Set(
        Object.keys(defaults).filter(id => !touchedRef.current.has(id))
      );
      setTimeout(() => pendingRef.current?.clear(), 10_000);
    }
    const pending = pendingRef.current;
    for (const id of Array.from(pending)) {
      if (touchedRef.current.has(id)) {
        pending.delete(id);
        continue;
      }
      const result = applyOne(id, defaults[id]);
      if (result !== "wait") pending.delete(id);
    }
    // `defaults` is deliberately read but not depended on for re-seeding — the
    // pending set is seeded exactly once per page visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hydrated,
    applyOne,
    params.data.machines,
    params.data.remoteNodes,
    params.data.accounts,
    // #4481: retry a waiting `branch` restore once the listing lands.
    params.data.branchListing,
    params.data.branchListingUnavailable,
  ]);

  // Inheritance precedence: repo auto-detection is async, so it can land AFTER
  // the restore pass already applied a saved repo default. When it does, the
  // detected repo wins — clear the restored clone selection so no stale
  // `--clone` flag leaks into the spawn payload. A user-picked repo is exempt
  // (markTouched("repo") clears the restored flag).
  useEffect(() => {
    if (params.data.repoAutoDetected && repoRestoredRef.current) {
      repoRestoredRef.current = false;
      setRef.current.repo(null);
    }
  }, [params.data.repoAutoDetected]);

  const hasAny = Object.keys(defaults).length > 0;

  const defaultsApi = useMemo<CreateDefaultsApi>(
    () => ({
      // INDICATOR semantics: filled ⟺ a bookmark is stored AND the field is
      // currently showing it. Reads the per-render value snapshot at call time,
      // so an edit to a bookmarked field unfills its icon on the same render.
      isBookmarked: id =>
        defaults[id] !== undefined &&
        jsonEqual(defaults[id], currentValuesRef.current[id]),
      // Filled click → DELETE the bookmark (the field keeps its value this
      // visit; the next visit falls back to the system default). Unfilled
      // click → store the current value as the (new) bookmark. Field values
      // are never mutated here.
      toggle: id => {
        pendingRef.current?.delete(id);
        update(prev => {
          const next = { ...prev };
          const cur = currentValuesRef.current[id];
          const filled = prev[id] !== undefined && jsonEqual(prev[id], cur);
          if (filled) {
            delete next[id];
          } else {
            next[id] = cur === undefined ? null : cur;
          }
          return next;
        });
      },
      makeAll: () => {
        pendingRef.current?.clear();
        update(() => {
          const snapshot: SavedDefaults = {};
          for (const [id, v] of Object.entries(currentValuesRef.current)) {
            snapshot[id] = v === undefined ? null : v;
          }
          return snapshot;
        });
      },
      // Deletes every bookmark; field values stay exactly as they are —
      // identical to clicking each filled icon once.
      clearAll: () => {
        pendingRef.current?.clear();
        update(() => ({}));
      },
      // Re-apply every stored bookmark to its field right now (undoes edits
      // made after the values were bookmarked). Store untouched.
      restoreAll: () => {
        for (const [id, value] of Object.entries(defaults)) {
          applyOne(id, value);
        }
      },
      hasAny,
    }),
    [defaults, hasAny, update, applyOne]
  );

  return { defaultsApi, markTouched, handleScheduleChange };
}

/** Null-normalized JSON equality for small field values. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(a === undefined ? null : a) ===
    JSON.stringify(b === undefined ? null : b)
  );
}
