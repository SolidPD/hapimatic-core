// SPDX-License-Identifier: AGPL-3.0-only
/**
 * TEST-ONLY child process for Case P of `tmuxEnvScrub.integration.test.ts`
 * (issue #5994). Nothing imports it: the test starts it with `bun` from `cli/`.
 *
 * It runs the REAL `claudeTmuxRemote()` under the REAL `createRunnerLifecycle`
 * process handlers, so the test can end a launch attempt the ways a wrapper
 * ends: an archive (`cleanupAndExit`, which the killSession RPC handler calls),
 * SIGTERM, or SIGKILL. That needs its own process, because a vitest worker must
 * never call `process.exit` or receive those signals.
 *
 * argv: `<hapiSessionId> <fake token>`. Once the attempt has written its env
 * file, this prints `ENVFILE <path>` and idles. A `cleanupAndExit` line on stdin
 * calls `lifecycle.cleanupAndExit()`. The test sets only HOME, PATH, TERM,
 * HAPI_HOME, HAPI_TMUX_REMOTE_SESSION_NAME and HAPI_CLAUDE_PATH, all scratch, so
 * this reaches no live socket, config or token.
 */
import { createInterface } from "node:readline";
import type { ApiSessionClient } from "@/api/apiSession";
import { createRunnerLifecycle } from "@/agent/runnerLifecycle";
import { claudeTmuxRemote } from "./claudeTmuxRemote";

const [hapiSessionId, fakeToken] = process.argv.slice(2);
if (!hapiSessionId || !fakeToken) {
  process.stderr.write(
    "usage: bun src/claude/tmuxEnvFileExit.testing.ts <hapiSessionId> <token>\n"
  );
  process.exit(2);
}

// The calls cleanupAndExit makes on its session, and nothing more.
const session = {
  updateMetadata: (): void => undefined,
  sendSessionDeath: (): void => undefined,
  flush: async (): Promise<void> => undefined,
  close: async (): Promise<void> => undefined,
  getSessionSnapshot: (): { id: string } => ({ id: hapiSessionId }),
} as unknown as ApiSessionClient;

const lifecycle = createRunnerLifecycle({ session, logTag: "tmuxEnvFileExit" });
lifecycle.registerProcessHandlers();

const home = process.env.HOME ?? "/tmp";
await claudeTmuxRemote({
  path: home,
  sessionId: null,
  abort: new AbortController().signal,
  hapiSessionId,
  claudeEnvVars: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken },
  claudeArgs: ["--safe-mode"],
  hookSettingsPath: `${home}/hooks.json`,
  onExit: (): void => undefined,
});
process.stdout.write(`ENVFILE /tmp/hapi-tmux-env-${hapiSessionId}\n`);

createInterface({ input: process.stdin }).on("line", line => {
  if (line.trim() === "cleanupAndExit") void lifecycle.cleanupAndExit();
});
