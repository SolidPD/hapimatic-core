// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sentry event scrub helpers — shared between server and web.
 *
 * Pure logic with no Sentry SDK dependency. The walker functions take generic
 * `unknown` / `string` / `Record<string, unknown>` types so this module compiles
 * against zod-only deps and remains usable from both `@sentry/core` (server) and
 * `@sentry/react` (web) consumers via their `scrubEvent` / `scrubBreadcrumb`
 * wrappers. See #1142.
 *
 * Six callers depend on this module:
 *   1. server Sentry beforeSend           (server/src/sentry.ts)
 *   2. server Sentry beforeSendTransaction (server/src/sentry.ts)
 *   3. server Hono access logger          (#1062 — via scrubString re-export)
 *   4. server /error-reports intake        (#1062 — via scrubString re-export)
 *   5. web Sentry beforeSend / beforeSendTransaction / beforeBreadcrumb
 *   6. server message persistence          (#1587 — via scrubAnthropicTokens,
 *      `server/src/store/messages.ts` addMessage, masks sk-ant-… before writing
 *      transcript content to hapi.db)
 *
 * Future security fixes to the regex patterns or sensitive-name set apply
 * automatically to all callers — that's the point of the extraction.
 */

/**
 * Field names whose values must always be redacted, regardless of shape.
 * Case-insensitive match. Used by `scrubUrl` (query params), `scrubKv`
 * (recursive object walker), and `scrubRequestBody` (request body fields).
 * See #1058.
 */
// Names are stored in the post-normalization form (lowercased, hyphens and
// underscores stripped) — see `isSensitiveName`. Adding `api_key` here would
// be redundant with `apikey` for the same reason.
//
// Note: deliberately does NOT include `"session"` because that key is used
// by Sentry's release-health context (`event.contexts.session`) for
// non-secret tracking metadata. The token risk is captured by `sessiontoken`.
export const SENSITIVE_FIELD_NAMES = new Set([
  "token",
  "password",
  "passwd",
  "auth",
  "authorization",
  "cookie",
  "secret",
  "apitoken",
  "cliapitoken",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "bearer",
  "sessiontoken",
]);

/**
 * Maximum recursion depth for `scrubKv` to prevent runaway walks.
 * Sentry events nest up to ~8 levels in practice
 * (`event.contexts.runtime.versions.<lib>.commit.author.email` is 8 deep);
 * 10 leaves headroom while still bounding work on circular/deep payloads.
 */
export const MAX_SCRUB_DEPTH = 10;

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(name.toLowerCase().replace(/[_-]/g, ""));
}

/**
 * Redact Anthropic secret tokens from a string. These have the shape
 * `sk-ant-<type><NN>-<long-tail>` — e.g. `sk-ant-oat01-…` (the
 * `CLAUDE_CODE_OAUTH_TOKEN` injected per-session by multi-account binding,
 * #1446), `sk-ant-api03-…` (an API key), or `sk-ant-ort01-…` (a refresh token).
 *
 * Why this exists (#1587): a session that echoes its environment (e.g. `env`,
 * `echo $CLAUDE_CODE_OAUTH_TOKEN`) lands the token in a `tool_result`
 * transcript line, which the CLI relays and the server persists into `hapi.db`.
 * Masking here — wired into {@link scrubString} (Sentry / error-report
 * surfaces) and applied at the persistence boundary
 * (`server/src/store/messages.ts` `addMessage`) — prevents the plaintext from
 * being stored.
 *
 * Two passes: a PRECISE pattern keeps the `sk-ant-<type><NN>-` prefix for
 * diagnosability and masks the secret tail; a defensive GENERIC pattern
 * (requiring a 16+ char tail, so short non-secret `sk-ant-…` strings such as
 * `sk-ant-api03-docs` are NOT matched) catches future token type-segments. The
 * `[REDACTED]` marker is JSON-safe (no quotes/backslashes), so callers that
 * scrub a serialized-JSON blob can re-parse the result — the generic pass also
 * cannot re-match the precise pass's output because `[` falls outside the tail
 * char-class.
 */
export function scrubAnthropicTokens(s: string): string {
  if (typeof s !== "string") return s;
  return s
    .replace(/sk-ant-([a-z]+\d{2})-[A-Za-z0-9_-]{8,}/g, "sk-ant-$1-[REDACTED]")
    .replace(/sk-ant-[A-Za-z0-9]{2,}-[A-Za-z0-9_-]{16,}/g, "sk-ant-[REDACTED]");
}

/**
 * Redact NON-Anthropic provider API keys from a string — OpenAI / OpenRouter
 * (`sk-…`, including `sk-or-v1-…` and `sk-proj-…`) and Google Gemini (`AIza…`).
 *
 * Why this exists (B4 #1957, defense-in-depth): the conversational
 * key-registration flow is designed so the secret NEVER enters the conversation
 * (Architecture S — the secret is typed into a secure client-side card and
 * POSTed straight to the server, exactly once). This scrubber is the SECONDARY
 * net: if a user nonetheless pastes a provider key into chat, masking it here
 * keeps the plaintext out of the persisted transcript (`hapi.db`) AND the SSE
 * re-broadcast — the same boundary {@link scrubAnthropicTokens} (#1587) guards
 * for Anthropic tokens, which previously covered ONLY `sk-ant-…`.
 *
 * False-positive guard: the `sk-` pattern requires a 20+ char tail (a real
 * provider key is far longer) and a `(?!ant-)` lookahead so it never double-
 * touches an Anthropic token (run {@link scrubAnthropicTokens} first). The
 * `[REDACTED]` marker is JSON-safe and falls outside the tail char-class, so the
 * pattern cannot re-match its own output.
 */
export function scrubProviderSecrets(s: string): string {
  if (typeof s !== "string") return s;
  return s
    .replace(/sk-(?!ant-)[A-Za-z0-9_-]{20,}/g, "sk-[REDACTED]")
    .replace(/AIza[A-Za-z0-9_-]{35}/g, "AIza[REDACTED]");
}

/**
 * Redact age SECRET keys (`AGE-SECRET-KEY-1…`, plus the post-quantum
 * `AGE-SECRET-KEY-PQ-1…` variant) from a string.
 *
 * Why this exists (issue #2341, Config Porter epic #2339): the instance-held
 * porter age identity (`server/src/config/porterAgeKeys.ts`) is the private key
 * whose disclosure lets a holder decrypt every archive encrypted to the
 * instance, and whose loss makes previously-imported archives permanently
 * undecryptable. The PRIMARY control is structural — the identity never leaves
 * `porterAgeKeys.ts` and is never returned or logged — but this shape-based
 * scrubber is the defense-in-depth net: if an identity ever lands in a Sentry
 * event, log line, or persisted transcript (e.g. an accidental error-path
 * interpolation), masking it here keeps the plaintext key out of Sentry AND
 * `hapi.db`.
 *
 * Shape-based, NOT field-name-based: the identity's settings field name
 * (`identity`) is too generic to add to {@link SENSITIVE_FIELD_NAMES} without
 * redacting unrelated `identity` fields elsewhere. The `AGE-SECRET-KEY-` Bech32
 * prefix is distinctive; requiring a 40+ char tail avoids matching the bare
 * prefix. The `[REDACTED]` marker is JSON-safe and falls outside the tail
 * char-class, so the pattern cannot re-match its own output.
 */
export function scrubAgeSecretKey(s: string): string {
  if (typeof s !== "string") return s;
  return s.replace(
    /AGE-SECRET-KEY-(?:PQ-)?1[0-9A-Z]{40,}/g,
    "AGE-SECRET-KEY-[REDACTED]"
  );
}

/**
 * Mask ALL known secret tokens (Anthropic + non-Anthropic provider keys + age
 * secret keys) from a string. Anthropic runs first so its prefix-preserving
 * redaction lands before the generic provider pass; the age pass is independent
 * (disjoint prefix). Used at the message-persistence boundary
 * (`server/src/store/messages.ts` `addMessage`, B4 #1957) and composed into
 * {@link scrubString}.
 */
export function scrubSecretTokens(s: string): string {
  if (typeof s !== "string") return s;
  return scrubAgeSecretKey(scrubProviderSecrets(scrubAnthropicTokens(s)));
}

/**
 * Scrub bearer tokens, JWTs, `?token=...` query params, and Anthropic secret
 * tokens (`sk-ant-…`, via {@link scrubAnthropicTokens}) from a string.
 * Minimal inline scrubber — for the comprehensive event-level scrubber
 * (URL parser, stack frame contexts, recursive walker over tags/extra/
 * contexts/request body) see `scrubEvent` in each consumer (#1058).
 *
 * Exported so other ingress points (Hono logger, error-report intake)
 * can apply the same redaction before persisting to logs/DB. See #1062.
 */
export function scrubString(s: string): string {
  if (typeof s !== "string") return s;
  return scrubSecretTokens(
    s
      // `\\` is excluded so the match can never consume a JSON escape (e.g. the
      // `\` of `\"` when a caller scrubs serialized JSON) — #4053.
      .replace(/([?&])token=[^&#\s"'\\]+/gi, "$1token=[REDACTED]")
      .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]")
      .replace(/\beyJ[A-Za-z0-9._\-+/=]{20,}/g, "[JWT-REDACTED]")
  );
}

/**
 * Mask secret classes that only the transcript browser needs (#4053): GitHub
 * tokens, AWS credentials, Telegram bot tokens, Hapimatic `cliApiToken`
 * values carried in a JSON key or an env assignment, and the rp1-home approval
 * nonce `USER-APPROVAL-XXXX-XXXX` (#4386).
 *
 * Deliberately NOT part of {@link scrubSecretTokens}: that function runs at the
 * message-persistence boundary, where a false positive would permanently
 * rewrite stored chat. These patterns only ever touch served/indexed copies.
 * The AWS secret key is matched only in its `aws_secret_access_key` context —
 * a bare 40-char base64 rule would mask git blobs and hashes. The optional
 * `\\?` in the JSON-key forms covers double-encoded JSON (a stringified tool
 * input). The `CLI_API_TOKEN=` rule skips `$VAR`, `<placeholder>` and an
 * already-masked `[REDACTED]`.
 */
function scrubTranscriptOnlyPatterns(s: string): string {
  return (
    s
      .replace(/\bgh([pousr])_[A-Za-z0-9]{36,}\b/g, "gh$1_[REDACTED]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}/g, "github_pat_[REDACTED]")
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]")
      .replace(
        /((?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\\?["']?\s*[=:]\s*\\?["']?)[A-Za-z0-9/+=]{40}/g,
        "$1[REDACTED]"
      )
      .replace(/\b(\d{8,10}):[A-Za-z0-9_-]{35}\b/g, "$1:[REDACTED]")
      .replace(/(\\?"cliApiToken\\?"\s*:\s*\\?")[^"\\]{8,}/g, "$1[REDACTED]")
      .replace(/\b(CLI_API_TOKEN=)(?![$<[])[^\s"'\\]{8,}/g, "$1[REDACTED]")
      // #4386: the rp1-home approval nonce (consumed or not — simpler and strictly
      // safer than tracking consumption). The acceptor form `[A-Z2-9]`
      // (server/src/services/approvalTokens.ts:71) is a strict superset of the
      // canonical generator class `[A-HJ-NP-Z2-9]`, so one pattern masks both; the
      // literal placeholder `USER-APPROVAL-XXXX-XXXX` is masked too (accepted
      // over-masking). Char classes exclude `"` and `\`, so a serialized-JSON
      // escape is never consumed.
      .replace(
        /USER-APPROVAL-[A-Z2-9]{4}-[A-Z2-9]{4}/g,
        "USER-APPROVAL-[REDACTED]"
      )
  );
}

/** Replace every occurrence of each known secret literal (≥ 20 chars). */
function maskLiterals(s: string, literals: readonly string[]): string {
  let out = s;
  for (const lit of literals) {
    if (typeof lit === "string" && lit.length >= 20 && out.includes(lit)) {
      out = out.split(lit).join("[REDACTED-TOKEN]");
    }
  }
  return out;
}

/**
 * The transcript browser's scrub (#4053): exact known secret literals (this
 * node's instance `cliApiToken` values, which sessions print bare) first, then
 * everything {@link scrubString} masks, then {@link scrubTranscriptOnlyPatterns}.
 * `scrubString` runs on the output of a pure removal, so this is a superset of
 * it by construction.
 */
export function scrubTranscriptSecrets(
  s: string,
  literals: readonly string[] = []
): string {
  if (typeof s !== "string") return s;
  // Literals FIRST: a pattern that masked part of a known token (e.g. an
  // `sk-…` run inside it) would leave the rest unmatched by the exact literal.
  return scrubTranscriptOnlyPatterns(scrubString(maskLiterals(s, literals)));
}

/**
 * Extra characters scrubbed past a cap before cutting (#4053). A secret that
 * straddles the cap is then whole when scrubbed, so the kept prefix never
 * carries an unmatched fragment of it.
 */
const SCRUB_CAP_MARGIN = 1024;

/**
 * Scrub, THEN cap (#4053) — never cap first: a cut token no longer matches its
 * pattern. Scrubs a `cap + 1024`-char window, so a multi-megabyte input never
 * runs through the full regex set.
 */
export function scrubThenCap(
  s: string,
  cap: number,
  literals: readonly string[] = []
): string {
  if (cap <= 0) return "";
  return scrubTranscriptSecrets(
    s.slice(0, cap + SCRUB_CAP_MARGIN),
    literals
  ).slice(0, cap);
}

/**
 * Scrub a parsed JSON value for serving (#4053): every string VALUE passes
 * through {@link scrubTranscriptSecrets} and a string under a sensitive key is
 * redacted outright. The regexes never see JSON syntax, so an escaped quote or
 * newline can no longer be consumed. Builds a new value (the input is not
 * mutated) with an explicit stack and no depth cap — parsed JSON is acyclic,
 * and {@link scrubKv}'s depth cap would return deep transcript content
 * unscrubbed.
 */
export function scrubTranscriptValue(
  value: unknown,
  literals: readonly string[] = []
): unknown {
  const scrubLeaf = (v: unknown): unknown =>
    typeof v === "string" ? scrubTranscriptSecrets(v, literals) : v;
  if (value === null || typeof value !== "object") return scrubLeaf(value);
  const root: unknown = Array.isArray(value) ? [] : {};
  const stack: Array<{ src: unknown; dst: unknown }> = [
    { src: value, dst: root },
  ];
  while (stack.length > 0) {
    const { src, dst } = stack.pop()!;
    const entries: Array<[string | number, unknown]> = Array.isArray(src)
      ? src.map((v, i): [number, unknown] => [i, v])
      : Object.entries(src as Record<string, unknown>);
    for (const [key, v] of entries) {
      let out: unknown;
      if (v !== null && typeof v === "object") {
        out = Array.isArray(v) ? [] : {};
        stack.push({ src: v, dst: out });
      } else if (
        typeof key === "string" &&
        typeof v === "string" &&
        isSensitiveName(key)
      ) {
        out = "[REDACTED]";
      } else {
        out = scrubLeaf(v);
      }
      // A parsed `"__proto__"` key is an own property; plain assignment would
      // set the prototype instead of copying it.
      Object.defineProperty(dst, key, {
        value: out,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return root;
}

/**
 * Parse a URL and redact query/fragment values whose param names match the
 * sensitive set. Other values still pass through `scrubString` to catch
 * token-shaped values (e.g. `?ref=eyJabc...`). Defense-in-depth: known names
 * are redacted unconditionally, unknown names get token-shape scrubbing.
 * See #1058 R2.
 */
/** Base synthesized for relative inputs so `new URL()` can parse them (RFC 2606 reserved TLD). */
const SYNTHETIC_RELATIVE_BASE = "http://internal.invalid";

export function scrubUrl(input: string): string {
  if (typeof input !== "string") return input;
  let url: URL;
  // URL constructor needs an absolute URL — synthesize a base for relative paths.
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(input);
  try {
    url = new URL(input, isAbsolute ? undefined : SYNTHETIC_RELATIVE_BASE);
  } catch {
    // Fall back to regex scrub for malformed URLs.
    return scrubString(input);
  }
  for (const [k, v] of Array.from(url.searchParams.entries())) {
    if (isSensitiveName(k)) {
      url.searchParams.set(k, "[REDACTED]");
    } else {
      url.searchParams.set(k, scrubString(v));
    }
  }
  if (url.hash && url.hash.length > 1) {
    // Fragments can contain `#access_token=...` (OAuth implicit flow) OR
    // bare token-shaped values (e.g. `#eyJabc...` as a hash router anchor).
    const fragParams = new URLSearchParams(url.hash.slice(1));
    let fragChanged = false;
    for (const [k, v] of Array.from(fragParams.entries())) {
      if (isSensitiveName(k)) {
        fragParams.set(k, "[REDACTED]");
        fragChanged = true;
      } else {
        const scrubbed = scrubString(v);
        if (scrubbed !== v) {
          fragParams.set(k, scrubbed);
          fragChanged = true;
        }
      }
    }
    if (fragChanged) {
      url.hash = "#" + fragParams.toString();
    } else {
      // Final scrubString pass on the raw hash catches bare token-shaped
      // fragments that the URLSearchParams round-trip didn't recognize as
      // a key=value pair (e.g. `#eyJabc.def.ghijklmnop...`).
      const rawScrubbed = scrubString(url.hash);
      if (rawScrubbed !== url.hash) url.hash = rawScrubbed;
    }
  }
  // URLSearchParams percent-encodes brackets in our redaction markers.
  // Decode them back so the markers are readable in Sentry UI / logs.
  let out = url
    .toString()
    .replace(/%5BREDACTED%5D/g, "[REDACTED]")
    .replace(/%5BJWT-REDACTED%5D/g, "[JWT-REDACTED]");
  // Strip the synthesized base ONLY when the input was relative. A prefix test
  // alone would also truncate an absolute URL whose host merely starts with
  // the base (`http://internal.invalid.example/…`) — CodeQL
  // js/incomplete-url-substring-sanitization, hapimatic-core #20.
  if (!isAbsolute && out.startsWith(SYNTHETIC_RELATIVE_BASE)) {
    out = out.slice(SYNTHETIC_RELATIVE_BASE.length);
  }
  return out;
}

/**
 * Recursively walk a value, scrubbing sensitive fields and token-shaped
 * strings. Stops at MAX_SCRUB_DEPTH to bound work on circular/deep events.
 * See #1058 R1, R3.
 */
export function scrubKv(value: unknown, depth = 0): unknown {
  if (depth >= MAX_SCRUB_DEPTH) {
    // Stop recursing into objects/arrays past the depth cap, but still
    // scrub leaf strings — otherwise a JWT at depth 6 would leak verbatim.
    return typeof value === "string" ? scrubString(value) : value;
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map(item => scrubKv(item, depth + 1));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (isSensitiveName(k)) {
        out[k] =
          typeof v === "string" ? "[REDACTED]" : v != null ? "[REDACTED]" : v;
      } else {
        out[k] = scrubKv(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Walk stack frames (`exception.values[].stacktrace.frames[]`) and scrub
 * source-line context (pre_context / context_line / post_context) plus
 * frame `vars`. These commonly contain interpolated locals like
 * `authenticate(token=eyJabc...)`. See #1058 R3.
 *
 * Mutates frames in place; callers pass the array directly from
 * `event.exception.values[].stacktrace.frames`.
 */
export function scrubFrames(frames: unknown): void {
  if (!Array.isArray(frames)) return;
  for (const frame of frames) {
    if (!frame || typeof frame !== "object") continue;
    const f = frame as Record<string, unknown>;
    if (typeof f.context_line === "string") {
      f.context_line = scrubString(f.context_line);
    }
    if (Array.isArray(f.pre_context)) {
      f.pre_context = (f.pre_context as unknown[]).map(line =>
        typeof line === "string" ? scrubString(line) : line
      );
    }
    if (Array.isArray(f.post_context)) {
      f.post_context = (f.post_context as unknown[]).map(line =>
        typeof line === "string" ? scrubString(line) : line
      );
    }
    if (f.vars && typeof f.vars === "object") {
      f.vars = scrubKv(f.vars) as Record<string, unknown>;
    }
  }
}
