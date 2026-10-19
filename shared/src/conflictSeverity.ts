// SPDX-License-Identifier: AGPL-3.0-only
import type { ChangeKind } from "./fileClaims";
import { trimChars } from "./trimChars";

// Epic #1965 (File Conflict Monitor) Sub E / #1970 — pure conflict-computation
// helpers shared by the orchestrator-local batch-conflict endpoint (#1970) and the
// hapimatic-private web UI renderer (#1971). Two concerns, both stateless + fail-safe:
//   1. the blast-radius × change-kind × concurrency SEVERITY formula, and
//   2. the gitignore-LIKE churn-ignore matcher.
//
// Ported from rp1-home `.claude/hooks/lib/conflict_table.py` (severity, spec §4) and
// `.claude/hooks/lib/conflict_ignore.py` (churn matcher) @ commit
// d46a03ade3f38c2366ca3f11ad58559457ce70ff. Cross-repo conformance is proved by the
// vendored fixture in `conflictSeverity.vectors.json` (see `conflictSeverity.test.ts`).
//
// PROVISIONAL weights/bands — tunable from #1079 observe-phase data. On any change:
// bump the spec version, re-vendor the fixture, and re-run every implementation's
// conformance test so all renderers re-converge (conflict-table-spec.md §4.5).

/** Version of `conflict-table-spec.md` this module realizes (kept in lockstep). */
export const CONFLICT_SPEC_VERSION = "1.0.0";

export type Severity = "🔴" | "🟡" | "🟢";

// ── Tunable parameter block (spec §4.5) ──────────────────────────────────────
/** Change-kind weights: rename/move/delete are reference-breaking → weigh higher. */
export const CHANGE_KIND_WEIGHTS: Record<string, number> = {
  edit: 1,
  rename: 2,
  move: 2,
  delete: 2,
};
const DEFAULT_CHANGE_KIND_WEIGHT = 1; // unrecognized change-kind → edit weight
const BAND_LOW_MAX = 3;
const BAND_MEDIUM_MAX = 11;
const DEFAULT_BLAST_RADIUS = 1; // leaf/default — an unrecognized path is never silently 0/🟢

// Trivial patterns are evaluated FIRST (spec §4.1 NORMATIVE precedence): a match here
// zeroes the whole product regardless of any higher-tier match.
const TRIVIAL_PATTERNS = [
  "claudedocs/**",
  "docs/**",
  "**/*.test.*",
  "**/*.spec.*",
  "*.lock",
  "**/*.lock",
  "**/package-lock.json",
  "**/bun.lockb",
];

// Ordered highest→lowest (shared=3, core=2, leaf=1); repo-aware; each entry is
// [weight, globs]. Evaluated top-down, first-match, AFTER the trivial check.
const BLAST_RADIUS_TIERS: Record<string, Array<[number, string[]]>> = {
  "rp1-home": [
    [
      3,
      [
        ".claude/skills/_shared/**",
        ".claude/hooks/lib/**",
        "CLAUDE.md",
        ".claude/CLAUDE.md",
        ".claude/settings.json",
      ],
    ],
    [2, [".claude/hooks/*.py", ".claude/skills/*/SKILL.md", "scripts/**"]],
  ],
  "hapimatic-private": [
    [3, ["shared/src/**"]],
    [2, ["server/src/**", "cli/src/**"]],
    [1, ["web/src/**"]],
  ],
};

// ── Glob matching (gitignore-style: `*` stays within a segment, `**` crosses `/`) ──
/**
 * Translate a gitignore-style glob to a regex BODY (no anchors). Shared core for both
 * the tier matcher and the churn-ignore matcher — ports the identical translation in
 * conflict_table._glob_to_regex and conflict_ignore._translate.
 */
function globToRegexBody(pattern: string): string {
  let out = "";
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return out;
}

/** Tier match: matches at any `/`-boundary (ports conflict_table._matches). */
function matchesTier(path: string, pattern: string): boolean {
  try {
    return new RegExp("^(?:.*/)?" + globToRegexBody(pattern) + "$").test(path);
  } catch {
    return false;
  }
}

const normalizeRepo = (repo: string): string =>
  repo ? (repo.split("/").pop() ?? "") : "";
const normalizePath = (p: string): string =>
  p.startsWith("./") ? p.slice(2) : p;

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Classify a path's structural blast-radius weight (0–3), repo-aware. Trivial FIRST
 * (spec §4.1); then shared→core→leaf top-down, first-match. Unrecognized → leaf (1),
 * never silently 0. Fail-safe: returns 1 on any error.
 */
export function classifyBlastRadius(path: string, repo = ""): number {
  try {
    if (!path) return DEFAULT_BLAST_RADIUS;
    const p = normalizePath(path);
    for (const pat of TRIVIAL_PATTERNS) if (matchesTier(p, pat)) return 0;
    for (const [weight, patterns] of BLAST_RADIUS_TIERS[normalizeRepo(repo)] ??
      [])
      for (const pat of patterns) if (matchesTier(p, pat)) return weight;
    return DEFAULT_BLAST_RADIUS;
  } catch {
    return DEFAULT_BLAST_RADIUS;
  }
}

/** Weight for a change-kind; unrecognized → the `edit` weight (1). */
export const changeKindWeight = (kind: string): number =>
  CHANGE_KIND_WEIGHTS[kind] ?? DEFAULT_CHANGE_KIND_WEIGHT;

/**
 * Severity glyph from the composite score (spec §4.4):
 * `score = blast_radius × change_kind_weight × concurrency`, banded 🟢 (≤3) /
 * 🟡 (4–11) / 🔴 (≥12). Fail-safe: returns 🟡 (advisory medium) on any error.
 */
export function computeSeverity(
  blastRadius: number,
  changeKind: string,
  concurrency: number
): Severity {
  try {
    const score =
      Math.trunc(blastRadius) *
      changeKindWeight(changeKind) *
      Math.trunc(concurrency);
    if (score <= BAND_LOW_MAX) return "🟢";
    if (score <= BAND_MEDIUM_MAX) return "🟡";
    return "🔴";
  } catch {
    return "🟡";
  }
}

/**
 * Recommended-action token from the decision table (spec §5), evaluated top-down,
 * first-match: all-ignored → `proceed`; clear predecessor → `rebase-after #N`;
 * low/medium severity → `sequence`; 🔴 high → `hold-for-user`. A clear predecessor
 * wins over severity. Fail-safe: returns the conservative `hold-for-user` on any error.
 *
 * Implemented + fixture-tested for full cross-repo conformance and #1971 reuse. The
 * #1970 ENDPOINT does NOT call this — recommended-action needs ordering knowledge the
 * stateless endpoint lacks; the orchestrator computes it (see conflictCheck.ts KD3).
 */
export function recommendAction(
  severity: Severity,
  opts: {
    orderingKnown?: boolean;
    predecessorIssue?: string | number | null;
    allIgnored?: boolean;
  } = {}
): string {
  try {
    if (opts.allIgnored) return "proceed";
    if (opts.orderingKnown && opts.predecessorIssue != null)
      return (
        "rebase-after #" +
        String(opts.predecessorIssue).trim().replace(/^#/, "")
      );
    if (severity === "🟢" || severity === "🟡") return "sequence";
    return "hold-for-user";
  } catch {
    return "hold-for-user";
  }
}

// ── Churn-ignore matcher (ports conflict_ignore._translate / is_ignored) ───────
/**
 * Compile one gitignore-LIKE pattern to a regex over a repo-relative POSIX path.
 * A no-slash pattern matches its basename at any depth; a trailing-slash pattern
 * matches that directory's subtree (and a same-named plain file — a documented
 * divergence); a leading `/` anchors to the repo root.
 */
function ignoreRegex(pattern: string): RegExp {
  const anchored = pattern.startsWith("/");
  const body = globToRegexBody(trimChars(pattern, "/"));
  return new RegExp((anchored ? "^" : "(?:^|/)") + body + "(?:/.*)?$");
}

/**
 * Return true iff `path` matches any churn-ignore glob. `path` is a repo-relative
 * POSIX path (a footprint entry) — no relativization is performed. Comment lines,
 * blanks, and `!`-negation (an unsupported divergence) are skipped defensively.
 * Fail-safe: returns false on any error (the FCM is advisory — never suppress by
 * throwing).
 */
export function isChurnIgnored(path: string, patterns: string[]): boolean {
  try {
    if (!patterns || patterns.length === 0) return false;
    const rp = String(path).replace(/^\/+/, "");
    return patterns.some(pat => {
      const t = pat.trim();
      if (!t || t.startsWith("#") || t.startsWith("!")) return false;
      try {
        return ignoreRegex(t).test(rp);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Re-export for consumers that build overlap rows keyed by change-kind. */
export type { ChangeKind };
