// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Server-side Codex (OpenAI) login driver (issue #3807, epic #3345, Tasks 2+3).
 *
 * Drives `codex login` for the in-app "Add OpenAI account" wizard. Two paths:
 *   - API-key    (`codex login --with-api-key`, key on STDIN) — synchronous.
 *   - device-auth (`codex login --device-auth`, link + one-time code)          —
 *     a SUPERVISED child that polls the device endpoint for up to 15 minutes,
 *     so it lives in a pending-token map (start / status / cancel) rather than
 *     on one request, mirroring `AccountLoginService`'s TTL map.
 *
 * 🔴 SECRETS / D12 = C (K-CODEX-HOME): every codex invocation runs with
 * `CODEX_HOME` = a PER-ACCOUNT dir under
 * `${XDG_CONFIG_HOME:-~/.config}/hapimatic/account-configs/<pk>/codex/` — NEVER
 * the host `~/.codex`. Upstream `login_with_api_key` REWRITES `auth.json`
 * (`tokens: None`) and the device flow clears existing auth first, so touching
 * the host home would destroy the machine's live ChatGPT login and flip every
 * codex session to per-token billing (the #3731 wrong-billing class). A guard
 * (`assertSafeCodexHome`) refuses the host home and `<HAPI_HOME>/codex-homes/`.
 * The API key travels stdin-only; a live `auth.json` / key value is never
 * opened, printed, logged or copied (the status line's masked key is DISCARDED
 * on parse). This module writes the same per-account layout + non-secret
 * `provider-account.json` sidecar the #3806 reader consumes and #3808 imports
 * (D3 = C). [ER 2026-09-19: 3807-2] [ER 2026-09-19: D12] [ER 2026-09-19: K-CODEX-HOME]
 */

/** Terminal states for the synchronous API-key path. */
export type ApiKeyLoginState = "ok" | "disabled" | "failed";
/** States for the supervised device-auth child (`pending` while polling). */
export type DeviceAuthState =
  | "pending"
  | "ok"
  | "disabled"
  | "unsupported"
  | "failed"
  | "cancelled";
/** Parsed `codex login status` vocabulary — the same as the #3806 reader's `mode`. */
export type CodexLoginStatusMode = "chatgpt" | "api-key" | "none";

export interface ApiKeyLoginResult {
  loginToken: string;
  state: ApiKeyLoginState;
}
export interface DeviceAuthResult {
  loginToken: string;
  state: DeviceAuthState;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
}
export interface DeviceAuthStatusResult {
  state: DeviceAuthState;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
}

export interface CodexLoginServiceOptions {
  /**
   * Machine-global account-configs parent (parent of `<pk>/codex/`). Default:
   * `${XDG_CONFIG_HOME:-<home>/.config}/hapimatic/account-configs` — BYTE-IDENTICAL
   * to the #3806 reader's default (`server/src/services/providerAuthState.ts`),
   * so a dir this driver writes is a dir that reader reads. K-CODEX-HOME.
   */
  accountConfigsDir?: string;
  /** Home dir. Default: os.homedir(). Tests inject a temp dir. */
  homeDir?: string;
  /** Host codex home to REFUSE. Default: $CODEX_HOME || <homeDir>/.codex. */
  hostCodexHome?: string;
  /** HAPI_HOME — to refuse `<HAPI_HOME>/codex-homes/` (the session-token dirs). */
  hapiHome?: string;
  /** Codex binary path override. Tests inject a fake shim; prod resolves it. */
  codexBin?: string;
  now?: () => number;
  /** Structured logger — NEVER receives a key/token. */
  log?: (msg: string) => void;
}

const API_KEY_LOGIN_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;
/** The device code "expires in 15 minutes" per codex's own prompt. */
const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;
/** How long `startDeviceAuth` waits for the child to print the link + code. */
const DEVICE_PROMPT_WAIT_MS = 20_000;

/** Fixed namespace for the uuid-v5 fallback (a non-UUID codex account id). */
const OPENAI_UUID_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strip ANSI SGR sequences — codex colorizes the device-auth prompt. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Deterministic uuid-v5 (SHA-1) for a non-UUID codex account id (rare). */
function uuidv5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(nsBytes)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10x
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
    16,
    20
  )}-${h.slice(20, 32)}`;
}

interface PendingDeviceAuth {
  loginToken: string;
  /** The staging codex home: `<accountConfigsDir>/.pending/<token>/codex`. */
  staging: string;
  /** The staging root to remove on cleanup: `<accountConfigsDir>/.pending/<token>`. */
  stagingRoot: string;
  label?: string;
  child: ChildProcess;
  output: string;
  state: DeviceAuthState;
  verificationUrl?: string;
  userCode?: string;
  expiresAt: string;
  ttlTimer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  /** Resolves when the link+code are parsed OR the child terminates. */
  promptSettled: Promise<void>;
  resolvePrompt: () => void;
}

export class CodexLoginService {
  private readonly accountConfigsDir: string;
  private readonly hostCodexHome: string;
  private readonly hapiHome: string | null;
  private readonly codexBinOverride?: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly pending = new Map<string, PendingDeviceAuth>();
  private resolvedBin: string | null = null;
  private binResolveAttempted = false;

  constructor(opts: CodexLoginServiceOptions = {}) {
    const home = opts.homeDir ?? homedir();
    this.accountConfigsDir =
      opts.accountConfigsDir ??
      join(
        process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
        "hapimatic",
        "account-configs"
      );
    this.hostCodexHome =
      opts.hostCodexHome ?? process.env.CODEX_HOME ?? join(home, ".codex");
    this.hapiHome = opts.hapiHome ?? process.env.HAPI_HOME ?? null;
    this.codexBinOverride = opts.codexBin;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** In-flight device-auth attempts (test/diagnostic visibility). */
  pendingCount(): number {
    return this.pending.size;
  }

  // ── Binary resolution ────────────────────────────────────────────────────
  // A systemd-launched server has a minimal PATH (harness/detection.ts KD-5),
  // and codex frequently lives under nvm — so `Bun.which` alone is not enough.
  // Resolution order: override → $CODEX_BIN → Bun.which → well-known paths →
  // nvm glob. The resolved path is logged ONCE (never a key).
  private resolveBin(): string | null {
    if (this.codexBinOverride) {
      return existsSync(this.codexBinOverride) ? this.codexBinOverride : null;
    }
    if (this.binResolveAttempted) return this.resolvedBin;
    this.binResolveAttempted = true;
    const envBin = process.env.CODEX_BIN;
    if (envBin && existsSync(envBin)) {
      this.resolvedBin = envBin;
    } else {
      const fromPath = typeof Bun !== "undefined" ? Bun.which("codex") : null;
      if (fromPath) {
        this.resolvedBin = fromPath;
      } else {
        const home = homedir();
        const candidates = [
          join(home, ".local", "bin", "codex"),
          join(home, ".npm-global", "bin", "codex"),
          "/usr/local/bin/codex",
          "/usr/bin/codex",
        ];
        for (const c of candidates) {
          if (existsSync(c)) {
            this.resolvedBin = c;
            break;
          }
        }
        if (!this.resolvedBin) {
          // nvm fallback: ~/.nvm/versions/node/<v>/bin/codex
          try {
            const nvmBase = join(home, ".nvm", "versions", "node");
            if (existsSync(nvmBase)) {
              for (const v of readdirSync(nvmBase)) {
                const c = join(nvmBase, v, "bin", "codex");
                if (existsSync(c)) {
                  this.resolvedBin = c;
                  break;
                }
              }
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
    this.log(
      this.resolvedBin
        ? `codexLoginService: resolved codex binary at ${this.resolvedBin}`
        : "codexLoginService: codex binary NOT found (login will report failed)"
    );
    return this.resolvedBin;
  }

  /** Controlled child env: inherit, override CODEX_HOME, clear any ambient key. */
  private childEnv(codexHome: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY; // never let an ambient key shadow the stdin key
    env.CODEX_HOME = codexHome;
    return env;
  }

  /**
   * Refuse any codexHome that is the host `~/.codex` or under
   * `<HAPI_HOME>/codex-homes/` (the per-session token dirs the RecoveryService
   * GC's). Throws — a bug that computes a bad target must fail loud, never write
   * the host home. K-CODEX-HOME.
   */
  private assertSafeCodexHome(codexHome: string): void {
    const target = resolve(codexHome);
    if (target === resolve(this.hostCodexHome)) {
      throw new Error(
        "codexLoginService: refusing to target the host ~/.codex"
      );
    }
    if (this.hapiHome) {
      const codexHomesRoot = resolve(join(this.hapiHome, "codex-homes"));
      if (
        target === codexHomesRoot ||
        target.startsWith(codexHomesRoot + "/")
      ) {
        throw new Error(
          "codexLoginService: refusing to target a session codex-homes dir"
        );
      }
    }
  }

  /** Spawn codex, optionally feed stdin, collect merged output + exit code. */
  private runCodex(
    args: string[],
    codexHome: string,
    opts: { input?: string; timeoutMs?: number } = {}
  ): Promise<{ code: number; output: string }> {
    const bin = this.resolveBin();
    if (!bin) return Promise.resolve({ code: -1, output: "codex not found" });
    return new Promise(resolvePromise => {
      let settled = false;
      const child = spawn(bin, args, { env: this.childEnv(codexHome) });
      let output = "";
      const onData = (d: Buffer) => {
        output += d.toString();
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, opts.timeoutMs);
      }
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolvePromise({ code, output });
      };
      child.on("error", () => finish(-1));
      child.on("close", code => finish(code ?? -1));
      try {
        if (opts.input !== undefined) child.stdin?.write(opts.input);
        child.stdin?.end();
      } catch {
        /* stdin may already be closed on a fast failure */
      }
    });
  }

  /** Parse `codex login status` output → mode. Discards the masked-key line. */
  private parseStatusMode(output: string): CodexLoginStatusMode {
    const clean = stripAnsi(output);
    if (/Logged in using ChatGPT/i.test(clean)) return "chatgpt";
    // "Logged in using an API key - sk-...***..." — map, DISCARD the masked key.
    if (/Logged in using an API key/i.test(clean)) return "api-key";
    return "none";
  }

  /** `CODEX_HOME=<home> codex login status` → mode (for post-flow verification). */
  async status(codexHome: string): Promise<CodexLoginStatusMode> {
    this.assertSafeCodexHome(codexHome);
    const { output } = await this.runCodex(["login", "status"], codexHome, {
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    return this.parseStatusMode(output);
  }

  private writeSidecar(
    pk: string,
    authMode: "api-key" | "chatgpt",
    label?: string
  ): void {
    const sidecar = join(this.accountConfigsDir, pk, "provider-account.json");
    writeFileSync(
      sidecar,
      JSON.stringify(
        {
          schema_version: 1,
          provider: "openai",
          accountUuid: pk,
          authMode,
          ...(label ? { label } : {}),
          createdAt: new Date(this.now()).toISOString(),
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  }

  // ── Task 2: API-key path (synchronous) ─────────────────────────────────────
  /**
   * `codex login --with-api-key` (key on stdin) into a fresh per-account dir.
   * Mints `<pk> = randomUUID()` (codex writes `tokens: None` for an API-key
   * login, so there is no account identity to key on), creates the dir 0700
   * FIRST (codex errors "CODEX_HOME ... does not exist" otherwise — verified),
   * runs the login, and on `ok` writes the non-secret sidecar; on `disabled` /
   * `failed` removes the dir. The key is fed on stdin ONLY (the argv `--api-key`
   * form is rejected at 0.147.0) and is never logged. [ER 2026-09-19: 3807-2]
   */
  async loginWithApiKey(args: {
    key: string;
    label?: string;
  }): Promise<ApiKeyLoginResult> {
    const loginToken = randomUUID();
    const pk = randomUUID();
    const pkDir = join(this.accountConfigsDir, pk);
    const codexHome = join(pkDir, "codex");
    this.assertSafeCodexHome(codexHome);
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const { code, output } = await this.runCodex(
      ["login", "--with-api-key"],
      codexHome,
      { input: args.key, timeoutMs: API_KEY_LOGIN_TIMEOUT_MS }
    );
    if (code === 0) {
      this.writeSidecar(pk, "api-key", args.label);
      this.log(`codexLoginService: api-key login ok (pk redacted)`);
      return { loginToken, state: "ok" };
    }
    // Roll back the dir on any non-success — leave no orphan (V5).
    this.safeRm(pkDir);
    const state: ApiKeyLoginState = /disabl/i.test(stripAnsi(output))
      ? "disabled"
      : "failed";
    this.log(`codexLoginService: api-key login ${state} (exit ${code})`);
    return { loginToken, state };
  }

  // ── Task 3: device-auth path (supervised child) ────────────────────────────
  /**
   * Start `codex login --device-auth` under a staging dir. Returns the
   * verification URL + one-time code once codex prints them (a network
   * round-trip; we wait up to DEVICE_PROMPT_WAIT_MS), or a terminal state if the
   * child died first (disabled / unsupported / failed). The child keeps polling;
   * the caller polls `status(loginToken)` and can `cancel(loginToken)`. On
   * success the staging dir is atomically renamed to
   * `<accountConfigsDir>/<pk>/codex/` where `<pk>` = codex's stable account id.
   */
  async startDeviceAuth(args: { label?: string }): Promise<DeviceAuthResult> {
    const loginToken = randomUUID();
    const stagingRoot = join(this.accountConfigsDir, ".pending", loginToken);
    const staging = join(stagingRoot, "codex");
    this.assertSafeCodexHome(staging);
    mkdirSync(staging, { recursive: true, mode: 0o700 });

    const bin = this.resolveBin();
    const expiresAt = new Date(this.now() + DEVICE_AUTH_TTL_MS).toISOString();
    if (!bin) {
      this.safeRm(stagingRoot);
      return { loginToken, state: "failed" };
    }

    // `detached: true` makes the child a process-GROUP leader so a cancel can
    // kill the whole tree — `codex` is a node wrapper that forks the real codex
    // binary, and a plain SIGKILL to the wrapper would orphan that grandchild
    // (it would keep polling OpenAI until the device code expires). Group-kill
    // via `process.kill(-pid)` reaps both (see `killChildTree`).
    const child = spawn(bin, ["login", "--device-auth"], {
      env: this.childEnv(staging),
      detached: true,
    });

    let resolvePrompt!: () => void;
    const promptSettled = new Promise<void>(r => {
      resolvePrompt = r;
    });
    const entry: PendingDeviceAuth = {
      loginToken,
      staging,
      stagingRoot,
      label: args.label,
      child,
      output: "",
      state: "pending",
      expiresAt,
      cancelled: false,
      promptSettled,
      resolvePrompt,
      ttlTimer: setTimeout(() => {
        this.finalizeExpiry(loginToken);
      }, DEVICE_AUTH_TTL_MS),
    };
    this.pending.set(loginToken, entry);

    const onData = (d: Buffer) => {
      entry.output += d.toString();
      this.tryParsePrompt(entry);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => {
      if (entry.state === "pending") entry.state = "failed";
      this.safeRm(entry.stagingRoot);
      clearTimeout(entry.ttlTimer);
      entry.resolvePrompt();
    });
    child.on("close", code => {
      // The handler guards its own body; this `.catch` is the last line so no
      // rejection can ever escape as an unhandled one — the server installs no
      // `unhandledRejection` handler and Bun exits the process on one (#4051).
      this.onDeviceChildClose(entry, code ?? -1).catch(err => {
        try {
          this.failDeviceAuth(entry, "close-handler", err);
        } catch {
          /* never rethrow out of an event listener */
        }
      });
    });

    // Wait for the prompt (or a fast terminal exit), bounded.
    await Promise.race([
      promptSettled,
      new Promise<void>(r => setTimeout(r, DEVICE_PROMPT_WAIT_MS)),
    ]);

    return {
      loginToken,
      state: entry.state,
      ...(entry.verificationUrl
        ? { verificationUrl: entry.verificationUrl }
        : {}),
      ...(entry.userCode ? { userCode: entry.userCode } : {}),
      expiresAt: entry.expiresAt,
    };
  }

  /** Parse the (ANSI-stripped) device-auth prompt for the URL + one-time code. */
  private tryParsePrompt(entry: PendingDeviceAuth): void {
    if (entry.verificationUrl && entry.userCode) return;
    const clean = stripAnsi(entry.output);
    if (!entry.verificationUrl) {
      const url = clean.match(/https?:\/\/[^\s]+/);
      if (url) entry.verificationUrl = url[0];
    }
    if (!entry.userCode) {
      const code = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/);
      if (code) entry.userCode = code[0];
    }
    if (entry.verificationUrl && entry.userCode) entry.resolvePrompt();
  }

  /**
   * Finalize a device-auth attempt once its child exits. Every path ends in
   * exactly one terminal state and NEVER throws (#4051): the body is guarded,
   * and `entry.cancelled` is re-checked after the `status()` await because a
   * cancel (which removes the staging dir) can land during that ~10 s window.
   */
  private async onDeviceChildClose(
    entry: PendingDeviceAuth,
    code: number
  ): Promise<void> {
    clearTimeout(entry.ttlTimer);
    // Set only after the staging dir has been moved into place, so a failure
    // AFTER the rename (sidecar write) can roll the half-added account back.
    let movedTarget: string | null = null;
    try {
      if (entry.cancelled) {
        this.finishCancelled(entry);
        return;
      }
      if (code === 0) {
        const mode = await this.status(entry.staging);
        // A cancel during the status await already removed the staging dir —
        // finish as cancelled; never attempt the mkdir/rename/sidecar sequence.
        if (entry.cancelled) {
          this.finishCancelled(entry);
          return;
        }
        if (mode === "chatgpt") {
          const pk = this.deriveChatgptPk(entry.staging);
          const pkDir = join(this.accountConfigsDir, pk);
          const target = join(pkDir, "codex");
          if (existsSync(target)) {
            // Already logged in on this machine — do not clobber (D4 stable PK).
            entry.state = "failed";
            this.log("codexLoginService: device-auth account already added");
            this.safeRm(entry.stagingRoot);
          } else {
            mkdirSync(pkDir, { recursive: true, mode: 0o700 });
            // Atomic (same filesystem). Throws if a concurrent completion
            // (e.g. another server process sharing account-configs) won the
            // target first — the catch below turns that into `failed`.
            renameSync(entry.staging, target);
            movedTarget = target;
            this.writeSidecar(pk, "chatgpt", entry.label);
            this.safeRm(entry.stagingRoot); // remove the now-empty .pending/<token>
            entry.state = "ok";
            this.log("codexLoginService: device-auth login ok (pk redacted)");
          }
        } else {
          entry.state = "failed";
          this.safeRm(entry.stagingRoot);
        }
      } else {
        const clean = stripAnsi(entry.output);
        if (/disabl/i.test(clean)) entry.state = "disabled";
        else if (/not\s?found|unsupported|not supported|workspace/i.test(clean))
          entry.state = "unsupported";
        else entry.state = "failed";
        this.log(
          `codexLoginService: device-auth ${entry.state} (exit ${code})`
        );
        this.safeRm(entry.stagingRoot);
      }
    } catch (err) {
      // A sidecar-less account dir would read as "already added" on every
      // retry — remove only the codex dir this attempt moved in.
      if (movedTarget) this.safeRm(movedTarget);
      if (entry.cancelled) this.finishCancelled(entry);
      else this.failDeviceAuth(entry, "finalize", err);
    } finally {
      entry.resolvePrompt();
    }
  }

  private finishCancelled(entry: PendingDeviceAuth): void {
    entry.state = "cancelled";
    this.safeRm(entry.stagingRoot);
  }

  /**
   * Terminal `failed` with a logged reason. Logs only the error CODE/name —
   * fs error messages carry the account-configs path (the pk), which this
   * module never logs.
   */
  private failDeviceAuth(
    entry: PendingDeviceAuth,
    where: string,
    err: unknown
  ): void {
    const reason =
      err instanceof Error
        ? ((err as NodeJS.ErrnoException).code ?? err.name)
        : typeof err;
    entry.state = "failed";
    this.log(`codexLoginService: device-auth ${where} failed (${reason})`);
    this.safeRm(entry.stagingRoot);
    entry.resolvePrompt();
  }

  private deriveChatgptPk(codexHome: string): string {
    try {
      const auth = JSON.parse(
        readFileSync(join(codexHome, "auth.json"), "utf8")
      ) as { tokens?: { account_id?: string } | null };
      const accountId = auth?.tokens?.account_id;
      if (typeof accountId === "string" && accountId.length > 0) {
        return UUID_RE.test(accountId)
          ? accountId
          : uuidv5(`openai:${accountId}`, OPENAI_UUID_NS);
      }
    } catch {
      /* fall through */
    }
    return randomUUID();
  }

  /** Poll a device-auth attempt's current state. */
  deviceAuthStatus(loginToken: string): DeviceAuthStatusResult {
    const entry = this.pending.get(loginToken);
    if (!entry) return { state: "failed" };
    return {
      state: entry.state,
      ...(entry.verificationUrl
        ? { verificationUrl: entry.verificationUrl }
        : {}),
      ...(entry.userCode ? { userCode: entry.userCode } : {}),
      expiresAt: entry.expiresAt,
    };
  }

  /** Cancel a device-auth attempt: kill the child, remove the staging dir (V5). */
  cancelDeviceAuth(loginToken: string): { cancelled: boolean } {
    const entry = this.pending.get(loginToken);
    if (!entry) return { cancelled: false };
    entry.cancelled = true;
    clearTimeout(entry.ttlTimer);
    this.killChildTree(entry.child);
    // The close handler sets state=cancelled + removes staging; do it eagerly
    // too so a caller reading immediately after cancel sees the terminal state.
    entry.state = "cancelled";
    this.safeRm(entry.stagingRoot);
    return { cancelled: true };
  }

  private finalizeExpiry(loginToken: string): void {
    const entry = this.pending.get(loginToken);
    if (!entry || entry.state !== "pending") return;
    entry.cancelled = true;
    this.killChildTree(entry.child);
    entry.state = "failed";
    this.safeRm(entry.stagingRoot);
  }

  /**
   * SIGKILL the child AND its descendants. The device-auth child is a detached
   * process-group leader, so `process.kill(-pid)` signals the whole group (the
   * node wrapper + the forked codex binary); fall back to a direct kill if the
   * group signal is unavailable (already-dead pid, platform quirk).
   */
  private killChildTree(child: ChildProcess): void {
    const pid = child.pid;
    try {
      if (pid) {
        process.kill(-pid, "SIGKILL");
        return;
      }
    } catch {
      /* group gone or unsupported — fall through to a direct kill */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }

  private safeRm(path: string): void {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
