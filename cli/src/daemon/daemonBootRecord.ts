// SPDX-License-Identifier: MIT
/**
 * Issue #4153 (A1/A2/A3/A5): the daemon-side facts `hapi doctor` judges, put in
 * the daemon's BOOT `daemon.state.json` write.
 *
 * Doctor must judge the daemon's tmux socket, account-configs directory and
 * onboarding-token state from the daemon's own record, never from its own
 * environment. A doctor run under another uid, `TMUX_TMPDIR`,
 * `XDG_CONFIG_HOME` or `HAPI_ACCOUNT_CONFIG_SHARED` resolves different paths from
 * the same names and gives a confident wrong verdict. Recording the token state
 * in the boot write also means a starting daemon is never read as one that
 * predates #3731 (A3).
 *
 * Pure apart from the injected `realpath`; the caller passes env, uid and clock.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type {
  AmbientOnboardingTokenState,
  DaemonLocallyPersistedState,
} from "@/persistence";
import { beginEnvSeedTokenDisposition } from "./envSeedTokenDisposition";

type EnvLike = Record<string, string | undefined>;

/**
 * The absolute path of the tmux socket `tmux -L <socketName>` uses, computed the
 * way tmux 3.3a does with no server running: `realpath(${TMUX_TMPDIR:-/tmp})`
 * (symlinks resolved, a relative value against the cwd, an empty value as unset),
 * then `tmux-<uid>/<socketName>`. Measured against `#{socket_path}` in #4153.
 * (`resolveTmuxDir` in `staleSocketSweep.ts` builds the same directory without
 * the realpath step.) `undefined` when the uid is unavailable or the base
 * directory cannot be resolved; doctor then falls back to the socket name.
 */
export function computeTmuxSocketPath(input: {
  env: EnvLike;
  uid: number | undefined;
  socketName: string;
  realpath?: (path: string) => string;
}): string | undefined {
  if (input.uid === undefined) return undefined;
  try {
    const base = (input.realpath ?? realpathSync)(
      input.env.TMUX_TMPDIR || "/tmp"
    );
    return join(base, `tmux-${input.uid}`, input.socketName);
  } catch {
    return undefined;
  }
}

/** The boot-record fields this module owns. */
export type DaemonBootRecordFields = Pick<
  DaemonLocallyPersistedState,
  | "tmuxSessionName"
  | "tmuxSocketPath"
  | "accountConfigsDir"
  | "startedAt"
  | "ambientOnboardingToken"
  | "pendingSince"
>;

/**
 * Build the boot record and hold the onboarding token. Calls
 * {@link beginEnvSeedTokenDisposition}, so `holder.instanceOAuthToken` is set
 * here, before the control server can accept a spawn. `pendingSince` is set only
 * for `pending`; the later `released` / `retained` writes leave it in place,
 * because doctor escalates only while the state is `pending`.
 */
export function buildDaemonBootRecord(input: {
  env: EnvLike;
  holder: { instanceOAuthToken?: string };
  config: { tmuxSessionName: string; accountConfigsDir: string };
  uid: number | undefined;
  now?: number;
  realpath?: (path: string) => string;
}): {
  envSeedToken: string | undefined;
  initialTokenState: AmbientOnboardingTokenState;
  record: DaemonBootRecordFields;
} {
  const now = input.now ?? Date.now();
  const { envSeedToken, state } = beginEnvSeedTokenDisposition({
    env: input.env,
    holder: input.holder,
  });
  const tmuxSocketPath = computeTmuxSocketPath({
    env: input.env,
    uid: input.uid,
    socketName: input.config.tmuxSessionName,
    realpath: input.realpath,
  });
  return {
    envSeedToken,
    initialTokenState: state,
    record: {
      tmuxSessionName: input.config.tmuxSessionName,
      ...(tmuxSocketPath ? { tmuxSocketPath } : {}),
      accountConfigsDir: input.config.accountConfigsDir,
      startedAt: now,
      ambientOnboardingToken: state,
      ...(state === "pending" ? { pendingSince: now } : {}),
    },
  };
}
