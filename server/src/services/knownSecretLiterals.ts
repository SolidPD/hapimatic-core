// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * #4053 — the secret LITERALS the transcript scrub masks by exact match.
 *
 * Sessions routinely print a Hapimatic `cliApiToken` bare (`jq -r
 * .cliApiToken` on an instance's settings.json), with no key or assignment
 * context a pattern could anchor on, and a shape rule (any 43-char base64url
 * run) would mask ordinary identifiers everywhere. This node already knows its
 * own instance tokens, so exact-match masking has no false positives: collect
 * this instance's token plus the token in every sibling instance directory
 * (one per `~/.hapimatic-<name>`).
 *
 * Tokens of OTHER federation nodes are not known here and are not covered.
 * Values are never logged. Reads are cached (`CACHE_TTL_MS`) so a burst of
 * scrubs costs one directory scan; a corrupt or unreadable settings file is
 * skipped (the instance's own token is always included).
 */

const CACHE_TTL_MS = 60_000;
const MIN_LITERAL_LENGTH = 20;
const INSTANCE_DIR_PREFIX = ".hapimatic-";

let cache: { key: string; atMs: number; literals: readonly string[] } | null =
  null;

function readInstanceToken(settingsPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      cliApiToken?: unknown;
    };
    return typeof parsed.cliApiToken === "string" ? parsed.cliApiToken : null;
  } catch {
    return null;
  }
}

export function getKnownSecretLiterals(opts: {
  ownToken: string | null | undefined;
  home?: string;
  nowMs?: () => number;
}): readonly string[] {
  const home = opts.home ?? homedir();
  const now = (opts.nowMs ?? Date.now)();
  const key = `${home}\0${opts.ownToken ?? ""}`;
  if (cache && cache.key === key && now - cache.atMs < CACHE_TTL_MS) {
    return cache.literals;
  }
  const found = new Set<string>();
  const add = (token: string | null | undefined): void => {
    if (typeof token === "string" && token.length >= MIN_LITERAL_LENGTH) {
      found.add(token);
    }
  };
  add(opts.ownToken);
  let entries: string[] = [];
  try {
    entries = readdirSync(home).filter(name =>
      name.startsWith(INSTANCE_DIR_PREFIX)
    );
  } catch {
    // Unreadable home: the own token alone still gets masked.
  }
  for (const name of entries) {
    add(readInstanceToken(join(home, name, "settings.json")));
  }
  const literals = [...found];
  cache = { key, atMs: now, literals };
  return literals;
}

/** Test seam: drop the cache between cases. */
export function resetKnownSecretLiteralsCache(): void {
  cache = null;
}
