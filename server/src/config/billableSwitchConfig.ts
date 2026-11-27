// SPDX-License-Identifier: AGPL-3.0-only
import {
  BILLABLE_SWITCH_CAPABILITY,
  BILLABLE_SWITCH_CLOSED_CAPABILITY,
  BILLABLE_SWITCH_DEFAULT_MODE,
  BILLABLE_SWITCH_STORE_CAPABILITY,
  BILLABLE_TRACKING_CAPABILITY,
  BILLABLE_TRACKING_CARRY_CAPABILITY,
  type BillableSwitchMode,
} from "@hapi/protocol";

/**
 * The billable-sessions gate (issue #6646, ruling Q9 (a)): three states, ONE
 * effective value per process, resolved in `server/src/index.ts` right after
 * `new Store` and handed to every reader as an option (the Pins shape). In text
 * a person reads, it is "billable sessions" being enabled on a node, never "the
 * billable switch", which names a session's own control (TERM-1).
 *
 * Server-side only: the web and other nodes read the answer from
 * `GET /api/version` and the capability tags. The default stays `off` in every
 * build (ruling ROLL-1); the feature is switched on per node by this variable.
 */
export const BILLABLE_SWITCH_ENV = "HAPI_BILLABLE_SWITCH";

/** Values of the variable that open the gate. */
const ON_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * The state the variable asks for: unset → the default; `1`, `true`, `yes` or
 * `on` → `on`; `closed` → `closed`; any other value, the empty string included
 * → `off` (so a unit with an empty `HAPI_BILLABLE_SWITCH=` line stays dark).
 */
export function resolveBillableSwitchMode(
  env: Record<string, string | undefined> = process.env
): BillableSwitchMode {
  const raw = env[BILLABLE_SWITCH_ENV];
  if (raw === undefined) return BILLABLE_SWITCH_DEFAULT_MODE;
  const value = raw.trim().toLowerCase();
  if (ON_VALUES.has(value)) return "on";
  if (value === "closed") return "closed";
  return "off";
}

/**
 * The effective state: storage not ready → `off`; `on` → `on`; `closed` →
 * `closed`; `off` → `closed` when this node's event table holds any row, else
 * `off`. A node that has ever recorded a switch cannot be made dark by removing
 * the variable: its stored switches stay correctable.
 */
export function resolveEffectiveBillableSwitchMode(input: {
  envMode: BillableSwitchMode;
  storageReady: boolean;
  hasEvents: boolean | (() => boolean);
}): BillableSwitchMode {
  if (!input.storageReady) return "off";
  if (input.envMode === "on") return "on";
  if (input.envMode === "closed") return "closed";
  const hasEvents =
    typeof input.hasEvents === "function" ? input.hasEvents() : input.hasEvents;
  return hasEvents ? "closed" : "off";
}

/** Why the effective state is what it is (for the one boot log line). */
export type BillableSwitchModeSource =
  | "variable"
  | "default"
  | "storage-not-ready"
  | "events-exist";

/** The gate as every reader receives it. */
export type BillableSwitchGateState = {
  mode: BillableSwitchMode;
  /** Both columns and all six tables exist (Task 3's readiness check). */
  storageReady: boolean;
  source: BillableSwitchModeSource;
  /**
   * #6778 (3.4 step 6): the start-up reconcile, apart from "the schema is
   * there". A session it could not settle is listed; the gate is unaffected.
   */
  startup?: { ok: boolean; reconciled: number; failedSessionIds: string[] };
};

/** The state a reader assumes when it was handed none (tests, a bare build). */
export const BILLABLE_SWITCH_GATE_DARK: BillableSwitchGateState = {
  mode: "off",
  storageReady: false,
  source: "default",
};

/** Resolve the effective gate once, with the reason for the boot log. */
export function resolveBillableSwitchGate(input: {
  env?: Record<string, string | undefined>;
  storageReady: boolean;
  hasEvents: () => boolean;
  startup?: BillableSwitchGateState["startup"];
}): BillableSwitchGateState {
  const env = input.env ?? process.env;
  const fromVariable = env[BILLABLE_SWITCH_ENV] !== undefined;
  const envMode = resolveBillableSwitchMode(env);
  const mode = resolveEffectiveBillableSwitchMode({
    envMode,
    storageReady: input.storageReady,
    hasEvents: input.hasEvents,
  });
  let source: BillableSwitchModeSource;
  if (!input.storageReady) source = "storage-not-ready";
  else if (envMode === "off" && mode === "closed") source = "events-exist";
  else source = fromVariable ? "variable" : "default";
  return {
    mode,
    storageReady: input.storageReady,
    source,
    ...(input.startup ? { startup: input.startup } : {}),
  };
}

/** The one boot log line: the effective state and where it came from. */
export function describeBillableSwitchGate(
  state: BillableSwitchGateState
): string {
  const why: Record<BillableSwitchModeSource, string> = {
    variable: `from ${BILLABLE_SWITCH_ENV}`,
    default: "the default",
    "storage-not-ready": "forced off: the switch storage is not ready",
    "events-exist": `closed because switch events exist (${BILLABLE_SWITCH_ENV} unset or not on)`,
  };
  const failed = state.startup?.failedSessionIds.length ?? 0;
  const tail =
    failed > 0
      ? `; tracking reconcile: ${failed} session(s) not settled, retried every 5 minutes`
      : "";
  return `[Server] Billable sessions: ${state.mode} (${why[state.source]})${tail}`;
}

/**
 * The capability tags this node advertises, appended per call by
 * `detectCapabilities`: `billable:switch-store` whenever the storage is ready
 * (in every state: it says the node's summaries carry the switch) and
 * `billable:tracking` with it (#6778: the widened storage is ready, so the node
 * stores tracking records),
 * `billable:switch` when `on`, `billable:switch-closed` when `closed`.
 */
export function billableSwitchCapabilityTags(
  state: Pick<BillableSwitchGateState, "mode" | "storageReady"> | undefined
): string[] {
  if (!state) return [];
  const tags: string[] = [];
  if (state.storageReady) {
    tags.push(BILLABLE_SWITCH_STORE_CAPABILITY);
    // #6778 PR-B (4.1, Task 10): the node stores tracking records.
    tags.push(BILLABLE_TRACKING_CAPABILITY);
    // #6778 PR-C (4.1, Task 15): it keeps and re-checks a carried start
    // (`spawnForPeer`), serves the tracking receivers and answers whether a
    // carried start was applied, in every gate state; the gate itself is what
    // `billable:switch` says.
    tags.push(BILLABLE_TRACKING_CARRY_CAPABILITY);
  }
  if (state.mode === "on") tags.push(BILLABLE_SWITCH_CAPABILITY);
  if (state.mode === "closed") tags.push(BILLABLE_SWITCH_CLOSED_CAPABILITY);
  return tags;
}

/**
 * A path whose segments name a route behind the billable gate (#6646's switch,
 * #6779's billing categories, #6778's tracking record). Whole segments only, so
 * #6586's `/api/billable-time/...` never matches.
 */
export function isBillableSwitchRoutePath(path: string): boolean {
  return path.split("/").some(
    seg =>
      seg === "billable" ||
      seg === "billable-switch" ||
      seg === "bulk-billable-keep" ||
      // #6779: the billing-category routes and receivers, behind the same gate.
      seg === "billing-categories" ||
      // #6778 PR-C: the tracking record's routes and receivers (7.2).
      seg === "tracking"
  );
}
