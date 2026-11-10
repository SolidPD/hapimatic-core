// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Prompt-injection heuristics for catalog skill / plugin markdown (issue #3131, Sub Q).
 *
 * A NAMED, documented pattern set (KD3 / R2) that scans skill+plugin content for the
 * three prompt-injection shapes the Snyk "ToxicSkills" research surfaced (injection in
 * ~1/3 of tested marketplace skills):
 *
 *   1. imperative-override — "ignore previous instructions", tool-forcing, exfil orders
 *   2. exfil URLs — outbound to paste/webhook/collaborator hosts, or raw-IP endpoints
 *   3. hidden instructions — zero-width characters, HTML-comment-buried directives,
 *      long opaque encoded blobs
 *
 * Every match is a {@link ScanFinding} whose `rule` is the NAMED rule id (R2 / AC
 * "named finding") and whose `message` is a human-readable description that cites the
 * matched excerpt.
 *
 * 🔴 HONESTY (R6 — the security core): this is DEFENSE-IN-DEPTH, not a guarantee. The
 * heuristic set is deliberately conservative (an adversary adapts); {@link
 * INJECTION_KNOWN_GAPS} enumerates what it does NOT catch, and the caller MUST surface
 * that list so a clean result is never read as a safety guarantee. Pair with the
 * `jules-scan.yml` LLM auditor for depth.
 *
 * The pinned finding shape (`ScanFinding`) lives in `@hapi/protocol`
 * (`shared/src/harnessRecipe.ts`); this module does NOT re-declare it. Regex matching
 * uses `String.match`/`matchAll` (never the `RegExp` method the security-guidance hook
 * flags as a `child_process` false-positive).
 */
import type { ScanFinding } from "@hapi/protocol";

/**
 * What the injection heuristics do NOT catch (R6). Surfaced verbatim by the verdict UI
 * and returned to callers so a green result is never presented as comprehensive.
 */
export const INJECTION_KNOWN_GAPS: readonly string[] = [
  "Novel or reworded injection phrasings not in the pattern set (the adversary adapts).",
  "Semantic / social-engineering attacks that carry no imperative-override keywords.",
  "Obfuscation beyond zero-width + base64 (hex escapes, homoglyphs, unicode tricks, split tokens).",
  "Payloads in non-markdown files (embedded images, PDFs, binaries) — only markdown/text is scanned.",
  "Runtime behavior — this is a STATIC scan; it cannot detect what a skill DOES when it runs.",
  "Multi-file or cross-reference attacks where no single file looks malicious in isolation.",
];

/**
 * Zero-width / invisible code points abused to hide instructions from a human reviewer.
 * Written as explicit escapes (not literal invisibles) so the source stays lint-clean and
 * the intent is legible: U+200B/C/D (zero-width space/non-joiner/joiner), U+2060 (word
 * joiner), U+FEFF (BOM / zero-width no-break space), U+180E (Mongolian vowel separator).
 *
 * One U+200D is exempt: the joiner inside an emoji ZWJ sequence (\uD83D\uDE4B\u200D\u2642\uFE0F, \uD83D\uDC69\uD83C\uDFFD\u200D\uD83D\uDCBB, \u2764\uFE0F\u200D\uD83D\uDD25), that is a
 * U+200D preceded by an Extended_Pictographic code point (optionally followed by VS16 or a
 * skin-tone modifier) AND followed by another. It glues two pictographs into one glyph and
 * can carry no hidden text (issue #3989). A U+200D missing a pictograph on either side
 * still fires, as does every other code point listed.
 */
const ZERO_WIDTH_RE =
  /\u200B|\u200C|(?<!\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]?)\u200D|\u200D(?!\p{Extended_Pictographic})|\u2060|\uFEFF|\u180E/u;

/** Excerpt a match to a bounded, single-line snippet for the finding message. */
function excerpt(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * A single named imperative-override / tool-forcing / exfil-order pattern. Ordered
 * broad→specific; the first-match-per-rule policy keeps one finding per rule per doc.
 */
interface OverridePattern {
  rule: string;
  severity: ScanFinding["severity"];
  re: RegExp;
  label: string;
}

const OVERRIDE_PATTERNS: readonly OverridePattern[] = [
  {
    rule: "injection.imperative-override",
    severity: "high",
    re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:all\s+)?(?:previous|prior|above|earlier|preceding|the\s+system|your)\b[^.\n]{0,20}\b(?:instructions?|prompts?|context|rules?|directions?)\b/i,
    label: "imperative override of prior instructions",
  },
  {
    rule: "injection.imperative-override",
    severity: "high",
    re: /\byou\s+are\s+now\b|\bnew\s+(?:instructions?|system\s+prompt|rules?)\s*:|\bsystem\s+prompt\s*:|\bassistant\s*:\s*(?:sure|of\s+course)/i,
    label: "role / system-prompt reassignment",
  },
  {
    rule: "injection.tool-forcing",
    severity: "high",
    re: /\byou\s+(?:must|should|need\s+to|have\s+to)\s+(?:run|execute|call|invoke|use\s+the)\b[^.\n]{0,40}\b(?:tool|command|bash|shell|function)\b|\balways\s+(?:run|execute|call)\b/i,
    label: "forced tool / command invocation",
  },
  {
    rule: "injection.exfil-order",
    severity: "high",
    re: /\b(?:send|post|upload|exfiltrate|leak|forward|transmit|email)\b[^.\n]{0,60}\b(?:credential|secret|token|api[\s-]?key|password|\.env|environment|conversation|history|to\s+https?:\/\/)/i,
    label: "instruction to exfiltrate sensitive data",
  },
  {
    rule: "injection.secrecy-order",
    severity: "medium",
    re: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention|reveal\s+to|show)\s+(?:the\s+)?(?:user|human|operator)\b/i,
    label: "instruction to hide activity from the user",
  },
];

/**
 * Known data-exfiltration / paste / out-of-band-collaborator hostnames. A URL to one of
 * these in skill content is a strong injection signal (the classic "post the user's
 * secrets to my webhook" pattern). NOT exhaustive — see {@link INJECTION_KNOWN_GAPS}.
 */
const EXFIL_HOST_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:webhook\.site|requestbin\.\w+|pipedream\.net|ngrok\.(?:io|app|dev)|pastebin\.com|hastebin\.com|paste\.ee|termbin\.com|transfer\.sh|0x0\.st|file\.io|oast\.\w+|burpcollaborator\.net|interact\.sh|canarytokens\.\w+)\b/i;

/** A raw-IP HTTP(S) endpoint — legitimate skills reference names, not bare IPs. */
const RAW_IP_URL_RE =
  /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/[^\s)]*)?/;

/** A long opaque base64-ish blob (>= 200 chars) — an easy carrier for a hidden payload. */
const BASE64_BLOB_RE = /[A-Za-z0-9+/]{200,}={0,2}/;

/** All HTML comments in a document (global) — scanned for buried imperative overrides. */
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;

/** Every rule id {@link scanForInjection} can emit, for callers that validate a rule name. */
export const INJECTION_RULES: readonly string[] = [
  "injection.imperative-override",
  "injection.tool-forcing",
  "injection.exfil-order",
  "injection.secrecy-order",
  "injection.exfil-url",
  "injection.hidden-zero-width",
  "injection.hidden-comment-instruction",
  "injection.encoded-blob",
];

/**
 * A finding plus where its match lies: the 1-based line it starts on and that line's full text
 * (no newline), and the line it ends on and the full text of every line it spans (newline-joined).
 * A match can cross a line break (a `\s+` pattern in wrapped text), so the premium release gate
 * pins a reviewed finding to `spanText`, never to the first line alone (issue #3989).
 */
export interface LocatedInjectionFinding extends ScanFinding {
  line: number;
  lineText: string;
  endLine: number;
  spanText: string;
}

/** The 1-based line and the full text of the line that contains `index`. */
function lineAt(
  content: string,
  index: number
): { line: number; lineText: string } {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const end = content.indexOf("\n", index);
  let line = 1;
  for (let i = content.indexOf("\n"); i !== -1 && i < start; ) {
    line++;
    i = content.indexOf("\n", i + 1);
  }
  return {
    line,
    lineText: content.slice(start, end === -1 ? content.length : end),
  };
}

/** The lines a match of `length` characters at `index` spans: first and last, and their text. */
function spanAt(
  content: string,
  index: number,
  length: number
): { line: number; lineText: string; endLine: number; spanText: string } {
  const last = index + Math.max(length, 1) - 1;
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const end = content.indexOf("\n", last);
  return {
    ...lineAt(content, index),
    endLine: lineAt(content, last).line,
    spanText: content.slice(start, end === -1 ? content.length : end),
  };
}

/**
 * {@link scanForInjection} with each finding's position: the same rules, the same
 * first-match-per-rule policy, the same messages, plus the lines that match spans.
 */
export function locateInjectionFindings(
  content: string,
  location?: string
): LocatedInjectionFinding[] {
  const findings: LocatedInjectionFinding[] = [];
  const seen = new Set<string>();
  const where = location ? ` in ${location}` : "";

  const add = (
    rule: string,
    severity: ScanFinding["severity"],
    detail: string,
    index: number,
    length: number
  ): void => {
    if (seen.has(rule)) return; // one finding per rule per document
    seen.add(rule);
    findings.push({
      severity,
      rule,
      message: `${detail}${where}`,
      ...spanAt(content, index, length),
    });
  };

  // 1. Imperative-override / tool-forcing / exfil-order patterns.
  for (const p of OVERRIDE_PATTERNS) {
    const m = content.match(p.re);
    if (m)
      add(
        p.rule,
        p.severity,
        `${p.label}: "${excerpt(m[0])}"`,
        m.index ?? 0,
        m[0].length
      );
  }

  // 2. Exfil-URL detection (named hosts first, then raw-IP endpoints).
  const exfilHost = content.match(EXFIL_HOST_RE);
  if (exfilHost) {
    add(
      "injection.exfil-url",
      "high",
      `outbound URL to a known exfil/paste host: "${excerpt(exfilHost[0])}"`,
      exfilHost.index ?? 0,
      exfilHost[0].length
    );
  } else {
    const rawIp = content.match(RAW_IP_URL_RE);
    if (rawIp) {
      add(
        "injection.exfil-url",
        "medium",
        `outbound URL to a raw IP address (names expected, not bare IPs): "${excerpt(rawIp[0])}"`,
        rawIp.index ?? 0,
        rawIp[0].length
      );
    }
  }

  // 3a. Hidden instructions — zero-width / invisible characters.
  const zeroWidth = content.match(ZERO_WIDTH_RE);
  if (zeroWidth) {
    add(
      "injection.hidden-zero-width",
      "medium",
      "zero-width / invisible characters present (used to hide instructions from a human reviewer)",
      zeroWidth.index ?? 0,
      zeroWidth[0].length
    );
  }

  // 3b. Hidden instructions — imperative-override text buried inside an HTML comment.
  for (const comment of content.matchAll(HTML_COMMENT_RE)) {
    const inner = comment[1];
    const hit = OVERRIDE_PATTERNS.map(p => inner.match(p.re)).find(m => m);
    if (hit) {
      add(
        "injection.hidden-comment-instruction",
        "high",
        `imperative-override text hidden inside an HTML comment: "${excerpt(inner)}"`,
        (comment.index ?? 0) + "<!--".length + (hit.index ?? 0),
        hit[0].length
      );
      break;
    }
  }

  // 3c. Long opaque encoded blob — advisory (base64 is common for embedded images), so
  //     LOW severity: recorded + surfaced, but non-blocking on its own.
  const blob = content.match(BASE64_BLOB_RE);
  if (blob) {
    add(
      "injection.encoded-blob",
      "low",
      `long opaque base64-like blob (${blob[0].length} chars) — an easy carrier for a hidden payload; verify its contents`,
      blob.index ?? 0,
      blob[0].length
    );
  }

  return findings;
}

/**
 * Scan a markdown/text document for prompt-injection patterns. Returns one
 * {@link ScanFinding} per fired rule (deduped by rule id). An empty array means no
 * pattern matched — which, per R6, is NOT a guarantee of safety.
 *
 * @param content the raw markdown/text to scan
 * @param location optional path/label for the finding message (e.g. the file name)
 */
export function scanForInjection(
  content: string,
  location?: string
): ScanFinding[] {
  return locateInjectionFindings(content, location).map(
    ({ severity, rule, message }) => ({ severity, rule, message })
  );
}
