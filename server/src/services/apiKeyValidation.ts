// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiKeyStatus, StoredApiKey } from "@hapi/protocol/schemas";
import {
  readSettings,
  SettingsUnreadableError,
  updateSettings,
} from "../config/settings";

/**
 * Per-provider API-key validation (issue #1956, epic #1954 — B3).
 *
 * Probes whether a stored provider key is valid and drives a 4-state status
 * machine (🟢 valid / 🔴 invalid / 🟠 unverified / ⚪ none) surfaced on the API
 * Keys page (#1955) and consumable by the future SEAM-2 account↔key selector
 * (epic #1947 A3) via the redacted GET list response.
 *
 * SECURITY (PM-locked, #1956): the probe runs node-side IN THE SERVER PROCESS,
 * which is NOT egress-sandboxed (the #1734 OmniBox broker + SECRET_ENV_VARS strip
 * restrict the AGENT, not the server — the server already calls api.anthropic.com
 * in usageService / anthropicOauthLoginClient). The adapter resolves the plaintext
 * `key` from the store, probes the provider, and returns ONLY a status outcome —
 * the secret never crosses the HTTP boundary. This module NEVER returns or logs
 * the plaintext key: {@link validateApiKeyById} hands the updated StoredApiKey
 * back to the route for redaction (in-process only), and probe failures surface
 * only an HTTP status / outcome string — never the key or the response body.
 * #4463: a 2xx models-list body is read (byte-capped) only to COUNT the models
 * the key can reach; the body is never returned, stored or logged.
 *
 * Extension point (R2 "add a provider = one adapter"): implement a
 * {@link ProviderValidationAdapter} and register it in {@link VALIDATION_ADAPTERS}.
 */

/** Default per-probe timeout. A transient timeout never demotes a known-good key. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default validation cache TTL — a re-validate within this window reuses the
 *  cached status instead of re-probing (R7, no endpoint hammering). */
export const DEFAULT_VALIDATION_TTL_MS = 60_000;

/** The classification of a single provider probe. */
export type ProbeOutcome = "valid" | "invalid" | "transient" | "unsupported";

/** Narrow `fetch` shape — a test double satisfies it without the full signature
 *  (mirrors `anthropicOauthLoginClient.FetchLike`). */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface ValidateProbeOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * A probe outcome plus what the provider honestly reported (#4463 Task 3). The
 * field names are those of `StoredApiKey.lastValidation`. `httpStatus` is absent
 * when the provider gave no HTTP answer (network error, timeout); `modelCount` is
 * present only when a 2xx models-list body was counted, and `modelCountCapped`
 * marks a list that holds more models than one page returned.
 */
export interface ProbeResult {
  outcome: ProbeOutcome;
  httpStatus?: number;
  modelCount?: number;
  modelCountCapped?: boolean;
}

/** One adapter per provider. `validate` resolves to a {@link ProbeOutcome} or a
 *  {@link ProbeResult} and NEVER throws — any network/timeout failure is mapped to
 *  `"transient"`. A bare outcome stays valid so adapters written against the
 *  string return (#2724, #4335) compile unchanged; {@link probeProvider}
 *  normalizes both forms. */
export interface ProviderValidationAdapter {
  validate(
    key: string,
    opts?: ValidateProbeOptions
  ): Promise<ProbeOutcome | ProbeResult>;
}

/**
 * Standard HTTP-status → outcome classification used by OpenAI / Anthropic /
 * OpenRouter (all return 401 for a bad key):
 * - 2xx → valid
 * - 401 / 403 → invalid (definitive auth rejection)
 * - everything else (429, 5xx, unexpected) → transient (never a false 🔴)
 */
function classifyStandard(status: number): ProbeOutcome {
  if (status >= 200 && status < 300) return "valid";
  if (status === 401 || status === 403) return "invalid";
  return "transient";
}

/**
 * Google Generative Language variant: an invalid Gemini key returns HTTP 400
 * (API_KEY_INVALID), and a missing/forbidden key returns 403 — both are
 * definitive rejections (the only thing the probe varies is the `key` query
 * param). Verified empirically against the live endpoint (#1956 OR-1).
 */
function classifyGemini(status: number): ProbeOutcome {
  if (status >= 200 && status < 300) return "valid";
  if (status === 400 || status === 401 || status === 403) return "invalid";
  return "transient";
}

/** Issue a GET probe and classify the response. Any thrown error (network,
 *  DNS, AbortSignal timeout) maps to `"transient"` — never `"invalid"`. The
 *  response body is never read or logged (no-leak discipline). Exported as the
 *  one-line adapter building block (#2724, #4335); the built-in adapters use
 *  {@link probeGetDetailed}, which also reports status and model count (#4463). */
export async function probeGet(
  url: string,
  headers: Record<string, string>,
  opts: ValidateProbeOptions | undefined,
  classify: (status: number) => ProbeOutcome
): Promise<ProbeOutcome> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "transient";
  }
  return classify(res.status);
}

/** Upper bound on a models-list body read for counting (#4463 Task 3). A body
 *  past it is dropped and the probe reports no count rather than buffer more. */
export const MODEL_LIST_BYTE_CAP = 2 * 1024 * 1024;

/** How to count the models in a 2xx models-list body. Returns null when the
 *  body does not have the expected shape (then no count is reported). */
type ModelCounter = (
  body: unknown
) => { count: number; capped: boolean } | null;

/** Read a response body up to `cap` bytes; null when it is larger or unreadable. */
async function readCappedText(
  res: Response,
  cap: number
): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * {@link probeGet} plus the detail a {@link ProbeResult} carries (#4463 Task 3):
 * the HTTP status, and — for a 2xx answer with a `count` reader — the number of
 * models the key can reach. The body is read only to count, inside a byte cap,
 * and is never returned or logged. `probeGet` keeps its bare-outcome signature
 * for the one-line adapters of #2724 / #4335.
 */
async function probeGetDetailed(
  url: string,
  headers: Record<string, string>,
  opts: ValidateProbeOptions | undefined,
  classify: (status: number) => ProbeOutcome,
  count?: ModelCounter
): Promise<ProbeResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { outcome: "transient" };
  }
  const outcome = classify(res.status);
  const result: ProbeResult = { outcome, httpStatus: res.status };
  if (outcome !== "valid" || !count) return result;
  const text = await readCappedText(res, MODEL_LIST_BYTE_CAP);
  if (text === null) return result;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return result;
  }
  const counted = count(body);
  if (counted) {
    result.modelCount = counted.count;
    result.modelCountCapped = counted.capped;
  }
  return result;
}

/** Count a `{ data: [...] }` list (Anthropic, OpenAI). `has_more` marks a cap. */
function countDataList(
  body: unknown
): { count: number; capped: boolean } | null {
  const b = body as { data?: unknown; has_more?: unknown } | null;
  if (!b || !Array.isArray(b.data)) return null;
  return { count: b.data.length, capped: b.has_more === true };
}

/** Count a Gemini `{ models: [...] }` page; a `nextPageToken` marks a cap. */
function countGeminiList(
  body: unknown
): { count: number; capped: boolean } | null {
  const b = body as { models?: unknown; nextPageToken?: unknown } | null;
  if (!b || !Array.isArray(b.models)) return null;
  return {
    count: b.models.length,
    capped: typeof b.nextPageToken === "string" && b.nextPageToken !== "",
  };
}

// ── Per-provider adapters ──────────────────────────────────────────────────
// Probe endpoints verified live (auth-gated, exist) on 2026-06-25 — #1956 OR-1.

/** OpenAI: GET /v1/models with a Bearer token (unpaginated — the whole list). */
const openaiAdapter: ProviderValidationAdapter = {
  validate: (key, opts) =>
    probeGetDetailed(
      "https://api.openai.com/v1/models",
      { Authorization: `Bearer ${key}` },
      opts,
      classifyStandard,
      countDataList
    ),
};

/** Anthropic: GET /v1/models with x-api-key + the required anthropic-version.
 *  `limit=1000` is the documented page maximum; `has_more` marks a capped count. */
const anthropicAdapter: ProviderValidationAdapter = {
  validate: (key, opts) =>
    probeGetDetailed(
      "https://api.anthropic.com/v1/models?limit=1000",
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
      opts,
      classifyStandard,
      countDataList
    ),
};

/** OpenRouter: GET /api/v1/key (returns key metadata for a valid key). Base URL
 *  matches #1733's Codex gateway consumer (OPENROUTER_BASE_URL). */
const openrouterAdapter: ProviderValidationAdapter = {
  validate: (key, opts) =>
    probeGetDetailed(
      "https://openrouter.ai/api/v1/key",
      { Authorization: `Bearer ${key}` },
      opts,
      classifyStandard
    ),
};

/** Google Generative Language (Gemini): GET /v1beta/models?key=<key>.
 *  `pageSize=1000` is the documented maximum; `nextPageToken` marks a cap. */
const geminiAdapter: ProviderValidationAdapter = {
  validate: (key, opts) =>
    probeGetDetailed(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`,
      {},
      opts,
      classifyGemini,
      countGeminiList
    ),
};

/**
 * Registry — the single extension point. Adding a provider = implement an
 * adapter + add one entry here. A provider WITHOUT an entry (e.g. `custom`, which
 * has no known base URL) resolves to `"unsupported"` → 🟠 unverified.
 */
export const VALIDATION_ADAPTERS: Record<string, ProviderValidationAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  openrouter: openrouterAdapter,
  gemini: geminiAdapter,
  google: geminiAdapter, // alias — same Google Generative Language API
  // `custom`: intentionally absent — no known probe target → "unsupported".
};

export function getAdapter(
  provider: string
): ProviderValidationAdapter | undefined {
  return VALIDATION_ADAPTERS[provider];
}

/**
 * Probe `key` for `provider` and return a normalized {@link ProbeResult} (#4463):
 * a provider without an adapter is `unsupported` (no network call), and an
 * adapter's bare outcome becomes `{ outcome }`. Used by the validate path and by
 * the validate-then-store add, so both report the same fields.
 */
export async function probeProvider(
  provider: string,
  key: string,
  opts?: ValidateProbeOptions
): Promise<ProbeResult> {
  const adapter = getAdapter(provider);
  if (!adapter) return { outcome: "unsupported" };
  const raw = await adapter.validate(key, opts);
  return typeof raw === "string" ? { outcome: raw } : raw;
}

/** The `lastValidation` record of a probe (or a copy of a stored one) — only
 *  the three reported numbers, built field-by-field; absent fields stay absent.
 *  The key redaction reuses it, so no other stored field can ride this copy. */
export function toLastValidation(
  probe: Pick<ProbeResult, "httpStatus" | "modelCount" | "modelCountCapped">
): NonNullable<StoredApiKey["lastValidation"]> {
  return {
    ...(probe.httpStatus !== undefined ? { httpStatus: probe.httpStatus } : {}),
    ...(probe.modelCount !== undefined ? { modelCount: probe.modelCount } : {}),
    ...(probe.modelCountCapped !== undefined
      ? { modelCountCapped: probe.modelCountCapped }
      : {}),
  };
}

/** KD-1 sticky last-known-good (#5429): a `transient` probe of a key whose
 *  prior status is 🟢 valid changes nothing the user sees — neither the
 *  status nor the last good probe's figures. One predicate for both, so the
 *  status rule and the details rule cannot drift apart. Pure. */
export function keepsLastKnownGood(
  prior: ApiKeyStatus | undefined,
  outcome: ProbeOutcome
): boolean {
  return outcome === "transient" && prior === "valid";
}

/**
 * Status state machine (KD-1). A `transient` outcome resolves to 🟠 unverified
 * UNLESS the prior status was 🟢 valid — in which case the known-good status is
 * preserved (sticky last-known-good; a network blip never demotes a valid key to
 * 🔴 or 🟠). Pure + exported for unit testing.
 */
export function applyTransition(
  prior: ApiKeyStatus | undefined,
  outcome: ProbeOutcome
): ApiKeyStatus {
  switch (outcome) {
    case "valid":
      return "valid";
    case "invalid":
      return "invalid";
    case "transient":
      return keepsLastKnownGood(prior, outcome) ? "valid" : "unverified";
    case "unsupported":
      return "unverified";
  }
}

/** Result of {@link validateApiKeyById}. The route redacts `entry` before it
 *  crosses the HTTP boundary; the secret never leaves the process. */
export type ValidateApiKeyResult =
  | { ok: true; entry: StoredApiKey }
  | { ok: false; reason: "not_found" | "unreadable" };

export interface ValidateApiKeyOptions {
  /** Cache window; a re-validate within it returns the cached status (R7). */
  ttlMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable fetch for deterministic tests (forwarded to the adapter). */
  fetchImpl?: FetchLike;
  /** Per-probe timeout override. */
  timeoutMs?: number;
  /** #4463: bypass the TTL cache and always probe (a re-Test from the UI). */
  force?: boolean;
}

/**
 * Validate the stored key with the given `id`: TTL-cache gate → provider probe →
 * state transition → persist. Returns the updated {@link StoredApiKey} (for the
 * route to redact). Never returns or logs the plaintext key.
 *
 * #4463 X5: the probe runs on an UNLOCKED read, and its outcome is applied to the
 * entry as re-read inside {@link updateSettings}. Writing the pre-probe snapshot
 * back (the old shape) erased any key added — and resurrected any key deleted —
 * while the probe was in flight. A key removed during the probe answers
 * `not_found` and nothing is written; other entries are never rewritten.
 *
 * #5429 S2: a transient re-test of a 🟢 valid key keeps its last
 * `lastValidation` (the reachable-model count it last reported). Its
 * `lastValidatedAt` still advances, so the TTL cache throttles re-probes of a
 * provider that is down.
 */
export async function validateApiKeyById(
  settingsFile: string,
  id: string,
  opts: ValidateApiKeyOptions = {}
): Promise<ValidateApiKeyResult> {
  const ttlMs = opts.ttlMs ?? DEFAULT_VALIDATION_TTL_MS;
  const now = opts.now ?? Date.now;

  const settings = await readSettings(settingsFile);
  // readSettings returns null ONLY on a parse error — refuse to overwrite (mirror
  // the route's POST/DELETE discipline so a probe never clobbers existing secrets).
  if (settings === null) return { ok: false, reason: "unreadable" };

  const entry = (settings.apiKeys ?? []).find(e => e.id === id);
  if (!entry) return { ok: false, reason: "not_found" };

  // TTL cache gate (R7): a recent validation short-circuits the probe entirely,
  // unless the caller forces a fresh probe (#4463 R5).
  if (entry.lastValidatedAt && !opts.force) {
    const last = Date.parse(entry.lastValidatedAt);
    if (!Number.isNaN(last) && now() - last < ttlMs) {
      return { ok: true, entry };
    }
  }

  const probe = await probeProvider(entry.provider, entry.key, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });

  // A holder, not a `let`: TS narrows a closure-assigned `let x = null` to never.
  const applied: { entry: StoredApiKey | null } = { entry: null };
  try {
    await updateSettings(settingsFile, fresh => {
      const entries = fresh.apiKeys ?? [];
      const idx = entries.findIndex(e => e.id === id);
      if (idx === -1) return fresh;
      const current = entries[idx]!;
      // `current` is spread, so keeping it leaves `lastValidation` exactly as
      // stored — including absent on an entry that never had one.
      const keep = keepsLastKnownGood(current.status, probe.outcome);
      const next: StoredApiKey = {
        ...current,
        status: applyTransition(current.status, probe.outcome),
        lastValidatedAt: new Date(now()).toISOString(),
        ...(keep ? {} : { lastValidation: toLastValidation(probe) }),
      };
      applied.entry = next;
      return {
        ...fresh,
        apiKeys: entries.map((e, i) => (i === idx ? next : e)),
      };
    });
  } catch (error) {
    if (error instanceof SettingsUnreadableError) {
      return { ok: false, reason: "unreadable" };
    }
    throw error;
  }
  if (!applied.entry) return { ok: false, reason: "not_found" };
  return { ok: true, entry: applied.entry };
}
