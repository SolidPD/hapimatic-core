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
 * other key). Nothing but the two file operations sits between the read and the
 * write, because the CLI rewrites the same file under a lock this server does not
 * take (see `maxConcurrency.ts`); every statement in between widens the window in
 * which one of two overlapping writes is lost.
 *
 * #4056 (open at the time of writing) adds `updateSettings(file, mutate)` to
 * `settings.ts`. When it lands, keep the no-write path: read the key with
 * `readSettings` first and call the helper only for a write that is due — the
 * helper writes on every call.
 */

import {
  OnboardingStateSchema,
  type OnboardingState,
  type OnboardingStatePatch,
} from "@hapi/protocol/schemas";
import type { ErrorLogger } from "../logging/errorLogger";
import type { Store } from "../store";
import { readSettings, writeSettings, type Settings } from "./settings";

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
 * Merge a client patch over the effective state (the PUT semantics). A finished
 * tour stays finished: a dismissal — skipping a re-run after completion — never
 * demotes `completed`, whatever the client knew when it sent it (a client whose
 * first read failed cannot tell). Every other transition is honoured, including
 * an explicit re-arm to `pending` (the documented test-setup recipe).
 */
export function mergeOnboardingPatch(
  current: OnboardingState,
  patch: OnboardingStatePatch
): OnboardingState {
  const next: OnboardingState = {
    ...current,
    ...patch,
    status: patch.status ?? current.status,
  };
  if (current.status === "completed" && patch.status === "dismissed") {
    next.status = "completed";
  }
  return OnboardingStateSchema.parse(next);
}

/**
 * Per-settings-file promise chain that serializes every read-modify-write of the
 * key in this process (the PUT handler and the boot-time stamp) — the
 * `SettingsSyncService.writeChain` pattern. Without it two overlapping requests
 * (Next then Finish on a double tap or a burst of queued mobile requests) both
 * read the same old state and the second write discards the first: a finished
 * tour could be written back to `pending` and re-present itself.
 */
const writeChains = new Map<string, Promise<void>>();

/**
 * The single read-modify-write of the key, serialized per settings file. Reads
 * the file; stops without writing when it is unreadable; hands `decide` what the
 * key holds; writes nothing when `decide` returns nothing; otherwise sets ONLY
 * `onboardingState` on the object it just read and writes the file.
 */
export function updateOnboardingState(
  settingsFile: string,
  decide: (stored: StoredOnboardingState) => OnboardingState | undefined
): Promise<OnboardingStateUpdate> {
  const previous = writeChains.get(settingsFile) ?? Promise.resolve();
  const run = previous.then(() => readModifyWrite(settingsFile, decide));
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  writeChains.set(settingsFile, tail);
  void tail.then(() => {
    if (writeChains.get(settingsFile) === tail)
      writeChains.delete(settingsFile);
  });
  return run;
}

async function readModifyWrite(
  settingsFile: string,
  decide: (stored: StoredOnboardingState) => OnboardingState | undefined
): Promise<OnboardingStateUpdate> {
  const settings = await readSettings(settingsFile);
  if (settings === null) return { kind: "unreadable" };
  const stored = classify(settings);
  const next = decide(stored);
  if (next === undefined) {
    return { kind: "unchanged", state: effectiveOnboardingState(stored) };
  }
  (settings as Settings & Record<string, unknown>)[ONBOARDING_STATE_KEY] = next;
  await writeSettings(settingsFile, settings);
  return { kind: "written", state: next };
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
