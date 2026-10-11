// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Canonical API-error class taxonomy (#2487, epic #2488 Sub-Issue D:
 * catch-all API-error recovery).
 *
 * ONE vocabulary crosses every boundary. The detector (`cli`) canonicalizes the
 * raw SDK error strings to these canonical, Anthropic-style names BEFORE the
 * recovery gate (`server`), the per-class preference map, or the Preferences UI
 * (`web`) ever see them — so a per-class opt-out the user can see always has
 * effect (ruling D3 / R8). Legacy raw values already in flight still resolve to
 * the same class via {@link canonicalizeErrorType}.
 *
 * "Recovery" here means auto-injecting a resume prompt into the affected
 * session (the highest-risk mechanism in the epic). A class is one of:
 *   - `recover`      — a transient error a resume prompt can plausibly clear
 *     (overload, rate-limit, 5xx, connection drop). Auto-recovers by default.
 *   - `notify-only`  — a deterministic / external-action error a resume prompt
 *     CANNOT fix (a dead token, a spent credit, a request that will fail
 *     identically). Surfaces the existing exhausted-event notification but does
 *     NOT inject a prompt; the user CAN force-enable recovery per class (R5/R6).
 *   - `terminal`     — an error no retry can clear before a known future date
 *     (#4936: an API spend cap or a user-set spend limit). Never dispatches a
 *     prompt and is NOT force-enableable; the session gets a durable stop
 *     notice instead (`SpendLimitNoticeObserver`, server).
 *
 * An UNRECOGNIZED class (a future Anthropic error type with no row here) is
 * treated as recover-by-default — the widest possible catch-all, matching the
 * epic's maximal-coverage ruling (finding 2).
 */

/**
 * Default policy for a class: auto-recover, notify without dispatching, or
 * stop terminally (never dispatch, never force-enableable).
 */
export type ApiErrorRecoveryPolicy = "recover" | "notify-only" | "terminal";

export interface ApiErrorClass {
  /** Canonical Anthropic-style error-type name — the ONE wire vocabulary. */
  readonly canonical: string;
  /**
   * Raw SDK strings that canonicalize to this class. Empty when the class is
   * minted by the detector's text-signature branch (`connection_error`) or has
   * no verified raw alias yet (a deterministic class that rarely reaches the
   * message stream). The canonical name is always included so a value that is
   * ALREADY canonical resolves to itself.
   */
  readonly rawAliases: readonly string[];
  /** Default recovery policy (R5). */
  readonly defaultPolicy: ApiErrorRecoveryPolicy;
  /** Human-facing label for the Preferences per-class list. */
  readonly label: string;
  /** Optional HTTP-status hint shown in the label / docs. */
  readonly httpHint?: string;
}

/**
 * The canonical class list. Raw aliases are grounded in the verified SDK
 * vocabulary at `cli/src/claude/types.ts` (`rate_limit`, `server_error`,
 * `overloaded_error`, `authentication_failed`, `unknown`) plus each class's own
 * canonical name. `connection_error` is minted by the detector's text-signature
 * branch (#2487 Task 2) — no raw alias. The deterministic notify-only trio
 * (auth / invalid-request / billing) is documented per R5 even where a raw
 * alias has not been observed on the wire, so its policy is defined and
 * force-enableable rather than silently defaulting to recover-by-default.
 */
export const API_ERROR_CLASSES: readonly ApiErrorClass[] = [
  {
    canonical: "overloaded_error",
    rawAliases: ["overloaded_error"],
    defaultPolicy: "recover",
    label: "API overloaded",
    httpHint: "529",
  },
  {
    canonical: "rate_limit_error",
    rawAliases: ["rate_limit", "rate_limit_error"],
    defaultPolicy: "recover",
    label: "Rate limited",
    httpHint: "429",
  },
  {
    canonical: "api_error",
    rawAliases: ["server_error", "api_error"],
    defaultPolicy: "recover",
    label: "Server error",
    httpHint: "500",
  },
  {
    canonical: "connection_error",
    // Minted by the detector's text-signature branch (the Claude-Code-authored
    // "API Error: Connection closed mid-response …" notice). No raw SDK alias.
    rawAliases: ["connection_error"],
    defaultPolicy: "recover",
    label: "Connection dropped / stream closed",
  },
  {
    canonical: "authentication_error",
    // Collapses 401 (`authentication_error`) and 403 (`permission_error`) into
    // one auth class — both are notify-only (a resume prompt cannot fix a dead
    // token / a denied permission).
    rawAliases: [
      "authentication_failed",
      "authentication_error",
      "permission_error",
    ],
    defaultPolicy: "notify-only",
    label: "Authentication / permission",
    httpHint: "401/403",
  },
  {
    canonical: "invalid_request_error",
    rawAliases: ["invalid_request_error"],
    defaultPolicy: "notify-only",
    label: "Invalid request",
    httpHint: "400",
  },
  {
    canonical: "billing_error",
    rawAliases: ["billing_error"],
    defaultPolicy: "notify-only",
    label: "Billing / credit exhausted",
  },
  {
    // #4936: assigned when the shared classifier (`classifyApiLimitSignal`
    // below) returns `spend-limit` — by the CLI `ApiErrorDetector` and by the
    // server `/cli/error-reports` re-check of an older CLI's report — for an
    // API spend cap (`error.details.error_code: "enforced_spend_limit_reached"`)
    // and the two user-set spend-limit 400s. No raw SDK alias — Claude Code
    // reports these as `rate_limit` / `unknown`.
    canonical: "spend_limit_error",
    rawAliases: ["spend_limit_error"],
    defaultPolicy: "terminal",
    label: "API spend cap / spend limit",
    httpHint: "429/400",
  },
  {
    canonical: "unknown",
    rawAliases: ["unknown"],
    defaultPolicy: "recover",
    label: "Unknown / uncategorized",
  },
] as const;

/**
 * raw SDK string → canonical class name (built from every class's `rawAliases`,
 * which include the canonical name itself). Frozen so no caller can mutate the
 * shared lookup.
 */
export const RAW_TO_CANONICAL: Readonly<Record<string, string>> = Object.freeze(
  API_ERROR_CLASSES.reduce<Record<string, string>>((acc, cls) => {
    for (const raw of cls.rawAliases) acc[raw] = cls.canonical;
    return acc;
  }, {})
);

/**
 * Canonicalize a raw/SDK error-type string to its canonical class. A value that
 * is already canonical is returned unchanged (each canonical name is its own
 * alias); an unrecognized value passes through untouched (the recovery gate
 * treats an unknown key as recover-by-default — the widest catch-all, R2 /
 * finding 2). `undefined` → `undefined`.
 */
export function canonicalizeErrorType(
  value: string | undefined
): string | undefined {
  if (value === undefined) return undefined;
  return RAW_TO_CANONICAL[value] ?? value;
}

/**
 * Is this canonical class recover-by-default? A class whose `defaultPolicy`
 * is `notify-only` or `terminal` (#4936) returns `false`; a `recover` class AND
 * an unrecognized class with no taxonomy row return `true` (recover-by-default
 * is the widest possible catch-all, matching the epic's maximal-coverage
 * ruling). A recovery gate must test `isTerminalClass` FIRST, because a
 * terminal class is never force-enableable.
 */
export function isRecoverByDefaultClass(canonical: string): boolean {
  const known = API_ERROR_CLASSES.find(c => c.canonical === canonical);
  if (!known) return true; // unrecognized → widest catch-all
  return known.defaultPolicy === "recover";
}

/**
 * Is this canonical class terminal (#4936)? A terminal class never dispatches
 * a recovery prompt and cannot be force-enabled by a per-class override — the
 * recovery gate must test this BEFORE it reads any preference.
 */
export function isTerminalClass(canonical: string): boolean {
  const known = API_ERROR_CLASSES.find(c => c.canonical === canonical);
  return known?.defaultPolicy === "terminal";
}

// ---------------------------------------------------------------------------
// The single API-limit classification point (#4936)
// ---------------------------------------------------------------------------
//
// ONE pure function decides which of three outcomes an API-limit error feeds:
//   - `spend-limit`  → the terminal stop (#4936): an API spend cap or a
//                      user-set spend limit; no retry can succeed before the
//                      date the API reports.
//   - `usage-window` → the subscription session/weekly limit that latches the
//                      "rate-limited — resets …" chip (`RateLimitDetector`) and
//                      that #3612's reset-time nudge hangs off.
//   - `none`         → everything else, including a per-minute rate limit and
//                      an overload, which keep the existing recovery ladder.
// Callers: the CLI `ApiErrorDetector` and `RateLimitDetector`, and the server
// `/cli/error-reports` bridge (re-classifying reports from older CLIs).

/** `error.details.error_code` the Anthropic API sends when a tier's monthly
 *  spend cap is reached (HTTP 429, `rate_limit_error`, no `retry-after`). */
export const SPEND_CAP_ERROR_CODE = "enforced_spend_limit_reached";

/** Which spend limit stopped the request. */
export const SPEND_LIMIT_VARIANTS = [
  "tier-cap",
  "org-limit",
  "workspace-limit",
] as const;
export type SpendLimitVariant = (typeof SPEND_LIMIT_VARIANTS)[number];

/** Lower-cased message phrases (Anthropic rate-limits docs, 2026-10-09).
 *  Test-pinned: a reword fails a test instead of silently mis-classifying. */
export const SPEND_CAP_TEXT = "you have reached your api usage limits";
export const SPEND_LIMIT_ORG_TEXT =
  "you have reached your specified api usage limits";
export const SPEND_LIMIT_WORKSPACE_TEXT =
  "you have reached your specified workspace api usage limits";

/**
 * Substrings identifying a subscription session/usage window. The source of
 * `rateLimitDetector.ts`'s `SESSION_LIMIT_SUBSTRINGS` (re-exported there).
 * Note "usage limit" also matches "API usage limits", which is why the text
 * test below is private and only reachable after the spend-limit rules.
 */
export const USAGE_WINDOW_SUBSTRINGS = ["session limit", "usage limit"];

/** What a caller extracted from one API-error record. */
export interface ApiLimitSignal {
  /** HTTP status, from a structured field or the rendered text. */
  status?: number;
  /** The API's `error.details.error_code`, when the host received it. */
  errorCode?: string;
  /** The rendered error text (Claude Code's `API Error: …` line). */
  text?: string;
}

export type ApiLimitClass =
  | {
      kind: "spend-limit";
      variant: SpendLimitVariant;
      /** Epoch ms the API says access resumes; `null` when not reported. */
      resumesAt: number | null;
    }
  | { kind: "usage-window" }
  | { kind: "none" };

const RESUME_DATE_PRESENT = /regain access on \d{4}-\d{2}-\d{2}/i;
const RESUME_INSTANT =
  /regain access on (\d{4})-(\d{2})-(\d{2}) at (\d{2}):(\d{2}) UTC/i;

/**
 * Parse the API's resume instant ("You will regain access on 2026-09-01 at
 * 00:00 UTC.") to epoch ms. Only that exact form is accepted; anything else is
 * `null` — the stop message must never show a guessed date.
 */
export function parseSpendLimitResume(text: string): number | null {
  const m = text.match(RESUME_INSTANT);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;
  const epoch = Date.UTC(year, month - 1, day, hour, minute);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
}

/**
 * HTTP status from Claude Code's rendered error text: an API-key 429 renders
 * "API Error: Request rejected (429) · …"; the generic branch renders
 * "API Error: 400 …". `undefined` when neither form is present.
 */
export function statusFromApiErrorText(text: string): number | undefined {
  const rejected = text.match(/Request rejected \((\d{3})\)/);
  if (rejected) return Number(rejected[1]);
  const generic = text.match(/^\s*API Error: (\d{3})\b/);
  if (generic) return Number(generic[1]);
  return undefined;
}

/**
 * The subscription usage-window text test, moved verbatim from
 * `rateLimitDetector.ts` (`isSessionLimitText`). Private on purpose: callers go
 * through `classifyApiLimitSignal` so the spend-limit rules always run first.
 */
function isUsageWindowText(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  // The transient "(not your usage limit)" throttle must not match — the
  // "usage limit" substring below would otherwise false-positive on it.
  if (lower.includes("not your usage limit")) return false;
  if (/\bresets\b/.test(lower)) return true;
  return USAGE_WINDOW_SUBSTRINGS.some(sub => lower.includes(sub));
}

/**
 * Classify one API-limit signal. Precedence (first match wins):
 *   1. structured `errorCode === "enforced_spend_limit_reached"` → tier-cap
 *   2. HTTP 400 + "specified workspace API usage limits"          → workspace-limit
 *   3. HTTP 400 + "specified API usage limits"                    → org-limit
 *   4. HTTP 429 + "your API usage limits" + "regain access on <date>" → tier-cap
 *      (text fallback when the host did not receive the code)
 *   5. HTTP 429 + subscription usage-window text                  → usage-window
 *   6. anything else                                              → none
 * Rules 2–3 are gated on HTTP 400 so the Claude Code workspace-limit 429 (which
 * carries `retry-after`) stays out of the terminal class.
 */
export function classifyApiLimitSignal(signal: ApiLimitSignal): ApiLimitClass {
  const text = signal.text ?? "";
  const lower = text.toLowerCase();
  const resumesAt = () => parseSpendLimitResume(text);

  if (signal.errorCode === SPEND_CAP_ERROR_CODE) {
    return { kind: "spend-limit", variant: "tier-cap", resumesAt: resumesAt() };
  }
  if (signal.status === 400) {
    if (lower.includes(SPEND_LIMIT_WORKSPACE_TEXT)) {
      return {
        kind: "spend-limit",
        variant: "workspace-limit",
        resumesAt: resumesAt(),
      };
    }
    if (lower.includes(SPEND_LIMIT_ORG_TEXT)) {
      return {
        kind: "spend-limit",
        variant: "org-limit",
        resumesAt: resumesAt(),
      };
    }
  }
  if (signal.status === 429) {
    if (lower.includes(SPEND_CAP_TEXT) && RESUME_DATE_PRESENT.test(text)) {
      return {
        kind: "spend-limit",
        variant: "tier-cap",
        resumesAt: resumesAt(),
      };
    }
    if (isUsageWindowText(text)) return { kind: "usage-window" };
  }
  return { kind: "none" };
}
