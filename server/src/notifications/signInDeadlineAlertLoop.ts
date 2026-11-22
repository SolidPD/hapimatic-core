// SPDX-License-Identifier: AGPL-3.0-only
import {
  type JobRegistry,
  SupervisedLoop,
  WORKTREE_PORT_MAX,
  WORKTREE_PORT_MIN,
} from "@hapi/protocol";
import { DEV_WEBAPP_PORT } from "../web/instanceManifest";
import type {
  SignInDeadlineAlertInput,
  SignInDeadlineAlertService,
} from "../accounts/signInDeadlineAlertService";

/** How often the producer checks this node's accounts (issue #6161). */
export const SIGN_IN_DEADLINE_ALERT_INTERVAL_MS = 10 * 60 * 1000;

const SWITCH_ON = new Set(["1", "true", "yes", "on"]);
const SWITCH_OFF = new Set(["0", "false", "no", "off"]);

export type SignInEndingAlertSwitch = {
  enabled: boolean;
  reason: "env-on" | "env-off" | "default" | "worktree-default" | "dev-default";
  /** A value that was neither on nor off and was ignored. */
  ignored?: string;
};

/**
 * Issue #6161 (DEC-2): whether this instance runs the sign-in deadline producer.
 * `HAPI_SIGN_IN_ENDING_ALERT_ENABLED` = `1` (or true/yes/on) or `0` (or
 * false/no/off) wins; unset means on, except on the worktree port range and on
 * the dev port, where it is off. Why: each instance has its own database, so the
 * dedupe table cannot see another instance, while the account folders are shared
 * by every instance on the machine; one instance per node keeps it to one
 * notification per login per node. Named limit: an account held only in the dev
 * instance's store gets the page warning there and no notification. Modelled on
 * `resolveIndexingGate` (`services/transcriptIndexer.ts`).
 */
export function resolveSignInEndingAlertSwitch(
  env: Record<string, string | undefined> = process.env,
  opts: { listenPort?: number } = {}
): SignInEndingAlertSwitch {
  const raw = env.HAPI_SIGN_IN_ENDING_ALERT_ENABLED;
  const value = raw?.trim().toLowerCase() ?? "";
  if (SWITCH_ON.has(value)) return { enabled: true, reason: "env-on" };
  if (SWITCH_OFF.has(value)) return { enabled: false, reason: "env-off" };
  const ignored = value !== "" ? { ignored: raw } : {};
  const port = opts.listenPort;
  if (
    port !== undefined &&
    port >= WORKTREE_PORT_MIN &&
    port <= WORKTREE_PORT_MAX
  ) {
    return { enabled: false, reason: "worktree-default", ...ignored };
  }
  if (port === DEV_WEBAPP_PORT) {
    return { enabled: false, reason: "dev-default", ...ignored };
  }
  return { enabled: true, reason: "default", ...ignored };
}

/** The one boot line: on or off, and why. */
export function describeSignInEndingAlertSwitch(
  s: SignInEndingAlertSwitch
): string {
  const why: Record<SignInEndingAlertSwitch["reason"], string> = {
    "env-on": "HAPI_SIGN_IN_ENDING_ALERT_ENABLED is on",
    "env-off": "HAPI_SIGN_IN_ENDING_ALERT_ENABLED is off",
    default: "default for this instance",
    "worktree-default": "off by default on a worktree instance",
    "dev-default": "off by default on the dev instance",
  };
  const ignored =
    s.ignored !== undefined
      ? `; ignored HAPI_SIGN_IN_ENDING_ALERT_ENABLED=${JSON.stringify(s.ignored)} (use 1 or 0)`
      : "";
  return `[sign-in-deadline] notifications ${s.enabled ? "on" : "off"} (${why[s.reason]}${ignored})`;
}

/**
 * Issue #6161 (R14): the producer's loop, a `SupervisedLoop` named
 * `sign-in-deadline-alert`, every 10 minutes with its first tick one interval
 * after boot. `enabled: false` (the switch is off) registers it as `stopped`.
 * A reader error is logged and thrown on, so the loop's job status shows it:
 * `readNodeAccountHealth` throws on one bad entry, which costs one tick, not the
 * loop (the `SupervisedLoop` re-arms in `finally`). Modelled on
 * `createNotificationPurgeLoop`. The caller starts and stops it.
 */
export function createSignInDeadlineAlertLoop(opts: {
  service: Pick<SignInDeadlineAlertService, "checkAndNotify">;
  readEntries: () => SignInDeadlineAlertInput[];
  node: string;
  registry: JobRegistry;
  enabled: boolean;
  now?: () => number;
  log?: (line: string) => void;
}): SupervisedLoop {
  return new SupervisedLoop({
    name: "sign-in-deadline-alert",
    node: opts.node,
    intervalMs: SIGN_IN_DEADLINE_ALERT_INTERVAL_MS,
    immediate: false,
    enabled: opts.enabled,
    registry: opts.registry,
    tick: () => runSignInDeadlineAlertTick(opts),
  });
}

/**
 * One tick of the producer: read this node's entries, then check them. A reader
 * error is logged and then thrown on (review F2), as `createNotificationPurgeLoop`
 * does: the `SupervisedLoop` re-arms in `finally`, so it costs this tick and not
 * the loop, and three in a row mark the job `dead` in System Jobs instead of
 * leaving it `ok` while no account is checked.
 */
export async function runSignInDeadlineAlertTick(opts: {
  service: Pick<SignInDeadlineAlertService, "checkAndNotify">;
  readEntries: () => SignInDeadlineAlertInput[];
  now?: () => number;
  log?: (line: string) => void;
}): Promise<void> {
  const log = opts.log ?? console.log;
  let entries: SignInDeadlineAlertInput[];
  try {
    entries = opts.readEntries();
  } catch (err) {
    log(
      `[sign-in-deadline] account read failed; skipping this tick: ${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }
  await opts.service.checkAndNotify(entries, (opts.now ?? Date.now)());
}
