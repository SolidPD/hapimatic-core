// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — marketplace trust allowlist (issue #2465, epic #2339
 * Sub G, Task 2 / R3).
 *
 * A recorded plugin descriptor may name arbitrary marketplaces. Adding a
 * marketplace (`claude plugin marketplace add <source>`) makes its plugins
 * installable — so a marketplace `source` is a trust decision, not just a string.
 * This module gates WHICH marketplaces the install executor may add: only sources
 * on the allowlist (the two Anthropic-curated marketplaces by default, plus any
 * the operator explicitly confirms for a given import). An unrecognized source is
 * NEVER silently added — {@link executePluginInstall} reports and skips it, and
 * marks its plugins not-installed with the reason.
 *
 * The vocabulary mirrors Claude Code's managed-settings trust controls
 * (`strictKnownMarketplaces` = the default-trusted set; `extraKnownMarketplaces`
 * = the operator-admitted additions) rather than inventing a new mechanism.
 *
 * D-3 (expert-review ruling): a `source` may carry a `#<ref>` pin suffix. The ref
 * points INSIDE an already-trusted repo, so the trust decision is made on the
 * ref-free BASE ({@link stripMarketplaceRef}) — a trusted marketplace pinned to a
 * historical catalog state stays trusted, and the pinned ref is recorded +
 * reported by the executor so the drift is operator-visible.
 */

/**
 * The default-trusted marketplaces — the two Anthropic-curated sources. These are
 * the `strictKnownMarketplaces` analogue: trusted without operator confirmation.
 */
export const DEFAULT_TRUSTED_MARKETPLACES: readonly string[] = [
  "anthropics/claude-plugins-official",
  "anthropics/claude-plugins-community",
] as const;

/** A marketplace `source` split into its repo base and optional `#<ref>` pin. */
export interface ParsedMarketplaceSource {
  /** The ref-free source (`owner/repo` shorthand or a git URL). */
  base: string;
  /** The `#<ref>` pin value (branch/tag), or `null` when unpinned. */
  ref: string | null;
}

/**
 * Split a marketplace `source` into its ref-free base and optional `#<ref>` pin.
 * Only the FIRST `#` is treated as the pin delimiter (a git URL fragment cannot
 * legitimately contain a second `#` — the schema's {@link isValidMarketplaceSource}
 * already rejects that). A source with no `#` returns `ref: null`.
 */
export function stripMarketplaceRef(source: string): ParsedMarketplaceSource {
  const hashIdx = source.indexOf("#");
  if (hashIdx === -1) return { base: source, ref: null };
  const ref = source.slice(hashIdx + 1);
  return {
    base: source.slice(0, hashIdx),
    ref: ref.length > 0 ? ref : null,
  };
}

/**
 * True when `source` is on the trust allowlist. The `#<ref>` pin (if any) is
 * stripped before matching (D-3), so a pinned trusted marketplace is still
 * trusted. Matching is case-insensitive because GitHub `owner/repo` identifiers
 * are case-insensitive — this can only ACCEPT case-variants of an already-listed
 * source (never widen the set to a different repo), which keeps the trust
 * boundary safe (over-strict would merely report+skip; it can never over-admit).
 *
 * @param source     The recorded marketplace source (may carry a `#<ref>` pin).
 * @param allowlist  Trusted sources: the default set plus any operator-confirmed
 *                   additions (the `extraKnownMarketplaces` analogue). Entries are
 *                   compared ref-free and case-insensitively.
 */
export function isMarketplaceTrusted(
  source: string,
  allowlist: readonly string[] = DEFAULT_TRUSTED_MARKETPLACES
): boolean {
  const { base } = stripMarketplaceRef(source);
  const needle = base.trim().toLowerCase();
  if (needle.length === 0) return false;
  return allowlist.some(entry => {
    const { base: entryBase } = stripMarketplaceRef(entry);
    return entryBase.trim().toLowerCase() === needle;
  });
}

/**
 * Resolve the effective allowlist for an import: the default-trusted set unioned
 * with the operator-confirmed extras. Deduplicates on the ref-free, lowercased
 * base so a case/ref variant of a default entry does not appear twice. Order is
 * defaults-first, then extras in the order supplied.
 */
export function resolveTrustAllowlist(
  extraTrustedMarketplaces: readonly string[] = []
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of [
    ...DEFAULT_TRUSTED_MARKETPLACES,
    ...extraTrustedMarketplaces,
  ]) {
    const { base } = stripMarketplaceRef(entry);
    const key = base.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}
