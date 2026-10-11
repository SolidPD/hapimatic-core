// SPDX-License-Identifier: AGPL-3.0-only
import type { ChangelogSpan, ChangelogVersionEntry } from "@hapi/protocol";

/**
 * Pure changelog parser (issue #1771, epic #1769). Given a harness's raw
 * `CHANGELOG.md` text plus the installed + latest versions, return the verbatim
 * bullets for every version in the `installed < v <= latest` span, latest-first.
 *
 * Pure function, no I/O (R7): it never fetches, reads the store, or throws — it
 * reuses the changelog text #1770's poll already cached (R2). It is the SINGLE
 * builder of the `ChangelogSpan` wire shape, so the route calls it even for the
 * empty-text degraded cases ("not-cached" / "no-changelog-source") — the shape
 * lives in exactly one place.
 *
 * Anthropic's `CHANGELOG.md` is highly regular: `# Changelog` (H1) → `## X.Y.Z`
 * (bare semver, no "v", no date) → `- bullet` lines, with NON-CONTIGUOUS
 * versions (2.1.183 → 2.1.181 → 2.1.179 …). The parser therefore selects span
 * members by semver comparison, never by assuming sequential versions.
 */

/** Cap on the number of versions returned in one span. A `null` installed
 *  version (routine when binary detection fails under a minimal PATH) would
 *  otherwise dump the entire ~322-version changelog; cap it instead. */
export const SPAN_CAP = 25;

/** A version section header: `## X.Y.Z` on its own line (bare semver — no "v",
 *  no date, no brackets). The capture group is the semver. */
const VERSION_HEADER = /^##\s+(\d+\.\d+\.\d+)\s*$/;

/** A markdown bullet line. The stored bullet is the text AFTER this prefix. */
const BULLET_PREFIX = /^- /;

/**
 * Compare two clean numeric `X.Y.Z` semvers. Returns −1 / 0 / 1
 * (a<b / a==b / a>b). Hand-rolled (no `semver` dep exists in the repo and the
 * versions are clean numeric triples — KISS). Missing components default to 0.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < 3; i++) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface ParseChangelogSpanArgs {
  /** The raw cached `CHANGELOG.md` body (#1770's `getChangelogText`). */
  rawText: string;
  /** The installed version, or null when detection failed. */
  installed: string | null;
  /** The latest available version, or null when the latest fetch failed. */
  latest: string | null;
  /** The harness id, echoed into the span. */
  harnessId: string;
  /** The changelog URL, echoed into the span (link fallback for R3/R4). */
  changelogUrl: string | null;
}

interface Section {
  version: string;
  /** Bullet text + any non-bullet lines retained raw, in order. */
  bullets: string[];
  /** Count of non-bullet lines retained raw within this section. */
  driftCount: number;
}

/** Build a degraded (`available: false`) span with an empty version list. */
function degraded(
  args: ParseChangelogSpanArgs,
  reason: ChangelogSpan["reason"]
): ChangelogSpan {
  return {
    available: false,
    harness_id: args.harnessId,
    installed: args.installed,
    latest: args.latest,
    versions: [],
    truncated: false,
    drift_line_count: 0,
    changelog_url: args.changelogUrl,
    reason,
  };
}

export function parseChangelogSpan(
  args: ParseChangelogSpanArgs
): ChangelogSpan {
  const { rawText, installed, latest, harnessId, changelogUrl } = args;
  try {
    // R3: empty/whitespace cached text. Distinguish "poll hasn't cached yet"
    // (a URL exists, retry later) from "no source exists at all".
    if (!rawText || rawText.trim() === "") {
      return degraded(
        args,
        changelogUrl ? "not-cached" : "no-changelog-source"
      );
    }

    // Step 1 — scan lines into per-version sections, retaining EVERY non-blank
    // line verbatim (R5). Lines before the first `## X.Y.Z` header (the
    // `# Changelog` H1, blank lines) are ignored.
    const sections: Section[] = [];
    let current: Section | null = null;
    for (const line of rawText.split("\n")) {
      const header = line.match(VERSION_HEADER);
      if (header) {
        current = { version: header[1], bullets: [], driftCount: 0 };
        sections.push(current);
        continue;
      }
      if (!current) continue; // before the first version header
      if (line.trim() === "") continue; // blank line inside a section
      if (BULLET_PREFIX.test(line)) {
        current.bullets.push(line.slice(2)); // verbatim text after "- "
      } else {
        // Partial format drift: an indented sub-bullet, a `###` sub-header, or a
        // wrapped continuation line. Retain it raw (never drop content — R5) and
        // count it as the drift telemetry signal.
        current.bullets.push(line);
        current.driftCount++;
      }
    }

    // Step 5 (R4): zero version sections found → full format shift. Surface the
    // link rather than throwing or returning a 5xx.
    if (sections.length === 0) {
      return degraded(args, "unparseable");
    }

    // Step 3 — a null `latest` means there is nothing to show (bounded, never a
    // full dump); return a valid empty "you're current"-style span.
    if (latest === null) {
      return {
        available: true,
        harness_id: harnessId,
        installed,
        latest,
        versions: [],
        truncated: false,
        drift_line_count: 0,
        changelog_url: changelogUrl,
        reason: "ok",
      };
    }

    // Step 3 — filter to the span `installed < v <= latest`. A null `installed`
    // (binary detection failed) is a routine production state: do NOT include
    // everything ≤ latest (the entire changelog) — the SPAN_CAP below bounds it.
    const inSpan = sections.filter(section => {
      const atOrBelowLatest = compareSemver(section.version, latest) <= 0;
      const aboveInstalled =
        installed === null
          ? true
          : compareSemver(installed, section.version) < 0;
      return atOrBelowLatest && aboveInstalled;
    });

    // Step 4 — order latest-first (descending semver).
    inSpan.sort((a, b) => compareSemver(b.version, a.version));

    // Step 3 — cap the span (null installed, or a genuinely huge span). Bound to
    // the most-recent SPAN_CAP versions and flag it.
    const capped = inSpan.length > SPAN_CAP;
    const served = capped ? inSpan.slice(0, SPAN_CAP) : inSpan;

    const versions: ChangelogVersionEntry[] = served.map(section => ({
      version: section.version,
      bullets: section.bullets,
    }));

    // drift_line_count reflects the SERVED versions only — it is the telemetry
    // for the content actually returned, not drift in ancient out-of-span
    // sections the caller never sees.
    const driftLineCount = served.reduce((n, s) => n + s.driftCount, 0);

    return {
      available: true,
      harness_id: harnessId,
      installed,
      latest,
      versions,
      truncated: capped,
      drift_line_count: driftLineCount,
      changelog_url: changelogUrl,
      reason: capped ? "capped" : "ok",
    };
  } catch {
    // R4: never throw on malformed input — degrade to the link fallback.
    return degraded(args, "unparseable");
  }
}
