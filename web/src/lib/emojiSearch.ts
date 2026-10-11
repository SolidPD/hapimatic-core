// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Keyword-augmented emoji search (hapimatic-private#796).
 *
 * `emoji-picker-react`'s built-in search only substring-matches an emoji's
 * canonical name, so "wind" never surfaces 💨 (whose name is `dashing_away`).
 * This module builds a lean search index from the `emojilib` keyword dataset
 * — `{ "💨": ["dashing_away", "wind", "air", "fast", ...], ... }`, where the
 * first array entry is the canonical name and the rest are search keywords —
 * and scores entries so both name matches and keyword matches surface.
 *
 * Pure module (no React imports); the picker component consumes `searchEmojis`.
 */
import emojiLib from "emojilib";

export type EmojiSearchEntry = {
  /** The emoji character itself, e.g. "💨". */
  char: string;
  /** The canonical name (emojilib's first token), e.g. "dashing_away". */
  name: string;
  /** All searchable tokens (name + keywords), lowercased, `_` → space. */
  tokens: string[];
  /** The name split on `_`, lowercased — used for exact-name scoring. */
  nameTokens: string[];
};

/**
 * Build the search index once at module load. `emojilib`'s default export is
 * `Record<string, string[]>` (emoji char → `[name, ...keywords]`). ~1900
 * entries; building the index costs ~a few ms and is done a single time.
 */
const INDEX: EmojiSearchEntry[] = Object.entries(
  emojiLib as Record<string, string[]>
).map(([char, keywords]) => {
  const name = keywords[0] ?? "";
  return {
    char,
    name,
    tokens: keywords.map(t => t.toLowerCase().replace(/_/g, " ")),
    nameTokens: name.toLowerCase().split("_"),
  };
});

/**
 * Curated synonym expansion (#796 feedback, #2745 round): everyday query words
 * that emojilib's keyword vocabulary lacks, mapped onto terms it has — "wet"
 * matches nothing literally, but its synonyms surface 💧/🌧/☔. Expanded terms
 * score at HALF weight (and only the best expansion counts), so a direct
 * keyword match always outranks a synonym match.
 */
const SYNONYMS: Record<string, string[]> = {
  wet: ["water", "rain", "droplet", "splash", "sweat", "umbrella"],
  dry: ["desert", "cactus", "sun"],
  cold: ["snow", "ice", "freezing", "snowflake"],
  hot: ["fire", "sun", "heat", "warm"],
  scared: ["fear", "scream", "ghost", "fearful"],
  tired: ["sleep", "sleepy", "yawn", "zzz"],
  sick: ["ill", "nauseated", "thermometer", "mask"],
  fast: ["quick", "running", "rocket", "dash"],
  slow: ["turtle", "snail"],
  smart: ["brain", "nerd", "glasses"],
  strong: ["muscle", "flex"],
  laugh: ["joy", "funny", "rofl", "lol"],
  cry: ["sad", "tear", "sob"],
  eat: ["food", "hungry", "fork"],
  drink: ["beverage", "cup", "glass", "coffee"],
  work: ["office", "briefcase", "laptop", "computer"],
  build: ["construction", "hammer", "tools", "wrench"],
  fix: ["wrench", "hammer", "tools", "gear"],
  bug: ["insect", "beetle", "ant"],
  idea: ["bulb", "light", "thinking"],
  warning: ["caution", "alert", "exclamation"],
  error: ["cross", "warning", "prohibited"],
  success: ["check", "tada", "party", "trophy"],
  win: ["trophy", "medal", "party", "crown"],
  storm: ["thunder", "lightning", "cloud", "tornado"],
  weather: ["cloud", "sun", "rain", "snow"],
  plant: ["tree", "leaf", "seedling", "flower"],
  photo: ["camera", "picture"],
  plane: ["airplane", "flight"],
  boat: ["ship", "sailboat", "anchor"],
};

/**
 * Expand one query term: curated synonyms plus a light stem fallback
 * (plural / -ing / -ed) so "cats"/"running" still reach "cat"/"run".
 */
function expandTerm(term: string): string[] {
  const out = new Set<string>(SYNONYMS[term] ?? []);
  if (term.length > 4 && term.endsWith("ing")) out.add(term.slice(0, -3));
  if (term.length > 3 && term.endsWith("ed")) out.add(term.slice(0, -2));
  if (term.length > 3 && term.endsWith("s")) out.add(term.slice(0, -1));
  out.delete(term);
  return [...out];
}

/** Score ONE term against ONE entry (the #796 rubric, shared by expansions). */
function termScore(entry: EmojiSearchEntry, term: string): number {
  let s = 0;
  if (entry.nameTokens.includes(term)) s += 100;
  if (entry.tokens.some(t => t.startsWith(term))) s += 50;
  if (entry.tokens.includes(term)) s += 25;
  if (entry.tokens.some(t => t.includes(term))) s += 10;
  return s;
}

// Single-slot memo so React StrictMode double-renders (and repeated identical
// keystrokes) don't re-scan the whole index. Keyed by `query\0limit`.
let cacheKey: string | null = null;
let cacheResults: EmojiSearchEntry[] = [];

/**
 * Search the emoji index for `query`, returning up to `limit` entries ranked
 * by relevance (exact name matches first, then prefix, then keyword, then
 * substring). Returns `[]` for an empty/whitespace-only query.
 *
 * Scoring per query term (summed across terms, so a multi-term query favours
 * entries matching every term):
 *   +100  term exactly equals a name token   (e.g. "thumbs"/"up" → 👍)
 *   +50   term is a prefix of any token      (e.g. "wind" → "wind face")
 *   +25   term exactly equals any token      (e.g. "wind" keyword on 💨)
 *   +10   term is a substring of any token
 */
export function searchEmojis(query: string, limit = 64): EmojiSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];

  const key = `${limit}:${q}`;
  if (cacheKey === key) return cacheResults;

  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    cacheKey = key;
    cacheResults = [];
    return [];
  }

  // Expansions computed once per query, not per entry (~1900 iterations).
  const expansions = terms.map(expandTerm);

  const scored: { entry: EmojiSearchEntry; score: number }[] = [];
  for (const entry of INDEX) {
    let score = 0;
    for (let i = 0; i < terms.length; i++) {
      let s = termScore(entry, terms[i]);
      // #796 feedback: the BEST synonym/stem expansion counts at half weight —
      // never stacked, so a pile of synonyms can't outrank a direct match.
      for (const alt of expansions[i]) {
        s = Math.max(s, termScore(entry, alt) / 2);
      }
      score += s;
    }
    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.entry.name.localeCompare(b.entry.name)
  );

  const results = scored.slice(0, limit).map(s => s.entry);
  cacheKey = key;
  cacheResults = results;
  return results;
}
