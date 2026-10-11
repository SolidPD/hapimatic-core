// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Message-layer hook stage (issue #3124, epic #3117 Sub I — enforcement-ladder
 * tier 2). Runs UserPromptSubmit-class hooks INSIDE the server message-delivery
 * path, BEFORE the message is persisted/delivered, so prompt-classification hooks
 * (the `issue-*-detector` family) work identically for EVERY harness — including
 * hookless catalog CLIs (e.g. Pi) that have no native hook mechanism.
 *
 * Two halves:
 *   - {@link registerMessageHook} — the SINGLE registration surface (KD7). It is
 *     a cross-issue contract: #3132's capability-gate interceptor registers here.
 *     Keep it exported and its signature stable.
 *   - {@link runMessageHooks} — the pure-ish runner (KD3). Filters ORIGIN → SCOPE
 *     → DEDUP, then runs each surviving hook under a HARD per-hook timeout
 *     (`Promise.race`) so a hung hook can never stall the platform-wide delivery
 *     path (the #962 desync class — OR1). Purely a function of its inputs; the
 *     caller (`MessageService.sendMessage`) resolves the manifest + passes the
 *     registry snapshot.
 */
import type {
  HarnessManifest,
  HookCoverageRecord,
  MessageHookConfig,
} from "@hapi/protocol";
import { messageHookConfigSchema } from "@hapi/protocol";
import type { MessageOrigin, SentFrom } from "./sentFrom";
import { USER_SENT_FROM_VALUES } from "./sentFrom";

/** The input a hook handler receives — mirrors the UserPromptSubmit contract. */
export interface MessageHookInput {
  text: string;
  sessionId: string;
  sentFrom: SentFrom;
  event: string;
  /**
   * #3331: origin-class provenance of the send (ruling D6(a)). Threaded so a
   * gate hook can see the channel origin — the token gate needs the SENDER's
   * session id (R3 self-send) and origin class (R1 provenance), and
   * `content.meta.origin` is stamped only AFTER the hook runs, so it cannot be
   * read from the persisted message. Absent for programmatic / drained sends.
   */
  origin?: MessageOrigin;
}

/** A hook's outcome: inject context, deny delivery, emit a non-blocking notice,
 *  or nothing (no-op). */
export interface MessageHookResult {
  additionalContext?: string;
  /**
   * Deny delivery. #3579: `params` is an optional copy-template channel that
   * flows end-to-end (deny → RunMessageHooksResult.denied → route body →
   * SendMessageDenial → resolveDenialOutcome) so a catalogue entry can
   * interpolate `{issueNumber}` / `{detail}` etc.
   */
  deny?: { reason: string; params?: Record<string, string | number> };
  /**
   * #3579: a NON-blocking gate notice (#3559 `already-granted`, #3563
   * `grant-orphaned`) — persisted beside delivery, does NOT deny. `hookId`
   * defaults to the emitting hook's config id when the handler omits it.
   */
  notice?: {
    hookId?: string;
    code: string;
    params?: Record<string, string | number>;
  };
}

/**
 * A hook handler. `opts.signal` is aborted when the hook exceeds its timeout, so
 * a `command`-bound handler can kill its subprocess and leave no orphan. A
 * `builtin` handler may ignore it.
 */
export type MessageHookHandler = (
  input: MessageHookInput,
  opts?: { signal?: AbortSignal }
) => Promise<MessageHookResult>;

export interface RegisteredMessageHook {
  config: MessageHookConfig;
  handler: MessageHookHandler;
}

/**
 * KD5 feature flag. The WHOLE stage is opt-in and defaults OFF: with it off,
 * `MessageService.sendMessage` skips the stage entirely and delivery is
 * byte-identical to pre-#3124 (R6). Read per-call (env-var, no caching) so the
 * flag can be flipped by a restart with a new `Environment=` directive.
 */
export function messageHooksEnabled(): boolean {
  const v = process.env.HAPI_MESSAGE_HOOKS?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ── Registry (Task 2) ─────────────────────────────────────────────────
const registry = new Map<string, RegisteredMessageHook>();
const builtinHandlers = new Map<string, MessageHookHandler>();

/** Pre-register a named in-process handler that a `{kind:"builtin", id}` config
 *  can bind to (an alternative to passing the handler to registerMessageHook). */
export function registerBuiltinMessageHookHandler(
  id: string,
  handler: MessageHookHandler
): void {
  builtinHandlers.set(id, handler);
}

/**
 * The SINGLE registration surface (KD7). Validates the config, resolves its
 * execution binding, and adds it to the registry the delivery stage consumes.
 * `builtin` binds to `handler` (or a pre-registered builtin id) — an unknown id
 * is a TYPED error AT REGISTRATION (never a silent no-op at delivery). `command`
 * wraps a subprocess adapter speaking the UserPromptSubmit stdin/stdout JSON
 * contract. Cross-issue contract (#3132 registers its gate here) — stable.
 */
export function registerMessageHook(
  config: MessageHookConfig,
  handler?: MessageHookHandler
): RegisteredMessageHook {
  const parsed = messageHookConfigSchema.parse(config);
  let resolved: MessageHookHandler;
  if (parsed.handler.kind === "builtin") {
    const h = handler ?? builtinHandlers.get(parsed.handler.id);
    if (!h) {
      throw new Error(
        `registerMessageHook: no builtin handler for id "${parsed.handler.id}" ` +
          `(pass a handler or registerBuiltinMessageHookHandler first)`
      );
    }
    resolved = h;
  } else {
    resolved = createCommandHandler(parsed.handler);
  }
  const entry: RegisteredMessageHook = { config: parsed, handler: resolved };
  registry.set(parsed.id, entry);
  return entry;
}

/** Snapshot of the registered hooks in registration order. */
export function getRegisteredMessageHooks(): RegisteredMessageHook[] {
  return [...registry.values()];
}

/** Clear the registry — test hygiene only. */
export function clearRegisteredMessageHooks(): void {
  registry.clear();
  builtinHandlers.clear();
}

// ── Command handler adapter (KD7) ─────────────────────────────────────
/**
 * Build a handler that runs a subprocess speaking the `.claude/hooks/*`
 * UserPromptSubmit JSON contract: JSON payload on stdin, a JSON (or raw-text)
 * result on stdout. Bounded by the caller's abort signal — on abort the process
 * is killed so no orphan survives (async discipline, OR1).
 */
function createCommandHandler(binding: {
  command: string;
  args?: string[];
}): MessageHookHandler {
  return async (input, opts) => {
    const proc = Bun.spawn([binding.command, ...(binding.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const payload = JSON.stringify({
        hook_event_name: input.event,
        prompt: input.text,
        session_id: input.sessionId,
        sent_from: input.sentFrom,
      });
      proc.stdin.write(payload);
      await proc.stdin.end();
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return parseHookOutput(stdout);
    } finally {
      opts?.signal?.removeEventListener("abort", onAbort);
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }
  };
}

/**
 * Parse a UserPromptSubmit-style hook's stdout into a {@link MessageHookResult}.
 * Recognizes the Claude-Code JSON shapes (`hookSpecificOutput.additionalContext`,
 * `decision:"block"`, `continue:false`); a non-JSON non-empty stdout is treated
 * as raw additionalContext (Claude Code's exit-0-stdout-is-context behavior).
 */
export function parseHookOutput(stdout: string): MessageHookResult {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { additionalContext: trimmed };
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const obj = parsed as Record<string, unknown>;
  if (
    obj.decision === "block" ||
    obj.continue === false ||
    (isRecord(obj.hookSpecificOutput) &&
      obj.hookSpecificOutput.permissionDecision === "deny")
  ) {
    const reason =
      (typeof obj.reason === "string" && obj.reason) ||
      (typeof obj.stopReason === "string" && obj.stopReason) ||
      "denied by hook";
    return { deny: { reason } };
  }
  const hso = isRecord(obj.hookSpecificOutput)
    ? obj.hookSpecificOutput
    : undefined;
  const additionalContext =
    (hso && typeof hso.additionalContext === "string"
      ? hso.additionalContext
      : undefined) ??
    (typeof obj.additionalContext === "string"
      ? obj.additionalContext
      : undefined);
  return additionalContext ? { additionalContext } : {};
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ── Filters (KD4 / KD8 / R5 / R9) ─────────────────────────────────────
/** R9/KD8: a hook runs for genuine user origins always; a programmatic origin
 *  only when the hook opted into it via `origins`. */
function originAdmits(config: MessageHookConfig, sentFrom: SentFrom): boolean {
  if ((USER_SENT_FROM_VALUES as readonly string[]).includes(sentFrom)) {
    return true;
  }
  return (config.origins ?? []).includes(sentFrom);
}

/**
 * R5/KD4 native-coverage decision for a `no-native-equivalent` hook. Prefers the
 * #3123-emitted coverage records (only the projector knows what actually
 * materialized, incl. version-gated degradation); falls back to the static
 * manifest hooks axis when records are absent (correct for static capability,
 * blind to degradation — the fallback is flagged so the caller can log it).
 */
export function isNativelyCovered(
  config: MessageHookConfig,
  coverage: HookCoverageRecord[] | undefined,
  manifest: HarnessManifest | undefined
): { covered: boolean; viaFallback: boolean } {
  if (coverage && coverage.length > 0) {
    return {
      covered: coverage.some(
        r => r.dedupKey === config.dedupKey && r.native === true
      ),
      viaFallback: false,
    };
  }
  if (manifest) {
    // A harness that runs hooks in SOME native form (native-taxonomy or the
    // OpenCode plugin-shim) is treated as covering them; a `none` harness (truly
    // hookless) is not — so the message hook fires there.
    return { covered: manifest.hooks.mode !== "none", viaFallback: true };
  }
  // No records AND no resolvable manifest (legacy/unknown flavor): assume NOT
  // covered, favoring the whole point of the stage — a hookless harness gets the
  // hook. A stock Claude session always carries flavor="claude", so it resolves
  // a manifest and is correctly skipped above.
  return { covered: false, viaFallback: true };
}

// ── Runner (Task 3 / Task 5 / Task 8) ─────────────────────────────────
export interface RunMessageHooksInput {
  text: string;
  sessionId: string;
  sentFrom: SentFrom;
  /** #3331: origin-class provenance forwarded to each hook (ruling D6(a)). */
  origin?: MessageOrigin;
  harnessManifest?: HarnessManifest;
  coverage?: HookCoverageRecord[];
  hooks: RegisteredMessageHook[];
  /** Optional structured logger for the manifest-fallback breadcrumb (KD4). */
  log?: (message: string, context?: Record<string, unknown>) => void;
}

export interface RunMessageHooksResult {
  /** The (possibly context-augmented) text to deliver. On a denial, the original
   *  text is returned unchanged (it is not delivered). */
  text: string;
  /**
   * Set when a gate-class hook denied delivery — surfaced end-to-end (R8).
   * #3579: `code` is the runner's own failure code (`hook-timeout` / `hook-error`)
   * — the runner's prose reasons are not code-shaped, so the resolver keys on
   * `code ?? reason`. `params` is the hook's copy-template channel.
   */
  denied?: {
    hookId: string;
    reason: string;
    code?: string;
    params?: Record<string, string | number>;
  };
  /**
   * #3579: a NON-blocking notice a hook emitted during the stage. The caller
   * persists it beside delivery; it does NOT short-circuit (delivery proceeds).
   */
  notice?: {
    hookId: string;
    code: string;
    params?: Record<string, string | number>;
  };
}

/**
 * Run the message-hook stage. Never contains an unbounded await: every surviving
 * hook is `Promise.race`d against its own `timeoutMs` (V5 async discipline). On
 * the FIRST denial the stage short-circuits and returns it (delivery is denied).
 */
export async function runMessageHooks(
  input: RunMessageHooksInput
): Promise<RunMessageHooksResult> {
  const { hooks, coverage, harnessManifest, sentFrom, sessionId } = input;
  const contexts: string[] = [];
  let notice: RunMessageHooksResult["notice"];

  for (const hook of hooks) {
    const { config } = hook;

    // 1. ORIGIN filter (R9/KD8)
    if (!originAdmits(config, sentFrom)) continue;

    // 2. SCOPE + 3. DEDUP (R5/KD4)
    if (config.harnessScope === "no-native-equivalent") {
      const cov = isNativelyCovered(config, coverage, harnessManifest);
      if (cov.viaFallback) {
        input.log?.(
          `message-hook ${config.id}: native-coverage via manifest fallback (no session coverage records)`,
          { hookId: config.id, sessionId, covered: cov.covered }
        );
      }
      if (cov.covered) continue; // natively covered → skip (no double-fire, R5)
    }

    // Execute — each hook sees the ORIGINAL prompt text (UserPromptSubmit
    // semantics: hooks are independent; their contexts concatenate).
    const outcome = await executeHook(hook, {
      text: input.text,
      sessionId,
      sentFrom,
      event: config.event,
      origin: input.origin,
    });
    if (outcome.denied) {
      return {
        text: input.text,
        denied: {
          hookId: config.id,
          reason: outcome.denied.reason,
          ...(outcome.denied.code ? { code: outcome.denied.code } : {}),
          ...(outcome.denied.params ? { params: outcome.denied.params } : {}),
        },
      };
    }
    // #3579: a NON-blocking notice — record the first one; delivery continues.
    if (outcome.notice && !notice) {
      notice = {
        hookId: outcome.notice.hookId ?? config.id,
        code: outcome.notice.code,
        ...(outcome.notice.params ? { params: outcome.notice.params } : {}),
      };
    }
    if (outcome.additionalContext) contexts.push(outcome.additionalContext);
  }

  const text =
    contexts.length > 0
      ? `${contexts.join("\n\n")}\n\n${input.text}`
      : input.text;
  return { text, ...(notice ? { notice } : {}) };
}

/**
 * Execute one hook under a hard timeout (Task 8). The handler promise is mapped
 * to a settled result/error (never a raw rejection), so a LATE rejection after
 * the timeout already won cannot escape as an unhandled rejection. Timeout →
 * gate denies (R4 deny-on-timeout); non-gate applies failPolicy (open=skip,
 * closed=deny). A handler throw follows the same policy.
 */
/**
 * The R4 failure-policy decision shared by the timeout and handler-error failure
 * modes: a gate-class hook DENIES; a non-gate hook denies iff fail-closed, else
 * skips (fail-open). Single-sourced so the two failure modes cannot drift.
 */
function denyByPolicy(
  config: MessageHookConfig,
  gateReason: string,
  failClosedReason: string,
  code: string
): { denied?: { reason: string; code: string } } {
  // #3579: attach a code-shaped `code` (`hook-timeout` / `hook-error`) beside
  // the prose reason — the runner's own reasons are NOT code-shaped, so the
  // resolver keys on it (not the un-splittable prose) and a fail-closed timeout
  // reads as "we couldn't check, try again" rather than an unknown refusal.
  if (config.gateClass) return { denied: { reason: gateReason, code } };
  return config.failPolicy === "closed"
    ? { denied: { reason: failClosedReason, code } }
    : {}; // fail-open → skip
}

async function executeHook(
  hook: RegisteredMessageHook,
  input: MessageHookInput
): Promise<{
  additionalContext?: string;
  denied?: {
    reason: string;
    code?: string;
    params?: Record<string, string | number>;
  };
  notice?: {
    hookId?: string;
    code: string;
    params?: Record<string, string | number>;
  };
}> {
  const { config, handler } = hook;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hookPromise = handler(input, { signal: controller.signal }).then(
    r => ({ kind: "result" as const, value: r }),
    (err: unknown) => ({ kind: "error" as const, error: err })
  );
  const timeoutPromise = new Promise<{ kind: "timeout" }>(resolve => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), config.timeoutMs);
  });

  try {
    const race = await Promise.race([hookPromise, timeoutPromise]);

    if (race.kind === "timeout") {
      controller.abort(); // kill a command subprocess; no orphan
      return denyByPolicy(
        config,
        `hook "${config.id}" timed out after ${config.timeoutMs}ms`,
        `hook "${config.id}" timed out (fail-closed) after ${config.timeoutMs}ms`,
        "hook-timeout"
      );
    }

    if (race.kind === "error") {
      const msg =
        race.error instanceof Error ? race.error.message : String(race.error);
      return denyByPolicy(
        config,
        `hook "${config.id}" errored: ${msg}`,
        `hook "${config.id}" errored (fail-closed): ${msg}`,
        "hook-error"
      );
    }

    if (race.value.deny) {
      return {
        denied: {
          reason: race.value.deny.reason,
          ...(race.value.deny.params ? { params: race.value.deny.params } : {}),
        },
      };
    }
    return {
      additionalContext: race.value.additionalContext,
      ...(race.value.notice ? { notice: race.value.notice } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
