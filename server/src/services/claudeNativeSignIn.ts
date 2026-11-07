// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";

/**
 * Drives the unmodified `claude auth login --claudeai` over plain pipes for the
 * tenant-VM paste sign-in (#6211). The binary performs the whole login: this
 * module only reads the authorize URL it prints and writes the pasted
 * `code#state` to its stdin once. The code is never persisted or logged, and
 * the credential the binary writes into `CLAUDE_CONFIG_DIR` is never read here.
 * The child's output is read for the URL and, after a submit, for its
 * `Login failed:` line, which only {@link classifyNativeSignInFailure} sees. Only
 * the last 4 KB after a submit is kept, inside this object until it is dropped,
 * and it is never logged or returned; the log gets the cause, the exit code, the
 * signal and, when present, an HTTP status or a Node error code.
 *
 * Measured against Claude Code 2.1.310 (run `scripts/check-claude-auth-login-contract-v1.sh`
 * by hand at a harness update, because nothing calls it yet): no PTY is needed; the URL is wrapped in
 * OSC-8 even on a pipe; a value with no `#` prints an error and the child stays
 * alive; a well-formed wrong code or wrong state spends the one attempt and
 * exits 1; closing stdin does NOT end the child; SIGTERM exits in about 0.2 s.
 * Every failed exchange exits 1 after one stderr line, `Login failed: <message>`
 * (#6275 S12): a refused code reads `Request failed with status code 400`, any
 * other HTTP error `Request failed with status code <n>`, a non-200 2xx answer
 * the binary's own `Token exchange failed (<n>): <text>`, and a network failure
 * Node's own text, such as `getaddrinfo EAI_AGAIN platform.claude.com`,
 * `connect ECONNREFUSED <addr>`, `read ECONNRESET`, `socket hang up` or
 * `timeout of 30000ms exceeded`. That script does not check these lines, so
 * re-measure them by hand at a harness update too.
 */

/** No authorize URL within this long means the sign-in is unavailable. */
export const NATIVE_SIGN_IN_URL_TIMEOUT_MS = 15_000;
/** How long a submit waits for the exchange; under the web client's 45 s timeout for this call. */
export const NATIVE_SIGN_IN_SUBMIT_WAIT_MS = 20_000;
/** SIGTERM to SIGKILL, because a closed stdin does not end the child. */
export const NATIVE_SIGN_IN_KILL_GRACE_MS = 5_000;
/** The hard limit on one child. The PKCE state lives in it, so a resume does not extend this. */
export const NATIVE_SIGN_IN_MAX_LIFETIME_MS = 15 * 60 * 1000;
/** The bound on output held while looking for the URL; the URL is in the first lines. */
const OUTPUT_BUFFER_MAX = 64 * 1024;
/** The tail of the output after a submit kept for the failure line, which comes last. */
const FAILURE_OUTPUT_MAX = 4 * 1024;
/**
 * How long the end waits for the output to drain after the child exits. The
 * failure line can arrive after `exit`, and a helper holding the pipes open
 * must not hold the end up for longer than this.
 */
const EXIT_OUTPUT_GRACE_MS = 300;
const PASTED_CODE_MAX_LENGTH = 2048;

/**
 * Shown when the pasted value cannot be an Anthropic authorization code
 * (#3452). A digits-only value is the shape of the 6-digit sign-in code
 * claude.com emails during login, which belongs on the claude.com page. The
 * authorization code Anthropic shows AFTER approval is a long opaque string
 * (conventionally `<code>#<state>`).
 */
export const NOT_AN_AUTHORIZATION_CODE_MSG =
  "That is not an Anthropic authorization code. It looks like the 6-digit " +
  "sign-in code claude.com emailed you — enter that on the claude.com sign-in " +
  "page, approve access, then paste the long authorization code Anthropic shows " +
  "afterwards (copy the whole thing, including the part after #).";

const AUTHORIZE_HOSTS = new Set([
  "claude.com",
  "claude.ai",
  "console.anthropic.com",
]);
// The binary wraps the URL in OSC-8, so BEL and ESC end a match.
const AUTHORIZE_URL_PATTERN =
  // eslint-disable-next-line no-control-regex
  /https:\/\/[^\s\x07\x1b]+\/oauth\/authorize\?[^\s\x07\x1b]+/;

const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TERM",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
]);

/**
 * The child's whole environment: an allowlist, so `CLAUDE_CODE_OAUTH_TOKEN`,
 * `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLI_API_TOKEN` and every
 * `HAPI_*` value can never reach it. The binary's own directory is put on PATH
 * when missing, because npm's `claude` is a `#!/usr/bin/env node` script and a
 * systemd unit's PATH may not include nvm's directory (same reason as #5871).
 */
export function buildNativeSignInEnv(
  configDir: string,
  claudePath: string,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (
      ENV_ALLOWLIST.has(key) ||
      key.startsWith("LC_") ||
      key.startsWith("XDG_")
    ) {
      out[key] = value;
    }
  }
  const binDir = dirname(claudePath);
  const parts = (out.PATH ?? "").split(":").filter(Boolean);
  if (!parts.includes(binDir)) out.PATH = [binDir, ...parts].join(":");
  out.CLAUDE_CONFIG_DIR = configDir;
  return out;
}

/** The first authorize URL on an accepted host, with its `state`; null when none is there yet. */
export function parseAuthorizeUrl(
  output: string
): { url: string; state: string } | null {
  const match = AUTHORIZE_URL_PATTERN.exec(output);
  if (!match) return null;
  try {
    const parsed = new URL(match[0]);
    const state = parsed.searchParams.get("state");
    if (!AUTHORIZE_HOSTS.has(parsed.hostname) || !state) return null;
    return { url: match[0], state };
  } catch {
    return null;
  }
}

export type PastedCodeCheck =
  | { ok: true; code: string }
  | { ok: false; error: string };

/**
 * The checks made before a paste reaches the child. A malformed value would
 * only print an error there, but a wrong `state` would spend the one attempt
 * (the binary does not reject it locally), and a stale code from an earlier
 * link is the likely way to hit that on a phone. A newline is refused because
 * the binary reads stdin line by line.
 */
export function validatePastedCode(
  raw: string,
  expectedState: string
): PastedCodeCheck {
  const code = raw.trim();
  if (/^\d+$/.test(code)) {
    return { ok: false, error: NOT_AN_AUTHORIZATION_CODE_MSG };
  }
  const invalid = (detail: string): PastedCodeCheck => ({
    ok: false,
    error: `That is not the whole authorization code: ${detail}. Copy the whole code from the page Anthropic shows after you click Authorize.`,
  });
  if (code.length > PASTED_CODE_MAX_LENGTH) return invalid("it is too long");
  if (/\s/.test(code)) return invalid("it has spaces or line breaks in it");
  const hash = code.indexOf("#");
  if (hash <= 0 || hash === code.length - 1) {
    return invalid("the part around the # is missing");
  }
  if (code.slice(hash + 1) !== expectedState) {
    return {
      ok: false,
      error:
        "That code came from a different sign-in link. Use the code from the latest link, or open a new one.",
    };
  }
  return { ok: true, code };
}

export type NativeSignInSubmitResult =
  | "signed_in"
  | "exchange_failed"
  | "signing_in";

/** The Node error codes a network failure line can name (#6275 S12). */
const NODE_NETWORK_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EPIPE",
  "EPROTO",
] as const;

/**
 * A network failure's code: one of the Node codes above, or `timeout` (the HTTP
 * client gave up), `hangup` (`socket hang up`, the connection dropped) or `tls`
 * (the secure connection could not be verified).
 */
export type NetworkErrorCode =
  | (typeof NODE_NETWORK_ERROR_CODES)[number]
  | "timeout"
  | "hangup"
  | "tls";

/**
 * Why a submitted code did not sign in (#6275 S12, S20):
 * - `code_refused`: the token endpoint answered 400, its answer for a code or
 *   state it does not accept (`invalid_grant`).
 * - `denied`: it answered 401 or 403, which is usually not about the code but
 *   something in front of Anthropic refusing this VM.
 * - `server`: any other HTTP status.
 * - `network`: no answer, with the reason in `errorCode`.
 * - `stopped`: this server ended the child (a cancel, a registration by the
 *   poll, the lifetime limit) and its output named no cause this module reads.
 * - `unknown`: anything else.
 */
export type NativeSignInFailure =
  | { cause: "code_refused" | "denied" | "server"; status: number }
  | { cause: "network"; errorCode: NetworkErrorCode }
  | { cause: "stopped" | "unknown" };

export type NativeSignInFailureCause = NativeSignInFailure["cause"];

/** The token endpoint's answer for a code it does not accept: invalid_grant is a 400. */
const REFUSED_CODE_STATUS = 400;
/** Statuses that refuse the request itself rather than the code (#6275 S20). */
const DENIED_STATUSES = new Set([401, 403]);
const LOGIN_FAILED_LINE = /Login failed: ([^\r\n]*)/g;
// The HTTP client's text, or the binary's own `Token exchange failed (<n>)`.
const HTTP_STATUS = /\bstatus code (\d{3})\b|\bfailed \((\d{3})\)/;
const NETWORK_ERROR_CODE = new RegExp(
  `\\b(${NODE_NETWORK_ERROR_CODES.join("|")})\\b`
);
const NETWORK_TIMEOUT = /\btimeout of \d+ms exceeded\b/i;
const NETWORK_HANGUP = /\bsocket hang up\b/i;
const NETWORK_TLS =
  /certificate|self[- ]signed|unable to verify|\bTLS\b|\bSSL\b/i;

/**
 * Reads the cause of a failed exchange from the child's output after the
 * submit, using only its last `Login failed:` line. Returns `unknown` when no
 * such line is there. Never returns any of the output itself.
 */
export function classifyNativeSignInFailure(
  output: string
): NativeSignInFailure {
  const lines = [...output.matchAll(LOGIN_FAILED_LINE)];
  const message = lines.at(-1)?.[1];
  if (message === undefined) return { cause: "unknown" };
  const status = HTTP_STATUS.exec(message);
  if (status) {
    const code = Number(status[1] ?? status[2]);
    const cause =
      code === REFUSED_CODE_STATUS
        ? "code_refused"
        : DENIED_STATUSES.has(code)
          ? "denied"
          : "server";
    return { cause, status: code };
  }
  const errorCode = NETWORK_ERROR_CODE.exec(message)?.[1] as
    | NetworkErrorCode
    | undefined;
  if (errorCode) return { cause: "network", errorCode };
  if (NETWORK_HANGUP.test(message)) {
    return { cause: "network", errorCode: "hangup" };
  }
  if (NETWORK_TIMEOUT.test(message)) {
    return { cause: "network", errorCode: "timeout" };
  }
  if (NETWORK_TLS.test(message)) return { cause: "network", errorCode: "tls" };
  return { cause: "unknown" };
}

/**
 * How the child ended: an exit code, the signal that ended it, or neither when
 * it never started (Node's `exit` names exactly one of the first two).
 */
export type NativeSignInEnd =
  | { code: number; signal: null }
  | { code: null; signal: NodeJS.Signals }
  | { code: null; signal: null };

/** A submitted code that did not sign in: why, and how the child ended. */
export interface FailedNativeSignIn {
  failure: NativeSignInFailure;
  end: NativeSignInEnd;
}

/** The end Node's `exit` event reports, as one {@link NativeSignInEnd}. */
function endFromExit(
  code: number | null,
  signal: NodeJS.Signals | null
): NativeSignInEnd {
  if (signal) return { code: null, signal };
  if (code !== null) return { code, signal: null };
  return { code: null, signal: null };
}

/** One running `claude auth login`. Build it with {@link startClaudeNativeSignIn}. */
export class ClaudeNativeSignIn {
  private submitted = false;
  /** How the child ended; null while it runs. */
  private childEnd: NativeSignInEnd | null = null;
  private hasExited = false;
  /** This server asked the child to end, so a signal exit is not a failure of its own. */
  private stopRequested = false;
  /** The tail of the output since the submit, read only by {@link failure}. */
  private outputAfterSubmit = "";
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lifetimeTimer: ReturnType<typeof setTimeout>;
  private readonly killOnProcessExit = () => this.signalChild("SIGKILL");
  private readonly killGraceMs: number;
  private readonly submitWaitMs: number;
  /** Resolves once the child has ended, whatever the cause. */
  readonly exited: Promise<void>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly authorizeUrl: string,
    readonly state: string,
    opts: {
      maxLifetimeMs: number;
      killGraceMs: number;
      submitWaitMs: number;
      /** The child's end as already observed by {@link startClaudeNativeSignIn}. */
      whenExited: Promise<NativeSignInEnd>;
    }
  ) {
    this.killGraceMs = opts.killGraceMs;
    this.submitWaitMs = opts.submitWaitMs;
    this.lifetimeTimer = setTimeout(() => this.kill(), opts.maxLifetimeMs);
    this.lifetimeTimer.unref?.();
    // A graceful stop outside systemd leaves no child; under systemd the
    // default control-group kill already covers it.
    process.once("exit", this.killOnProcessExit);
    this.exited = opts.whenExited.then(end => {
      this.childEnd = end;
      this.hasExited = true;
      clearTimeout(this.lifetimeTimer);
      if (this.killTimer) clearTimeout(this.killTimer);
      process.removeListener("exit", this.killOnProcessExit);
      this.logEnd();
    });
    // An EPIPE from a child that already left must not become an unhandled
    // stream error, and a broken pipe to a live child ends this attempt.
    child.stdin.on("error", () => this.terminate());
  }

  get alive(): boolean {
    return !this.hasExited;
  }

  /** True once a submitted code has failed: the flow is one-shot. */
  get exchangeFailed(): boolean {
    return this.failedExchange !== null;
  }

  /** Why a submitted code failed and how the child ended, once it has; else null. */
  get failedExchange(): FailedNativeSignIn | null {
    const failure = this.submitted ? this.failure : null;
    return failure && this.childEnd ? { failure, end: this.childEnd } : null;
  }

  /** True when the child ended with no code ever written to it, so its link is dead. */
  get endedUnsubmitted(): boolean {
    return this.hasExited && !this.submitted;
  }

  /**
   * Why the child ended without signing in, once it has ended (#6275 S12):
   * the cause its failure line gives, else `stopped` when this server ended
   * it, else `unknown`. Null while it runs or after an exit 0.
   */
  get failure(): NativeSignInFailure | null {
    if (!this.childEnd || this.childEnd.code === 0) return null;
    const found = classifyNativeSignInFailure(this.outputAfterSubmit);
    if (found.cause === "unknown" && this.stopRequested) {
      return { cause: "stopped" };
    }
    return found;
  }

  /** The exit code, or the signal, the child ended with; null while it runs. */
  get end(): NativeSignInEnd | null {
    return this.childEnd;
  }

  /** Output from the child. Only what follows a submit is kept, and only its tail. */
  noteOutput(text: string): void {
    if (!this.submitted || this.hasExited) return;
    this.outputAfterSubmit = (this.outputAfterSubmit + text).slice(
      -FAILURE_OUTPUT_MAX
    );
  }

  /**
   * One log line per end that matters: every end after a submit, and an end
   * before one that this server did not ask for. It carries the outcome, the
   * exit code, the signal and the parsed status or error code, never output.
   */
  private logEnd(): void {
    if (!this.submitted && this.stopRequested) return;
    const failure = this.failure;
    const outcome = !this.submitted
      ? "ended_unsubmitted"
      : (failure?.cause ?? "signed_in");
    const parts = [
      `outcome=${outcome}`,
      `exit=${this.childEnd?.code ?? "none"}`,
      `signal=${this.childEnd?.signal ?? "none"}`,
    ];
    if (failure && "status" in failure) parts.push(`status=${failure.status}`);
    if (failure && "errorCode" in failure) {
      parts.push(`error=${failure.errorCode}`);
    }
    const line = `[accounts] paste sign-in ended: ${parts.join(" ")}`;
    if (outcome === "signed_in") console.log(line);
    else console.warn(line);
  }

  /**
   * Writes `code` to the child once and waits for the exchange. A second call
   * writes nothing and reports where the first one stands.
   */
  async submit(code: string): Promise<NativeSignInSubmitResult> {
    if (!this.hasExited && !this.submitted) {
      this.submitted = true;
      try {
        this.child.stdin.write(`${code}\n`);
      } catch {
        this.terminate();
      }
    }
    if (!this.hasExited) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.exited,
        new Promise<void>(done => {
          timer = setTimeout(done, this.submitWaitMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    if (!this.hasExited) return "signing_in";
    return this.childEnd?.code === 0 ? "signed_in" : "exchange_failed";
  }

  /** SIGTERM, then SIGKILL after the grace period. Safe to call more than once. */
  kill(): void {
    if (this.hasExited) return;
    this.stopRequested = true;
    this.terminate();
  }

  /** The signal sequence, with no claim that this server chose to stop the child. */
  private terminate(): void {
    if (this.hasExited || this.killTimer) return;
    this.signalChild("SIGTERM");
    this.killTimer = setTimeout(
      () => this.signalChild("SIGKILL"),
      this.killGraceMs
    );
    this.killTimer.unref?.();
  }

  private signalChild(signal: NodeJS.Signals): void {
    if (this.hasExited) return;
    try {
      this.child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

export type NativeSignInStartResult =
  | { ok: true; signIn: ClaudeNativeSignIn }
  | {
      ok: false;
      code: "sign_in_unavailable";
      /** Why, for a log line. Never carries the child's output. */
      reason: "spawn_failed" | "no_authorize_url";
    };

export type StartClaudeNativeSignIn = (opts: {
  claudePath: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
  urlTimeoutMs?: number;
  maxLifetimeMs?: number;
  killGraceMs?: number;
  submitWaitMs?: number;
}) => Promise<NativeSignInStartResult>;

/**
 * Spawns the login and resolves once its authorize URL is known. `cwd` is the
 * config dir, so no project settings apply. Never detached: a plain child stays
 * in the server's cgroup, which systemd cleans up.
 */
export const startClaudeNativeSignIn: StartClaudeNativeSignIn = opts => {
  const urlTimeoutMs = opts.urlTimeoutMs ?? NATIVE_SIGN_IN_URL_TIMEOUT_MS;
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(opts.claudePath, ["auth", "login", "--claudeai"], {
        cwd: opts.configDir,
        env: buildNativeSignInEnv(opts.configDir, opts.claudePath, opts.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({
        ok: false,
        code: "sign_in_unavailable",
        reason: "spawn_failed",
      });
      return;
    }

    let settled = false;
    let spawnFailed = false;
    let buffer = "";
    let signIn: ClaudeNativeSignIn | undefined;
    const whenExited = new Promise<NativeSignInEnd>(done => {
      // `exit`, then `close` or a short grace, whichever comes first: the
      // failure line can still be in the pipe at `exit`, and a helper the
      // binary starts to open a browser can hold the pipes open after the
      // login itself has finished.
      // `done` ignores the second of the two.
      child.once("exit", (code, signal) => {
        const end = () => done(endFromExit(code, signal));
        setTimeout(end, EXIT_OUTPUT_GRACE_MS).unref?.();
        child.once("close", end);
      });
      // A child that failed to spawn emits `error` and no `exit`.
      child.once("error", () => {
        spawnFailed = true;
        done({ code: null, signal: null });
      });
    });

    const killForTimeout = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const urlTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killForTimeout();
      resolve({
        ok: false,
        code: "sign_in_unavailable",
        reason: "no_authorize_url",
      });
    }, urlTimeoutMs);
    urlTimer.unref?.();

    const onOutput = (chunk: Buffer) => {
      if (settled) {
        // After the URL only the driver reads it, and only after a submit.
        signIn?.noteOutput(chunk.toString("utf-8"));
        return;
      }
      buffer = (buffer + chunk.toString("utf-8")).slice(0, OUTPUT_BUFFER_MAX);
      const parsed = parseAuthorizeUrl(buffer);
      if (!parsed) return;
      settled = true;
      clearTimeout(urlTimer);
      buffer = "";
      signIn = new ClaudeNativeSignIn(child, parsed.url, parsed.state, {
        maxLifetimeMs: opts.maxLifetimeMs ?? NATIVE_SIGN_IN_MAX_LIFETIME_MS,
        killGraceMs: opts.killGraceMs ?? NATIVE_SIGN_IN_KILL_GRACE_MS,
        submitWaitMs: opts.submitWaitMs ?? NATIVE_SIGN_IN_SUBMIT_WAIT_MS,
        whenExited,
      });
      resolve({ ok: true, signIn });
    };
    // Both streams stay attached and drained, so a chatty child can never block
    // on a full pipe after the URL has been read.
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.stdin.on("error", () => {
      // Before the driver exists, a broken pipe has no attempt to end.
    });

    void whenExited.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(urlTimer);
      resolve({
        ok: false,
        code: "sign_in_unavailable",
        reason: spawnFailed ? "spawn_failed" : "no_authorize_url",
      });
    });
  });
};
