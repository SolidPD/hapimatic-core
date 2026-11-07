// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node-local state of the in-app onboarding tour (issue #3865, OQ-2): the ONE
 * owner of the `onboardingState` key in this instance's settings file.
 *
 * The state is per INSTANCE (one settings file per node), which is per identity
 * on a one-user cloud VM and works unchanged for a self-hoster with no gateway.
 * It is NOT the gateway's `onboarding:launched` family (#2860), not localStorage,
 * and not in the federation-global SETTING_REGISTRY.
 *
 * Effective state: a stored value that parses against `OnboardingStateSchema`
 * reads as itself; an absent key or a value that does not parse reads as
 * `completed`. Only a stamped or explicitly written `pending` opens the tour.
 *
 * Writers: the preference PUT and the boot-time stamp both go through
 * `updateOnboardingState`, the single read-modify-write, so the unreadable-file
 * guard lives in one place. settings.json holds secrets (cliApiToken, apiKeys);
 * `readSettings` returns `null` for a file that exists but does not parse, and
 * such a file must never be rewritten with this one key (it would drop every
 * other key).
 *
 * #6211: that write runs on `updateSettings`, the same per-file chain the API-key
 * routes use. This module once kept a chain of its own, and the two did not
 * serialize against each other, so a key added while an onboarding PUT was in
 * flight could be silently lost. The wizard's Connect step makes that overlap
 * likely. The CLI still rewrites the same file under a lock this server does not
 * take (see `maxConcurrency.ts`), so `decide` stays synchronous and free of I/O.
 */

import {
  OnboardingStateSchema,
  type OnboardingFlowStep,
  type OnboardingOutcome,
  type OnboardingProviderKind,
  type OnboardingState,
} from "@hapi/protocol/schemas";
import type { ErrorLogger } from "../logging/errorLogger";
import type { Store } from "../store";
import {
  readSettings,
  SettingsUnreadableError,
  updateSettings,
  type Settings,
} from "./settings";

export { mergeOnboardingPatch } from "@hapi/protocol/schemas";

export const ONBOARDING_STATE_KEY = "onboardingState";

/** ErrorLogger category for the boot-time stamp. */
export const ONBOARDING_STATE_LOG_CATEGORY = "onboarding-state";

const COMPLETED: OnboardingState = { status: "completed" };

/** What the settings file holds under the key, before any defaulting. */
export type StoredOnboardingState =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "stored"; state: OnboardingState };

export type OnboardingStateUpdate =
  | { kind: "unreadable" }
  | { kind: "unchanged"; state: OnboardingState }
  | { kind: "written"; state: OnboardingState };

function classify(settings: Settings): StoredOnboardingState {
  const raw = (settings as Settings & Record<string, unknown>)[
    ONBOARDING_STATE_KEY
  ];
  if (raw === undefined) return { kind: "absent" };
  const parsed = OnboardingStateSchema.safeParse(raw);
  return parsed.success
    ? { kind: "stored", state: parsed.data }
    : { kind: "invalid" };
}

/** The state a reader sees: the stored value, or `completed` for anything else. */
export function effectiveOnboardingState(
  stored: StoredOnboardingState
): OnboardingState {
  return stored.kind === "stored" ? stored.state : COMPLETED;
}

/**
 * Read the effective state. `"unreadable"` when the settings file exists but
 * cannot be parsed — the route answers 503 rather than guessing.
 */
export async function readOnboardingState(
  settingsFile: string
): Promise<OnboardingState | "unreadable"> {
  const settings = await readSettings(settingsFile);
  if (settings === null) return "unreadable";
  return effectiveOnboardingState(classify(settings));
}

/**
 * #6211 R18: the outcomes a merge newly recorded, each once. Re-sending the same
 * outcome for a step (a retry, a replayed PUT) is not a new one.
 */
export function newOnboardingOutcomes(
  before: OnboardingState,
  after: OnboardingState
): Array<{
  step: OnboardingFlowStep;
  outcome: OnboardingOutcome;
  provider?: OnboardingProviderKind;
}> {
  const found = [];
  for (const [step, record] of Object.entries(after.flow?.outcomes ?? {})) {
    const key = step as OnboardingFlowStep;
    const earlier =
      before.flow?.run === after.flow?.run
        ? before.flow?.outcomes[key]
        : undefined;
    if (earlier?.outcome === record.outcome) continue;
    found.push({
      step: key,
      outcome: record.outcome,
      ...(record.provider ? { provider: record.provider } : {}),
    });
  }
  return found;
}

/**
 * The single read-modify-write of the key, on the per-file settings chain. Without
 * serialization two overlapping requests (Next then Finish on a double tap or a
 * burst of queued mobile requests) both read the same old state and the second
 * write discards the first: a finished tour could be written back to `pending` and
 * re-present itself. Stops without writing when the file is unreadable; hands
 * `decide` what the key holds; writes nothing when `decide` returns nothing;
 * otherwise sets ONLY `onboardingState` on the object it just read.
 */
export async function updateOnboardingState(
  settingsFile: string,
  decide: (stored: StoredOnboardingState) => OnboardingState | undefined
): Promise<OnboardingStateUpdate> {
  let result: OnboardingStateUpdate = { kind: "unreadable" };
  try {
    await updateSettings(settingsFile, current => {
      const stored = classify(current);
      const next = decide(stored);
      if (next === undefined) {
        result = { kind: "unchanged", state: effectiveOnboardingState(stored) };
        return current;
      }
      result = { kind: "written", state: next };
      return { ...current, [ONBOARDING_STATE_KEY]: next } as Settings;
    });
  } catch (err) {
    if (err instanceof SettingsUnreadableError) return { kind: "unreadable" };
    throw err;
  }
  return result;
}

/**
 * Boot-time stamp (operator ruling 3865-D2 → D). When the key is ABSENT, decide
 * once whether this instance is new: `pending` when the database holds no machine
 * row and no session row, `completed` when it holds either (a row of any
 * namespace counts; an archived session keeps its row; nothing deletes a machine
 * row). Any present value — `pending`, `dismissed`, `completed`, or one that does
 * not parse — is left alone, so no later boot overwrites a state.
 *
 * Must be awaited BEFORE the HTTP listener starts: a machine or session row can
 * only be created through `POST /cli/machines` / `POST /cli/sessions`, so a stamp
 * that reads the database before `Bun.serve` cannot race this process's first
 * daemon registration. The call order is pinned by a source test
 * (`onboardingState.test.ts`).
 *
 * Fail-soft: any error is reported through `errorLogger` and swallowed, so a
 * failed stamp never stops the boot. A stamp that could not be written leaves the
 * key absent, which reads as `completed` (no automatic tour; the Settings entry
 * still opens it).
 */
export async function stampOnboardingStateAtBoot(
  store: Pick<Store, "getRawDb">,
  settingsFile: string,
  errorLogger: ErrorLogger | null | undefined
): Promise<void> {
  try {
    const row = store
      .getRawDb()
      .query(
        "SELECT (EXISTS(SELECT 1 FROM machines) OR EXISTS(SELECT 1 FROM sessions)) AS hasRow"
      )
      .get() as { hasRow: number } | null;
    const hasRow = row?.hasRow === 1;

    const result = await updateOnboardingState(settingsFile, stored =>
      stored.kind === "absent"
        ? { status: hasRow ? "completed" : "pending" }
        : undefined
    );

    if (result.kind === "written") {
      // The journal is the only place that shows which boot decided, and on
      // what: a `completed` stamp on an instance that should have been new
      // fails nothing.
      console.log(
        `[onboarding] stamped ${ONBOARDING_STATE_KEY}=${result.state.status} ` +
          `(machine or session row found: ${hasRow ? "yes" : "no"})`
      );
    } else if (result.kind === "unreadable") {
      errorLogger?.warn(
        "onboarding state: settings file is unreadable; boot-time stamp skipped " +
          "(the tour will not auto-present on this instance)",
        { category: ONBOARDING_STATE_LOG_CATEGORY }
      );
    }
  } catch (err) {
    errorLogger?.error(
      "onboarding state: boot-time stamp failed; leaving the key unset " +
        "(reads as completed)",
      {
        category: ONBOARDING_STATE_LOG_CATEGORY,
        context: { error: err instanceof Error ? err.message : String(err) },
      }
    );
  }
}
