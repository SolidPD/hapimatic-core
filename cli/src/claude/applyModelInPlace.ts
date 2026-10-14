// SPDX-License-Identifier: AGPL-3.0-only
import type { Query } from "./sdk/query";
import { SdkRequestError } from "./sdk/types";

/**
 * Issue #3769 (ruling D6): dependencies for {@link applyModelInPlace}. Injected
 * so the applier is a pure function of its inputs — the unit test drives it with
 * a fake `getLiveQuery`, and runClaude wires the real closure state + logger.
 */
export interface ApplyModelInPlaceDeps {
  /**
   * Reads the live SDK Query. Non-sdk launchers (tmux/pty), pre-launch, and
   * post-teardown never publish the accessor → returns `null` → method:"config".
   * Read FRESH each call (the accessor is set at onSessionReady, cleared on
   * teardown) — do NOT capture the Query itself.
   */
  getLiveQuery: () => Query | null;
  /**
   * The resolved raw `--model` value AFTER the caller's model/rawModel branches
   * ran (`undefined` for "default" mode → no live switch, mirroring the launch
   * guard `if (model) args.push("--model", model)`).
   */
  currentModel: string | undefined;
  /**
   * `currentModel` captured at handler entry, before any branch mutated it. The
   * live switch fires ONLY when `currentModel !== modelBefore`, so a multi-field
   * Apply fires `set_model` at most once and an effort-only / permission-only /
   * unchanged Apply never fires it (and never reports method:"sdk" for a change
   * the live query never received).
   */
  modelBefore: string | undefined;
  /**
   * Structured warn for a SWALLOWED live-switch failure. The durable pin is
   * already applied by the caller's branches; only the out-of-band live switch
   * failed. Carries the {@link SdkRequestError} classification for diagnostics
   * (R6). runClaude passes `logger.warn`; the test passes a spy.
   */
  warn: (message: string) => void;
}

/**
 * Issue #3769 (ruling D6): the ONE live-query model applier shared by the
 * `set-session-config` and `set-model` RPC handlers in `runClaude.ts`. A mirror
 * IN SHAPE of `applyPermissionModeInPlace` (runClaude.ts) — but, unlike that
 * applier, it owns NO durable write: the caller's model/rawModel branches already
 * resynced `currentModel` + the durable pin + `syncSessionModes()`. This applier
 * ONLY reaches the LIVE SDK query out-of-band via `Query.setModel` (the #2256
 * lever), which is the piece the `set-session-config` model path was missing
 * (web picks were pin-only / next-turn on SDK sessions).
 *
 * Call it ONCE per `set-session-config` call, AFTER `syncSessionModes()`, so a
 * multi-field Apply fires `set_model` at most once and the change-gate
 * (`currentModel !== modelBefore`) suppresses a live switch for an effort-only,
 * permission-only, or unchanged-model Apply.
 *
 * Failure semantics (R1): a live switch that throws is SWALLOWED to
 * method:"config" — the durable pin is already the record and the next message
 * reconciles the running query via the mode-hash relaunch
 * (`claudeRemoteLauncher.ts`), so a failed live switch is not a hard error. The
 * `SdkRequestError` code classification (`claude_exited` vs `transport_failed`,
 * matching the pre-#3769 inline `set-model` mapping) is preserved in the `warn`
 * for diagnostics rather than surfaced as an `{ok:false}` return.
 */
export async function applyModelInPlace(
  deps: ApplyModelInPlaceDeps
): Promise<{ method: "sdk" | "config" }> {
  const { getLiveQuery, currentModel, modelBefore, warn } = deps;
  const liveQuery = getLiveQuery();
  if (
    liveQuery &&
    typeof currentModel === "string" &&
    currentModel.length > 0 &&
    currentModel !== modelBefore
  ) {
    try {
      await liveQuery.setModel(currentModel);
      return { method: "sdk" };
    } catch (err) {
      const code =
        err instanceof SdkRequestError && err.code === "claude_exited"
          ? "claude_exited"
          : "transport_failed";
      warn(
        `[applyModelInPlace] live model switch to ${currentModel} failed (${code}): ${
          err instanceof Error ? err.message : String(err)
        } (durable model pin was applied; live query switch failed)`
      );
      return { method: "config" };
    }
  }
  return { method: "config" };
}
