// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `sessionSpawnerHelpers` — module-scope helpers lifted out of
 * `sessionSpawner.ts` (issue #2081, Epic #2077 Sub-Issue D) so `sessionSpawner`
 * stays under the 1,500-line `max-lines` guardrail (#2084). Holds the
 * per-scheduler spawn rate-limit state + `waitForAnyChild` (moved VERBATIM from
 * `run.ts`) and `cloneRepoForSpawn` (the #1953 clone-on-spawn block, wrapped as
 * a result-returning function with identical logic). No behavior change.
 */
import fs from "fs/promises";
import {
  accountProviderOf,
  type AuthBinding,
  type AnyStoredAccount,
  type OpenAiStoredAccount,
} from "@hapi/protocol";
import { maskApiKey } from "@hapi/protocol/schemas";
import { logger } from "@/ui/logger";
import { getAllDescendantPids } from "@/utils/processTree";

/**
 * Clone `owner/repo` into `directory` via the host `gh` CLI (issue #1953 A6).
 * Runs daemon-side with host credentials — no GitHub token crosses to the web
 * client or the spawned agent's env (R11). Returns an `ok`/error result the
 * caller maps back to a spawn error; logic is byte-identical to the prior inline
 * block (validate shape → skip-if-non-empty (R7) → `gh repo clone` → remove a
 * partial dir + surface a clear error on failure (R6)).
 */
export async function cloneRepoForSpawn(
  cloneRepo: string,
  directory: string
): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
  // The repo id is interpolated into the gh argv — validate its shape.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(cloneRepo)) {
    return {
      ok: false,
      errorMessage: `Invalid clone repo '${cloneRepo}'. Expected "owner/repo".`,
    };
  }

  // R7: do NOT overwrite an existing, non-empty destination — treat it as
  // already-present and skip the clone (the session then runs in it).
  let destNonEmpty = false;
  try {
    const entries = await fs.readdir(directory);
    destNonEmpty = entries.length > 0;
  } catch {
    // Directory does not exist yet — gh repo clone will create it.
    destNonEmpty = false;
  }

  if (destNonEmpty) {
    logger.debug(
      `[DAEMON RUN] cloneRepo '${cloneRepo}': destination '${directory}' already exists and is non-empty — skipping clone (R7)`
    );
    return { ok: true };
  }

  logger.debug(
    `[DAEMON RUN] cloneRepo '${cloneRepo}': cloning into '${directory}'`
  );
  const cloneProc = Bun.spawn(["gh", "repo", "clone", cloneRepo, directory], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [cloneExit, , cloneStderr] = await Promise.all([
    cloneProc.exited,
    new Response(cloneProc.stdout).text(),
    new Response(cloneProc.stderr).text(),
  ]);
  if (cloneExit !== 0) {
    // R6: surface a clear error and leave NO broken session. Remove any
    // partial directory gh created before it failed.
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    const detail = cloneStderr.trim() || `gh exited ${cloneExit}`;
    logger.warn(`[DAEMON RUN] cloneRepo '${cloneRepo}' failed: ${detail}`);
    return {
      ok: false,
      errorMessage: `Failed to clone '${cloneRepo}' into '${directory}': ${detail}`,
    };
  }
  logger.debug(`[DAEMON RUN] cloneRepo '${cloneRepo}': clone succeeded`);
  return { ok: true };
}

/**
 * Per-scheduler spawn rate limit. Only applies to scheduler-initiated spawns
 * (identified by scheduleId). Manual, CLI, and peer session spawns are NOT
 * rate-limited — they rely on the concurrency cap (resolveMaxConcurrent) alone.
 *
 * Prevents runaway schedulers from churning through sessions that immediately
 * crash or exit, accumulating transient CPU load from repeated Claude Code
 * bootstrap cycles. (Issue #603)
 */
export const SCHEDULER_MAX_SPAWNS_PER_WINDOW = parseInt(
  process.env.HAPI_SCHEDULER_MAX_SPAWNS_PER_WINDOW || "20",
  10
);
export const SCHEDULER_RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.HAPI_SCHEDULER_RATE_LIMIT_WINDOW_MS || String(15 * 60_000),
  10
);

/** Per-scheduler rolling window of spawn timestamps. Key = scheduleId. */
export const schedulerSpawnTimestamps = new Map<string, number[]>();

/** Directories that are not allowed as session working directories. */
export const BLOCKED_CWD_PREFIXES = ["/tmp", "/test"];

// getAllDescendantPids and isPidDescendantOf moved to @/utils/processTree

/**
 * Wait for any child process to appear under a parent PID.
 * Returns true when at least one child exists, false on timeout.
 */
export async function waitForAnyChild(
  parentPid: number,
  timeoutMs: number = 20000
): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 200; // Check every 200ms

  while (Date.now() - startTime < timeoutMs) {
    const descendants = getAllDescendantPids(parentPid);
    if (descendants.length > 0) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return false;
}

// ── Per-session auth binding (issue #3351, epic #3345 Sub-Issue F) ──────────
//
// WHICH auth identity each session is bound to at spawn, recorded onto session
// metadata and displayed — labels/emails only, NEVER a secret (R4). The daemon
// COMPUTES the binding here (pure, no I/O), serializes it into the
// `HAPI_AUTH_BINDING` env carrier on BOTH spawn paths, and the CLI child STAMPS
// it in `buildSessionMetadata` (mirroring `HAPI_ACCOUNT_UUID`/`nativeModel`).
//
// 🔴 Raw key material never leaves this module: it enters `resolveApiKeyDisplayLabel`
// and can only exit as a LABEL, a provider display name, or a masked last-4. The
// colocated sentinel suite drives these functions with sentinel secrets and
// asserts absence across every flavor branch (the R4 merge gate — a `.passthrough()`
// schema test cannot prove secret-absence).

/** A #1955 vault key entry — structurally compatible with `StoredApiKey`. */
export interface VaultKeyEntry {
  /** The vault id (#1955 `StoredApiKey.id`). Optional only so legacy test
   *  fixtures stay valid; every stored entry carries one. */
  id?: string;
  provider: string;
  label?: string;
  key: string;
}

/**
 * Issue #4568: the display identity of ONE vault key, by id — its operator label,
 * else its masked form ({@link maskApiKey}). Never the raw key. Unlike
 * {@link resolveApiKeyDisplayLabel} (first entry per provider, #3351), this names
 * the EXACT key a session is bound to, so a node with several Anthropic keys
 * (#4463) labels each session with its own key.
 */
export function resolveApiKeyDisplayLabelById(
  apiKeys: VaultKeyEntry[] | undefined,
  apiKeyId: string
): string {
  const entry = (apiKeys ?? []).find(k => k.id === apiKeyId);
  if (!entry) return "Anthropic API key";
  return entry.label?.trim() || maskApiKey(entry.key);
}

/** Issue #4568: the daemon's spawn-time refusal codes for an API-key spawn. */
export type ApiKeyBindingErrorCode =
  | "api_key_agent_unsupported"
  | "api_key_not_found"
  | "api_key_changed";

/**
 * Issue #4568 (R3/R4): resolve an API-key spawn against the node vault. PURE.
 * The session must be a Claude session; the id must name an `anthropic` vault
 * entry; and — on a respawn, which carries the mask recorded at the first spawn —
 * that entry's mask must be unchanged, so a key replaced under the same id
 * (#4463's in-place replace) is refused when its last four characters differ.
 * The mask is the only fingerprint recorded, so a replacement that ends in the
 * same four characters is NOT detected and bills as the original key. Returns
 * the mask to record (`HAPI_API_KEY_MASKED`) and the display label. Every
 * message names the key by label / mask — never key material.
 */
export function resolveApiKeyBinding(input: {
  agent: string;
  apiKeyId: string;
  /** The mask recorded at the first spawn; absent on a fresh spawn. */
  expectedMasked?: string;
  apiKeys: VaultKeyEntry[] | undefined;
}):
  | { ok: true; masked: string; label: string }
  | { ok: false; code: ApiKeyBindingErrorCode; message: string } {
  if ((input.agent || "claude") !== "claude") {
    return {
      ok: false,
      code: "api_key_agent_unsupported",
      message: "API-key billing is available for Claude Code sessions only",
    };
  }
  const entry = (input.apiKeys ?? []).find(k => k.id === input.apiKeyId);
  if (!entry || entry.provider !== "anthropic" || !entry.key) {
    const recorded = input.expectedMasked ? ` (${input.expectedMasked})` : "";
    return {
      ok: false,
      code: "api_key_not_found",
      message: `The Anthropic API key${recorded} this session is bound to is no longer in this node's key vault — start a new session with a stored key`,
    };
  }
  const masked = maskApiKey(entry.key);
  const label = entry.label?.trim() || masked;
  if (input.expectedMasked && input.expectedMasked !== masked) {
    return {
      ok: false,
      code: "api_key_changed",
      message: `The Anthropic API key "${label}" changed since this session started (was ${input.expectedMasked}, now ${masked}) — start a new session to bill the new key`,
    };
  }
  return { ok: true, masked, label };
}

/**
 * Issue #4568 (F1): read ONE Anthropic key from vault entries by id. PURE. Its
 * callers are `hapi api-key-helper`, whose stdout Claude Code reads for its own
 * requests (the key is in no process environment), and the wrapper's
 * `verifyApiKeyForSession`, which discards the value and keeps only the binding. Applies {@link resolveApiKeyBinding}'s checks (Claude only, an
 * `anthropic` entry, the recorded mask unchanged), so it fails CLOSED on a
 * missing id or a changed mask; messages name the key by label / mask only.
 * Kept here, beside the resolver, so the helper's import graph stays light: it
 * runs as a fresh process on every key fetch.
 */
export function readVaultApiKey(input: {
  apiKeyId: string;
  expectedMasked?: string;
  apiKeys: VaultKeyEntry[] | undefined;
}):
  | { ok: true; key: string }
  | { ok: false; code: ApiKeyBindingErrorCode; message: string } {
  const resolution = resolveApiKeyBinding({
    agent: "claude",
    apiKeyId: input.apiKeyId,
    expectedMasked: input.expectedMasked,
    apiKeys: input.apiKeys,
  });
  if (!resolution.ok) return resolution;
  const entry = (input.apiKeys ?? []).find(k => k.id === input.apiKeyId);
  if (!entry?.key) {
    // Unreachable after an ok resolution (it requires a non-empty key); kept so
    // the key is never read through an unchecked optional.
    return {
      ok: false,
      code: "api_key_not_found",
      message:
        "The Anthropic API key this session is bound to is no longer in this node's key vault — start a new session with a stored key",
    };
  }
  return { ok: true, key: entry.key };
}

/**
 * Mask a secret to its last 4 characters for display — NEVER the raw key. A very
 * short key (≤4 chars) is fully masked (defensive — a real provider key is far
 * longer). Mirrors the `maskApiKey` last-4 discipline in the API-keys route.
 */
export function maskKeyLast4(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

/**
 * Task 3 (#3351) — resolve a DISPLAY label for a provider's credential from the
 * node-local #1955 vault (`readSettings().apiKeys`), NEVER the raw key. The
 * unambiguous invariant is "at most ONE vault entry per `provider`"
 * (`schemas.ts`, POST upserts). Fallback chain (`label` is `.optional()`):
 *   1. a matching vault entry WITH a `label`     → the label
 *   2. a matching vault entry with NO label      → the provider display name
 *   3. no vault entry, but a key IS used at spawn → masked last-4 of that key
 *   4. no entry, no used key                      → the provider display name
 * Never returns an empty string; never returns the raw key.
 *
 * The OpenRouter key used at spawn today is the LEGACY `settings.openRouterApiKey`
 * field (no label), so the openrouter path typically lands on tier (3) with that
 * key masked; a labeled `openrouter` vault entry (if present) wins via tier (1).
 * This is a CROSS-lookup for display only — it never changes which key auths.
 */
export function resolveApiKeyDisplayLabel(input: {
  apiKeys?: VaultKeyEntry[];
  provider: string;
  providerDisplayName: string;
  usedKey?: string;
}): string {
  const entry = (input.apiKeys ?? []).find(k => k.provider === input.provider);
  const label = entry?.label?.trim();
  if (label) return label; // (1)
  if (entry) return input.providerDisplayName; // (2)
  const used = input.usedKey?.trim();
  if (used) return maskKeyLast4(used); // (3)
  return input.providerDisplayName; // (4)
}

/**
 * Issue #3349: humanized display names for the native opencode providers (the
 * #1955 `API_KEY_PROVIDERS` set, minus `openrouter` which is the gateway path).
 * Used only as the `providerDisplayName` fallback in `resolveApiKeyDisplayLabel`
 * — the operator's vault label wins when set. An unmapped provider falls back to
 * its raw string, so this never blocks a new provider (R4 forward-compat).
 */
const OPENCODE_NATIVE_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  google: "Google",
  custom: "Custom",
};

/**
 * Task 2 (#3351) — the PURE per-flavor auth-binding computation. Maps the
 * resolved spawn facts → `{kind, displayIdentity, providerId?}`, TOTAL over every
 * branch so the R4 sentinel suite can drive it directly. Performs NO I/O.
 *
 * 🔴 Raw key material (`apiKeys[].key`, `openRouterUsedKey`, any OAuth token)
 * NEVER appears in the returned object — it exits only through
 * {@link resolveApiKeyDisplayLabel} (label / provider-name / masked-last-4). The
 * ChatGPT OAuth token is never even referenced (the ChatGPT identity is a fixed
 * "ChatGPT" fallback — its account label lives in the id-token, unreadable at the
 * daemon).
 *
 * `kind` is the 4-value enum FROZEN with #3346's `authBindingAxisSchema` and
 * #3353's cost mapping (GAP-2). `displayIdentity` is EMPTY for claude — the CLI
 * child fills the bound-account email in `buildSessionMetadata` (the account
 * identity is child-resolved, exactly as `claudeAccount` is).
 */
export function computeAuthBinding(input: {
  /** Normalized agent: "claude" | "codex" | "opencode" | "gemini". */
  agent: string;
  /** codex: a ChatGPT OAuth token is present → subscription-account. */
  codexHasToken?: boolean;
  /** #3808: the bound per-account codex record's auth mode. A bound codex spawn
   *  passes NO session token (its login lives in the account's CODEX_HOME dir), so
   *  this drives the binding: `chatgpt` → subscription-account, `api-key` → api-key;
   *  `providerId` is always "openai". Takes precedence over
   *  `codexHasToken`/`openRouterModel` (a bound account never carries a session token). */
  codexBoundAuthMode?: "chatgpt" | "api-key";
  /** codex/opencode: an OpenRouter model was selected → gateway-key. */
  openRouterModel?: string;
  /** Issue #3349: opencode NATIVE-routed spawn → the provider whose per-provider
   *  vault key was resolved (e.g. "anthropic"). Set ⇒ an `api-key` binding for
   *  that provider (not the OpenRouter gateway-key). Undefined for an OpenRouter
   *  opencode spawn (falls through to the gateway-key branch). */
  opencodeNativeProvider?: string;
  /** Node-local #1955 vault (`settings.apiKeys`) — RAW keys; never emitted. */
  apiKeys?: VaultKeyEntry[];
  /** Legacy `settings.openRouterApiKey` used at spawn — RAW; never emitted. */
  openRouterUsedKey?: string;
  /** Issue #4568: a Claude spawn bound to THIS vault key id → an `api-key`
   *  binding for anthropic, labelled by the key's label (else its mask). */
  claudeApiKeyId?: string;
}): AuthBinding {
  const agent = input.agent || "claude";
  const apiKeys = input.apiKeys ?? [];

  // Issue #4568: a Claude session bound to a vault Anthropic key bills that key
  // per token — `api-key`, which #3353's cost mapping already shows as REAL cost.
  if (agent === "claude" && input.claudeApiKeyId) {
    return {
      kind: "api-key",
      displayIdentity: resolveApiKeyDisplayLabelById(
        apiKeys,
        input.claudeApiKeyId
      ),
      providerId: "anthropic",
    };
  }

  if (agent === "codex") {
    // #3808: a spawn BOUND to a per-account codex record. Its login lives in the
    // account's CODEX_HOME dir, so no session token is passed — the account's
    // authMode drives the kind, providerId is always "openai". Takes precedence
    // over the token / OpenRouter arms. [ER 2026-09-19: 3808-7]
    if (input.codexBoundAuthMode) {
      return input.codexBoundAuthMode === "api-key"
        ? { kind: "api-key", displayIdentity: "API key", providerId: "openai" }
        : {
            kind: "subscription-account",
            displayIdentity: "ChatGPT",
            providerId: "openai",
          };
    }
    if (input.openRouterModel) {
      return {
        kind: "gateway-key",
        displayIdentity: resolveApiKeyDisplayLabel({
          apiKeys,
          provider: "openrouter",
          providerDisplayName: "OpenRouter",
          usedKey: input.openRouterUsedKey,
        }),
        providerId: "openrouter",
      };
    }
    if (input.codexHasToken) {
      return {
        kind: "subscription-account",
        displayIdentity: "ChatGPT",
        providerId: "openai",
      };
    }
    // token-less AND model-less codex → codex's own default home (R7).
    return { kind: "inherited", displayIdentity: "Host default" };
  }

  if (agent === "opencode") {
    // Issue #3349: native-routed opencode → an api-key binding for the resolved
    // provider (feeds #3351's recorder + #3353's cost mapping). The vault label
    // (operator-set) wins for displayIdentity; else the humanized provider name.
    // Never emits key material (resolveApiKeyDisplayLabel is label/name only).
    if (input.opencodeNativeProvider) {
      const provider = input.opencodeNativeProvider;
      return {
        kind: "api-key",
        displayIdentity: resolveApiKeyDisplayLabel({
          apiKeys,
          provider,
          providerDisplayName:
            OPENCODE_NATIVE_PROVIDER_DISPLAY_NAMES[provider] ?? provider,
        }),
        providerId: provider,
      };
    }
    // OpenRouter path (#1975, pre-#3349) — a gateway key.
    return {
      kind: "gateway-key",
      displayIdentity: resolveApiKeyDisplayLabel({
        apiKeys,
        provider: "openrouter",
        providerDisplayName: "OpenRouter",
        usedKey: input.openRouterUsedKey,
      }),
      providerId: "openrouter",
    };
  }

  if (agent === "gemini") {
    // #3362: a gemini session injects GEMINI_API_KEY from the vault (provider
    // "gemini" preferred over "google"). Mirrors the sessionSpawner gemini arm's
    // decision EXACTLY (derivable from apiKeys alone): a non-empty vault key →
    // api-key + its label; otherwise the node-local env fallback (or nothing) →
    // inherited (R7 — never fabricate an identity Hapimatic did not deliver).
    const vaultEntry =
      apiKeys.find(k => k.provider === "gemini" && k.key?.trim()) ??
      apiKeys.find(k => k.provider === "google" && k.key?.trim());
    if (vaultEntry) {
      return {
        kind: "api-key",
        displayIdentity: resolveApiKeyDisplayLabel({
          apiKeys,
          provider: vaultEntry.provider,
          providerDisplayName: "Gemini",
        }),
        providerId: "google",
      };
    }
    return { kind: "inherited", displayIdentity: "Host default" };
  }

  // claude (or an unknown/default flavor): subscription-account. displayIdentity
  // is EMPTY — the CLI child fills the bound-account email (child-resolved).
  return {
    kind: "subscription-account",
    displayIdentity: "",
    providerId: "anthropic",
  };
}

/**
 * Issue #3731 (R0b, ruling D3 option 1): the instance credential to deliver
 * EXPLICITLY to a spawn, or `undefined` when none may be delivered.
 *
 * An UNBOUND claude spawn (no `accountUuid` — an un-pinned CLI / scheduler / peer /
 * federation spawn on a node with no host-default login, or a store-less VM) has
 * no explicit binding: its only credential on a paste-token node is the onboarding
 * `CLAUDE_CODE_OAUTH_TOKEN`. That token used to reach it AMBIENTLY (daemon env →
 * tmux global table → pane), which is exactly the path that leaked it into
 * account-bound sessions. Severing the ambient copy (#3731 R0/R3) would strand the
 * unbound session, so the daemon delivers the held token explicitly instead — the
 * tmux arm through its 0600 spawn env file (the same channel as `CLI_API_TOKEN`),
 * the direct arm through the child's spawn env.
 *
 * Returns the held token ONLY when all hold:
 *  - `agent` is claude (the default) — codex/gemini/opencode never consume it;
 *  - `accountUuid` is empty — a BOUND spawn binds explicitly, and a host-default
 *    spawn (`accountUuid` set, `shouldSkipBinding`) is bound to the host login, so
 *    the instance token must never reach either (it would override their
 *    credentials — the bug being fixed);
 *  - no explicit token was passed with the spawn request (`explicitToken`) — an
 *    explicitly passed token always wins, on both the tmux and the direct arm;
 *  - a non-empty token is held.
 *
 * PURE (#2084 extraction pattern) — no I/O; never logs the token.
 */
export function resolveUnboundInstanceToken(input: {
  /** Normalized agent: "claude" | "codex" | "opencode" | "gemini". */
  agent: string;
  /** The EFFECTIVE bound account (after un-pinned resolution); empty ⇒ unbound. */
  accountUuid: string | undefined;
  /** The daemon's held instance credential (`ctx.instanceOAuthToken`, or the
   *  not-yet-captured ambient copy — see the sessionSpawner call site). */
  heldToken: string | undefined;
  /** A token passed explicitly with the spawn request (`options.token`). */
  explicitToken?: string;
  /** Issue #4568: the spawn bills a vault API key — its ONLY credential, so the
   *  instance OAuth token must never ride along (the key would win, but the
   *  session would carry two credentials). */
  apiKeyBound?: boolean;
}): string | undefined {
  if ((input.agent || "claude") !== "claude") return undefined;
  if (input.apiKeyBound) return undefined;
  if (input.accountUuid) return undefined;
  if (input.explicitToken) return undefined;
  return input.heldToken || undefined;
}

/**
 * Issue #3731 (R4, F3): classify one read of the tmux global environment table
 * for the daemon's ambient-token warning. `null` (the read failed or timed out)
 * is `"unknown"` — never `"clean"` — so the warning's one-shot switch-off
 * (`DaemonContext.ambientTokenTableProbeClean`) only latches on a real clean read.
 * PURE — the input is names only.
 */
export function classifyTableProbe(
  names: ReadonlySet<string> | null
): "token" | "clean" | "unknown" {
  if (names === null) return "unknown";
  return names.has("CLAUDE_CODE_OAUTH_TOKEN") ? "token" : "clean";
}

// ── Per-session provider binding (issue #3808, epic #3345) ──────────────────
//
// The #3808 analogue of the Anthropic `HAPI_ACCOUNT_UUID → CLAUDE_CONFIG_DIR`
// chain: a codex session BOUND to a per-account OpenAI record must point
// CODEX_HOME at that account's PERSISTENT dir (`account-configs/<pk>/codex/`,
// #3807 owns it at 0700) so codex uses the account's own login. Delivered via
// `extraEnv` ONLY — NEVER as `session.codexHome`, which the tmux path persists
// AND `fs.rm`s on session delete (`tmuxSpawnAdapter`); the account dir is
// machine-global and must survive session exit / delete / daemon restart (R6/V2).
// PURE (#2084): the record already carries the `codexHome` path — no I/O.
//
// Gemini's per-account key is NOT resolved here — it needs a vault read (I/O) and
// stays in the `sessionSpawner` gemini arm (made account-aware in #3808 Task 2).
// [ER 2026-09-19: 3808-1] [ER 2026-09-19: K-CODEX-HOME]
export interface ProviderBindingResult {
  /** The bound codex account's persistent CODEX_HOME, or undefined when the spawn
   *  is not a bound-per-account codex spawn (falls back to the ephemeral setup /
   *  codex's own default home). Inject via `extraEnv.CODEX_HOME`, never
   *  `session.codexHome`. */
  codexHome?: string;
  /** The bound codex account's auth mode — feeds `computeAuthBinding`'s
   *  `codexBoundAuthMode` so a bound codex spawn (which passes no `options.token`)
   *  still stamps `providerId:"openai"` + the right kind (subscription-account for
   *  chatgpt, api-key for api-key). Undefined for a non-bound-codex spawn. */
  codexAuthMode?: "chatgpt" | "api-key";
}

/**
 * Resolve the per-session provider binding for a spawn. Returns the codex
 * `CODEX_HOME` + `authMode` for a bound per-account OpenAI record; `{}` otherwise
 * (Anthropic, Google, an unbound spawn, or a null record).
 */
export function resolveProviderBinding(input: {
  agent: string;
  record: AnyStoredAccount | null;
}): ProviderBindingResult {
  if (
    input.agent === "codex" &&
    input.record &&
    accountProviderOf(input.record) === "openai"
  ) {
    const record = input.record as OpenAiStoredAccount;
    return { codexHome: record.codexHome, codexAuthMode: record.authMode };
  }
  return {};
}
