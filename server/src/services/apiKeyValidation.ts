// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiKeyStatus, StoredApiKey } from "@hapi/protocol/schemas";
import { readSettings, writeSettings, type Settings } from "../config/settings";

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

/** One adapter per provider. `validate` resolves to a {@link ProbeOutcome} and
 *  NEVER throws — any network/timeout failure is mapped to `"transient"`. */
export interface ProviderValidationAdapter {
  validate(key: string, opts?: ValidateProbeOptions): Promise<ProbeOutcome>;
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
 *  response body is never read or logged (no-leak discipline). */
async function probeGet(
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

// ── Per-provider adapters ──────────────────────────────────────────────────
// Probe endpoints verified live (auth-gated, exist) on 2026-06-25 — #1956 OR-1.

/** OpenAI: GET /v1/models with a Bearer token. */
const openaiAdapter: ProviderValidationAdapter = {
  validate: (key, opts) =>
    probeGet(
      "https://api.openai.com/v1/models",
      { Authorization: `Bearer ${key}` },
      opts,
      classifyStandard
    ),
};

/** Anthropic: GET /v1/models with x-api-key + the required anthropic-version. */
const anthropicAdapter: ProviderValidationAdapter = {
  validate: (key, opts) =>
    probeGet(
      "https://api.anthropic.com/v1/models",
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
      opts,
      classifyStandard
    ),
};

/** OpenRouter: GET /api/v1/key (returns key metadata for a valid key). Base URL
 *  matches #1733's Codex gateway consumer (OPENROUTER_BASE_URL). */
const openrouterAdapter: ProviderValidationAdapter = {
  validate: (key, opts) =>
    probeGet(
      "https://openrouter.ai/api/v1/key",
      { Authorization: `Bearer ${key}` },
      opts,
      classifyStandard
    ),
};

/** Google Generative Language (Gemini): GET /v1beta/models?key=<key>. */
const geminiAdapter: ProviderValidationAdapter = {
  validate: (key, opts) =>
    probeGet(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      {},
      opts,
      classifyGemini
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
      return prior === "valid" ? "valid" : "unverified";
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
}

/**
 * Validate the stored key with the given `id`: TTL-cache gate → provider probe →
 * state transition → persist. Returns the updated {@link StoredApiKey} (for the
 * route to redact). Never returns or logs the plaintext key.
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

  const entries = settings.apiKeys ?? [];
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return { ok: false, reason: "not_found" };
  const entry = entries[idx];

  // TTL cache gate (R7): a recent validation short-circuits the probe entirely.
  if (entry.lastValidatedAt) {
    const last = Date.parse(entry.lastValidatedAt);
    if (!Number.isNaN(last) && now() - last < ttlMs) {
      return { ok: true, entry };
    }
  }

  // Probe via the provider adapter (or "unsupported" when none is registered).
  const adapter = getAdapter(entry.provider);
  const outcome: ProbeOutcome = adapter
    ? await adapter.validate(entry.key, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
      })
    : "unsupported";

  const updated: StoredApiKey = {
    ...entry,
    status: applyTransition(entry.status, outcome),
    lastValidatedAt: new Date(now()).toISOString(),
  };
  const next: Settings = {
    ...settings,
    apiKeys: entries.map((e, i) => (i === idx ? updated : e)),
  };
  await writeSettings(settingsFile, next);
  return { ok: true, entry: updated };
}
