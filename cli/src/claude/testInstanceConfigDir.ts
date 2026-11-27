// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6980: a Claude session on a TEST instance never runs on the node's own login.
 *
 * A `claude` child with no account folder starts with no `CLAUDE_CONFIG_DIR`, so native
 * Claude Code uses the host `~/.claude` and `~/.claude.json`: it opens the node's real
 * login, and with an expired token it takes the login's refresh lock. So on kind `test`:
 *
 * - a session with a credential (an API key, a token, an account) and no account folder
 *   runs on ONE folder per instance, `<HAPI_HOME>/claude-config`, which holds no login.
 *   One, not one per session, because resume, fork and reconnect need the parent's
 *   transcript;
 * - a session with no credential Hapimatic can see is refused before launch: it would only
 *   print "Not logged in", and a `/login` typed there would lock the folder;
 * - the two env builders refuse any Claude child whose config folder is neither the
 *   instance's nor an account's ({@link assertTestInstanceChildEnv});
 * - the wrapper's own reads and writes follow the same folder.
 *
 * Kinds `real` and `dev` run exactly the code they ran before: every export here is then
 * the old expression or does nothing.
 *
 * The folder is not under `<HAPI_HOME>/account-configs/`, whose presence makes the test
 * store read as inherited, and is threaded through the launch options rather than set in
 * `process.env`. Docs: `docs/internal/architecture/worktree-lifecycle.md` "Logins on a
 * test instance (#6756)".
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  INSTANCE_KIND_FILE,
  describeInstanceKind,
} from "@hapi/protocol/instanceKind";
import { UUID_REGEX } from "@/accounts/accountStore";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import {
  isTestInstanceProcess,
  processInstanceKind,
} from "@/utils/testInstanceProcess";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getProjectPath } from "./utils/path";
import { resumeSessionIdFromArgs, stripOneTimeFlags } from "./utils/resumeArgs";

/** Enough for a terminal session to start past onboarding; nothing else. */
const SEED_CLAUDE_JSON = JSON.stringify({
  hasCompletedOnboarding: true,
  lastOnboardingVersion: "99.0.0",
});

/**
 * Without this key a pty or tmux session started in bypass mode stops on a warning no one
 * can see (measured, Claude Code 2.1.321).
 */
const SEED_SETTINGS = JSON.stringify({
  skipDangerousModePermissionPrompt: true,
});

/** Every refusal here; the message is what the session, or the editor, is shown. */
export class TestInstanceClaudeConfigError extends Error {
  constructor(reason: string) {
    super(`Session cannot start: ${reason}`);
    this.name = "TestInstanceClaudeConfigError";
  }
}

/** The part of a session a message goes through. */
interface SessionMessageSink {
  client: {
    sendSessionEvent(event: { type: "message"; message: string }): void;
  };
}

/** This instance's kind, in words: `kind=test (signals: port, home-name)`. */
function kindText(): string {
  return describeInstanceKind(processInstanceKind());
}

/** How a real install that reads as a test instance is put right. */
function realInstallText(): string {
  return `If this is a real install, write "real" on the first line of ${join(configuration.happyHomeDir, INSTANCE_KIND_FILE)} and restart it from outside its own sessions, which carry HAPI_INSTANCE_KIND=test (that lifts only the port and home-shape signals).`;
}

/** Best-effort: a message that cannot be posted never changes a launch. */
function post(session: SessionMessageSink, message: string): void {
  try {
    session.client.sendSessionEvent({ type: "message", message });
  } catch (error) {
    logger.debug("[INSTANCE] session message not posted (#6980)", error);
  }
}

/**
 * The instance's own Claude config folder on kind `test`, else `null`. Absolute; does no
 * I/O, so it may name a folder that does not exist yet.
 */
export function testInstanceConfigDir(): string | null {
  return isTestInstanceProcess()
    ? resolve(configuration.happyHomeDir, "claude-config")
    : null;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** `path`'s realpath, or `path` itself when there is nothing there yet. */
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Refuse a path at or under the host's `~/.claude`, however either is linked. */
function refuseInsideHostClaude(dir: string, path: string): void {
  const hosts = [
    join(homedir(), ".claude"),
    join(realpathOr(homedir()), ".claude"),
    realpathOr(join(homedir(), ".claude")),
  ];
  if (hosts.some(host => path === host || path.startsWith(host + sep))) {
    throw new TestInstanceClaudeConfigError(
      `the test instance's Claude config folder ${dir} is inside the node's own ~/.claude (#6980).`
    );
  }
}

/** Make `dir`, or accept it: a real folder, this user's, with no group or other bits. */
function makePrivateFolder(dir: string): void {
  if (lstatOrNull(dir) === null) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // lstat, so a link to a folder is not a folder here.
  const found = lstatSync(dir);
  if (!found.isDirectory()) {
    throw new TestInstanceClaudeConfigError(
      `the test instance's Claude config folder ${dir} is not a plain folder (#6980).`
    );
  }
  // Windows has neither owner nor mode bits to check.
  if (typeof process.getuid !== "function") return;
  if (found.uid !== process.getuid()) {
    throw new TestInstanceClaudeConfigError(
      `the test instance's Claude config folder ${dir} belongs to another user (#6980).`
    );
  }
  if ((found.mode & 0o777) !== 0o700) {
    chmodSync(dir, 0o700);
    if ((lstatSync(dir).mode & 0o777) !== 0o700) {
      throw new TestInstanceClaudeConfigError(
        `the test instance's Claude config folder ${dir} cannot be made private (#6980).`
      );
    }
  }
}

/** A name in the folder is absent or a regular file: a link could lead back to the host. */
function regularFileOrAbsent(file: string): boolean {
  const found = lstatOrNull(file);
  if (found !== null && !found.isFile()) {
    throw new TestInstanceClaudeConfigError(
      `${file} is not a regular file, so this test instance's Claude config folder cannot be used (#6980). Nothing was changed.`
    );
  }
  return found !== null;
}

/**
 * The folder holds no Claude login. MCP sign-ins share the file, so the file alone is
 * fine. A login is never deleted here: that is the operator's decision.
 */
function refuseLogin(dir: string): void {
  const file = join(dir, ".credentials.json");
  if (!regularFileOrAbsent(file)) return;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // Judged below. Never the parser's own message: it can quote the file (#5676).
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TestInstanceClaudeConfigError(
      `${file} cannot be read as JSON, so it may hold a Claude login (#6980). Move it away to start sessions here; nothing was deleted.`
    );
  }
  if ((parsed as { claudeAiOauth?: unknown }).claudeAiOauth != null) {
    throw new TestInstanceClaudeConfigError(
      `${file} holds a Claude login, and this test instance's sessions share that folder (#6980). Move it away to start sessions here; nothing was deleted.`
    );
  }
}

/** Create `file` with `content`, 0600; an existing file is left as it is. */
function seed(file: string, content: string): void {
  if (regularFileOrAbsent(file)) return;
  try {
    writeFileSync(file, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // Another wrapper seeded it first.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * Make the instance's Claude config folder ready and return it (R3), or throw
 * {@link TestInstanceClaudeConfigError} naming what is wrong. Deletes nothing.
 */
export function prepareTestInstanceConfigDir(): string {
  const dir = testInstanceConfigDir();
  if (dir === null) {
    throw new TestInstanceClaudeConfigError(
      "only a test instance has its own Claude config folder (#6980)."
    );
  }
  try {
    // Before anything is made, then again on what is there.
    refuseInsideHostClaude(dir, dir);
    refuseInsideHostClaude(dir, join(realpathOr(dirname(dir)), basename(dir)));
    makePrivateFolder(dir);
    refuseInsideHostClaude(dir, realpathSync(dir));
    refuseLogin(dir);
    seed(join(dir, ".claude.json"), SEED_CLAUDE_JSON);
    seed(join(dir, "settings.json"), SEED_SETTINGS);
  } catch (error) {
    if (error instanceof TestInstanceClaudeConfigError) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    throw new TestInstanceClaudeConfigError(
      `the test instance's Claude config folder ${dir} cannot be used (${code}) (#6980).`
    );
  }
  return dir;
}

let isolationNoticePosted = false;

/** R8: one session message per wrapper process, however often it relaunches. */
function postIsolationNoticeOnce(session: SessionMessageSink): void {
  if (isolationNoticePosted) return;
  isolationNoticePosted = true;
  post(
    session,
    `This is a test instance (${kindText()}), so this session runs on its own Claude config folder: no skills, hooks, memory or user MCP servers from this node's ~/.claude, and not the node's login (#6980). ${realInstallText()}`
  );
}

function noCredentialError(): TestInstanceClaudeConfigError {
  return new TestInstanceClaudeConfigError(
    `it has no credential, and on a test instance (${kindText()}) Claude never runs on this node's own login (#6980). Add an account or an API key in Provider Accounts and start the session on it. ${realInstallText()}`
  );
}

/** One log line per refusal, then the throw. */
function refuse(error: unknown): never {
  logger.warn(
    `[INSTANCE] launch refused: ${error instanceof Error ? error.message : String(error)}`
  );
  throw error;
}

/**
 * R2, for a session kind that never has a credential of its own (`hapi acp`): refused on
 * kind `test`, unchanged on `real` and `dev`.
 */
export function refuseWithoutCredential(): void {
  if (isTestInstanceProcess()) refuse(noCredentialError());
}

/**
 * Issue #1551: merge `CLAUDE_CONFIG_DIR` into a launcher's `claudeEnvVars`. Pure
 * — returns a new object (or the original `base` when `configDir` is null), never
 * mutating `base`. Mirrors `withAccountToken`; `CLAUDE_CONFIG_DIR` is the
 * Path-A binding for non-host accounts (native Claude Code reads + rotates the
 * isolated `.credentials.json`). `CLAUDE_CONFIG_DIR` is NOT in
 * `SDK_SIGNAL_ENV_VARS`, so it passes the launcher billing scrub and preserves
 * subscription billing.
 */
export function withAccountConfigDir(
  base: Record<string, string> | undefined,
  configDir: string | null
): Record<string, string> | undefined {
  if (!configDir) return base;
  return { ...(base ?? {}), CLAUDE_CONFIG_DIR: configDir };
}

/**
 * The explicit env set of a session's Claude child: the one composition every launcher
 * uses. Kinds `real` and `dev` get {@link withAccountConfigDir}. On kind `test` a
 * session with no account folder gets the instance's own folder (one log line per launch,
 * one session message per process), or is refused: no credential, or a folder that cannot
 * be used.
 *
 * `postRefusal` posts the refusal to the session, for the sdk launcher, where nothing
 * catches it. The pty, tmux and local launchers' own catch posts it.
 */
export function resolveSessionChildEnv(input: {
  session: SessionMessageSink;
  base: Record<string, string> | undefined;
  accountConfigDir: string | null;
  hasCredential: boolean;
  postRefusal?: boolean;
}): Record<string, string> | undefined {
  const { session, base, accountConfigDir } = input;
  if (accountConfigDir || !isTestInstanceProcess()) {
    return withAccountConfigDir(base, accountConfigDir);
  }
  try {
    if (!input.hasCredential) throw noCredentialError();
    const dir = prepareTestInstanceConfigDir();
    // Debug, not info: info prints on the terminal Claude is about to own.
    logger.debug(
      `[INSTANCE] this session runs Claude on its own config folder (#6980): ${dir}, ${kindText()}`
    );
    postIsolationNoticeOnce(session);
    return withAccountConfigDir(base, dir);
  } catch (error) {
    if (input.postRefusal && error instanceof Error) {
      post(session, error.message);
    }
    return refuse(error);
  }
}

/**
 * R4, the guard in the two env builders: on kind `test` a Claude child's
 * `CLAUDE_CONFIG_DIR` is the instance's folder or exactly `<accountConfigsDir>/<uuid>`
 * (the rule of `machineRotator.ts` `uuidFromConfigDir`). Anything else, or none, throws.
 */
export function assertTestInstanceChildEnv(env: Record<string, unknown>): void {
  const own = testInstanceConfigDir();
  if (own === null) return;
  const value = env.CLAUDE_CONFIG_DIR;
  if (typeof value === "string" && isAbsolute(value)) {
    const dir = resolve(value);
    if (dir === own) return;
    if (
      dirname(dir) === resolve(configuration.accountConfigsDir) &&
      UUID_REGEX.test(basename(dir))
    ) {
      return;
    }
  }
  throw new TestInstanceClaudeConfigError(
    `on a test instance Claude starts only with CLAUDE_CONFIG_DIR set to the instance's own folder or an account's folder, not ${typeof value === "string" && value !== "" ? value : "unset"} (#6980).`
  );
}

/**
 * Where a session's transcripts are, for the wrapper's own path lookups: its child's
 * config folder on kind `test`, else `undefined` (today's lookup).
 */
export function sessionConfigDirOverride(
  claudeEnvVars: Record<string, string> | undefined
): string | undefined {
  return isTestInstanceProcess() ? claudeEnvVars?.CLAUDE_CONFIG_DIR : undefined;
}

/**
 * The config folder whose transcripts a session's scanner and background-agent tracker
 * watch: its account's, else the instance's on kind `test`, else `undefined` (the default
 * lookup, as before).
 */
export function transcriptConfigDir(
  accountConfigDir: string | null
): string | undefined {
  return accountConfigDir ?? testInstanceConfigDir() ?? undefined;
}

/**
 * The wrapper's default Claude config folder: the instance's on kind `test`. While that
 * one is a link, or holds a config file as one, a name beside it, which at most the exit
 * log makes. Asked each time, so it cannot go stale.
 */
export function wrapperClaudeDir(): string {
  const dir = testInstanceConfigDir();
  if (dir === null) return join(homedir(), ".claude");
  try {
    if (lstatOrNull(dir)?.isDirectory() ?? true) {
      regularFileOrAbsent(join(dir, ".claude.json"));
      regularFileOrAbsent(join(dir, "settings.json"));
      return dir;
    }
  } catch {
    // A link, or nothing that can be read.
  }
  return `${dir}.refused`;
}

/** The wrapper's default `.claude.json`: in {@link wrapperClaudeDir} on kind `test`. */
export function wrapperClaudeJson(): string {
  return testInstanceConfigDir() === null
    ? join(homedir(), ".claude.json")
    : join(wrapperClaudeDir(), ".claude.json");
}

/**
 * R6: `args` without the one-time flags when the `--resume` id has no usable transcript
 * for `cwd` in the config folder `dir`, and the id that was dropped. `--fork-session`
 * goes with it: there is nothing left to fork.
 */
export function dropUnresumableResume(
  args: string[] | undefined,
  cwd: string,
  dir: string
): { args: string[] | undefined; dropped: string | null } {
  const id = resumeSessionIdFromArgs(args);
  if (id === null || claudeCheckSession(id, cwd, dir)) {
    return { args, dropped: null };
  }
  return { args: stripOneTimeFlags(args), dropped: id };
}

/** The conversation each session was last told starts fresh. */
const toldFresh = new WeakMap<object, string>();

/**
 * R6, for each launcher, once it knows the session's account folder and before its
 * scanner reads `claudeArgs`. A launch drops a `--resume` its folder cannot serve: on the
 * instance's folder any other, and on an account folder one that only the instance's
 * folder holds (Claude ends at once on an id it cannot find; what no folder of this
 * instance holds is as before). The launchers start the running conversation fresh when
 * its id is not in the folder. Either way one session message says so, once for each
 * conversation. Kinds `real` and `dev` keep theirs.
 */
export function dropForeignResume(
  session: SessionMessageSink & {
    path: string;
    sessionId?: string | null;
    claudeArgs?: string[];
  },
  accountConfigDir: string | null
): void {
  const own = testInstanceConfigDir();
  if (own === null) return;
  const dir = accountConfigDir ?? own;
  const { path, sessionId } = session;
  const { args, dropped } = dropUnresumableResume(
    session.claudeArgs,
    path,
    dir
  );
  let lost: string | null = null;
  if (
    dropped !== null &&
    // The daemon's own test (`has-claude-conversation`): the file is there.
    (dir === own ||
      existsSync(join(getProjectPath(path, own), `${dropped}.jsonl`)))
  ) {
    session.claudeArgs = args;
    lost = dropped;
    logger.debug(
      `[INSTANCE] dropped --resume ${dropped}: not in ${dir} (#6980)`
    );
  } else if (
    sessionId &&
    resumeSessionIdFromArgs(session.claudeArgs) === null &&
    !claudeCheckSession(sessionId, path, dir)
  ) {
    lost = sessionId;
  }
  if (lost === null || toldFresh.get(session) === lost) return;
  toldFresh.set(session, lost);
  post(
    session,
    `This conversation starts fresh: ${dir === own ? "this test instance's own" : "the account's"} Claude config folder holds no transcript of ${lost} (#6980).`
  );
}
