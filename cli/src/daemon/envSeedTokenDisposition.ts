// SPDX-License-Identifier: MIT
/**
 * Issue #3731 (R0/R0b, F1, F8): the daemon's handling of the onboarding
 * `CLAUDE_CODE_OAUTH_TOKEN` it finds in its service env.
 *
 * 1. {@link beginEnvSeedTokenDisposition} — at boot, HOLD the token as the node's
 *    instance credential (`ctx.instanceOAuthToken`) BEFORE anything can release it,
 *    so unbound claude spawns still receive it explicitly afterwards.
 * 2. {@link disposeEnvSeedToken} — once the account-store seed settles, delete the
 *    AMBIENT copy from the daemon env when the store serves the primary account
 *    (`released`), otherwise keep it and warn (`retained`).
 * 3. {@link recordAmbientTokenState} — persist that disposition in the daemon's own
 *    state file, because `/proc/<pid>/environ` is the launch snapshot and never
 *    shows a runtime release. `hapi doctor` reads this record.
 *
 * The env, the credential holder, the state writer and the logger are all injected,
 * so the behavior is unit-testable without touching the real `process.env`. No
 * function here ever logs or persists a token value. Only
 * {@link beginEnvSeedTokenDisposition} returns one, to its caller, which keeps it
 * in memory for the seed.
 */
import {
  shouldReleaseEnvSeedToken,
  type SeedBootResult,
} from "@/accounts/seedFromEnvToken";
import type {
  AmbientOnboardingTokenState,
  DaemonLocallyPersistedState,
} from "@/persistence";

/** Issue #4153 (B3): ONE state list. The parser comes from `@hapi/protocol/accounts`
 *  (#4736), so the daemon, `hapi doctor` and the server validate the same set. */
export { parseAmbientOnboardingTokenState } from "@hapi/protocol/accounts";

type EnvLike = Record<string, string | undefined>;

export interface DispositionLogger {
  info(message: string): void;
  warn(message: string): void;
}

export const RELEASED_LOG_LINE =
  "[DAEMON RUN] Released the ambient onboarding CLAUDE_CODE_OAUTH_TOKEN from the daemon env — the account store now serves the primary account; unbound claude spawns receive the instance credential explicitly (#3731)";

export const RETAINED_LOG_LINE =
  "[DAEMON RUN] Env-token fallback retained: the onboarding CLAUDE_CODE_OAUTH_TOKEN stays in the daemon env because the account store could not seed the primary account; isolated accounts are protected by the per-pane unset + launcher strip (#3731)";

export const RETAINED_AFTER_ERROR_LOG_LINE =
  "[DAEMON RUN] Env-token fallback retained: the account-store seed errored, so the onboarding CLAUDE_CODE_OAUTH_TOKEN stays in the daemon env; isolated accounts are protected by the per-pane unset + launcher strip (#3731)";

/**
 * Boot step: read the onboarding token from `env` and hold it on `holder` as the
 * instance credential. The hold happens whether or not the ambient copy is later
 * released, so the release can never strand an unbound session.
 */
export function beginEnvSeedTokenDisposition(input: {
  env: EnvLike;
  holder: { instanceOAuthToken?: string };
}): { envSeedToken: string | undefined; state: AmbientOnboardingTokenState } {
  const envSeedToken = input.env.CLAUDE_CODE_OAUTH_TOKEN || undefined;
  if (envSeedToken) input.holder.instanceOAuthToken = envSeedToken;
  return { envSeedToken, state: envSeedToken ? "pending" : "absent" };
}

/**
 * Seed-settled step: release or retain the AMBIENT copy. `summary` is `null` when
 * the seed itself errored — the token is retained and the log line says so.
 * Mutates only `env` (deletes `CLAUDE_CODE_OAUTH_TOKEN` on release).
 */
export function disposeEnvSeedToken(input: {
  envSeedToken: string | undefined;
  summary: SeedBootResult | null;
  env: EnvLike;
  logger: DispositionLogger;
}): AmbientOnboardingTokenState {
  if (!input.envSeedToken) return "absent";
  if (input.summary && shouldReleaseEnvSeedToken(input.summary)) {
    delete input.env.CLAUDE_CODE_OAUTH_TOKEN;
    input.logger.info(RELEASED_LOG_LINE);
    return "released";
  }
  input.logger.warn(
    input.summary ? RETAINED_LOG_LINE : RETAINED_AFTER_ERROR_LOG_LINE
  );
  return "retained";
}

/**
 * Persist `state` on the shared daemon state object and write it out. The heartbeat
 * re-writes the same object's fields, so the record survives later ticks.
 * Fail-soft: a write failure is logged (never the token) and never throws.
 */
export function recordAmbientTokenState(input: {
  fileState: DaemonLocallyPersistedState;
  state: AmbientOnboardingTokenState;
  write: (state: DaemonLocallyPersistedState) => void;
  logger: DispositionLogger;
}): void {
  input.fileState.ambientOnboardingToken = input.state;
  try {
    input.write(input.fileState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.logger.warn(
      `[DAEMON RUN] Could not persist the onboarding-token state "${input.state}" to the daemon state file: ${message} (#3731)`
    );
  }
}

/**
 * Issue #4153 (B2): the seed-settled step in one call. Release or retain the
 * ambient copy ({@link disposeEnvSeedToken}), then record the outcome
 * ({@link recordAmbientTokenState}). `summary` is `null` when the seed errored.
 * A no-op when the daemon started without an env token.
 */
export function settleEnvSeedToken(input: {
  envSeedToken: string | undefined;
  summary: SeedBootResult | null;
  fileState: DaemonLocallyPersistedState;
  env: EnvLike;
  write: (state: DaemonLocallyPersistedState) => void;
  logger: DispositionLogger;
}): void {
  if (!input.envSeedToken) return;
  recordAmbientTokenState({
    fileState: input.fileState,
    state: disposeEnvSeedToken(input),
    write: input.write,
    logger: input.logger,
  });
}
