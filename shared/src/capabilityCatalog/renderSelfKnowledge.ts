// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tier-1 `agent-self-knowledge.md` renderer (issue #3750, Sub J / R1, R1b, R1c,
 * R2, R3).
 *
 * `renderSelfKnowledge` turns the committed capability catalog into the full
 * `agent-self-knowledge.md` markdown document for one SCOPE — the detail tier an
 * agent reads on a Hapimatic node. It replaces the hand-authored #2521 doc: the
 * SAME catalog now produces a `user` rendering (the single-tenant VM doc,
 * byte-parity target for #2521) AND an `operator` rendering (RP1/RP2/SL7 —
 * greenfield, never existed before). The two differ ONLY by the scope filter
 * (KD-1), never by hand-synced prose.
 *
 * Pure + deterministic — no `node:fs`, no `process.env`, no timestamp/SHA (R1):
 * `shared/` is the zod-only, browser-safe contract layer, so the GENERATOR
 * (`scripts/generate-capability-catalog.ts`) reads `selfKnowledge.preamble.md`
 * and passes its TEXT in; this module never touches the filesystem. Mirrors
 * #3748's pure `renderTier0` (the generator does the I/O).
 *
 * SCOPE FILTER (R1c / D4): the hard scope gate is #3749's NAMED export
 * `isVisibleToScope(availability, context)` — NOT a hand-rolled
 * `e.availability.scope === scope` (a second derivation #3749 KD-2 forbids). The
 * directive named this export `filterByScope`; #3749 actually landed it as
 * `isVisibleToScope` (a `(predicate, context) → boolean` shape), so J adapts to
 * the landed name (worker-handoff delta, verified on ms-dev). A `user` render
 * keeps `scope: "user"` entries; an `operator` render keeps `user ∪ operator`
 * (operator ⊇ user). D4: an entry that is render-eligible on every other axis but
 * carries NO `scope` is a #3741-schema bypass — the renderer THROWS rather than
 * defaulting it into the `user` file (distinct from `isVisibleToScope`'s
 * silent-omit, which protects a live request; the throw protects the build).
 *
 * NO TIER-0 DUPLICATION + A HARD SIZE BUDGET (R3 / KD-3): the compact
 * plain-language Tier-0 primer is injected into context separately, so this doc
 * does NOT repeat it — it opens with a one-line pointer to it and renders the
 * on-demand DETAIL (4 fields, domain→surface sections). `SELF_KNOWLEDGE_CEILING`
 * caps each rendered doc; the renderer THROWS past it, so `gen:capabilities`
 * fails the build rather than shipping an unbounded file (the ~64–80 KB regression
 * R3 exists to prevent). REST is excluded (F1-T0): the ~409 REST routes stay
 * discoverable on demand via `GET /api/capabilities/catalog`, never inline.
 */
import type { CatalogEntry, Invocation } from "./types";
import { DOMAIN_SLUGS, DOMAIN_LABELS, type DomainSlug } from "./domains";
import { isVisibleToScope } from "./availability";

/** The two scopes a self-knowledge doc is rendered for. */
export type SelfKnowledgeScope = "user" | "operator";

/** Frontmatter `scope:` value per rendered scope (distinct per doc — Task 2). */
const SCOPE_FRONTMATTER: Record<SelfKnowledgeScope, string> = {
  user: "user-vm",
  operator: "operator-node",
};

/**
 * HARD per-scope byte ceiling (R3 / KD-3). The `user` ceiling is the size of the
 * hand-authored #2521 doc this replaces (10,274 B) — the rendering must be a
 * SAVING, not a regression. The `operator` doc is greenfield and carries the full
 * `user ∪ operator` set, so its ceiling is higher but still bounded well below the
 * ~64–80 KB an unfiltered (REST-inclusive) render would reach. A render past its
 * ceiling THROWS — `gen:capabilities` fails the build. Raising a ceiling is a
 * deliberate, reviewed governance decision, not an accident.
 */
export const SELF_KNOWLEDGE_CEILING: Record<SelfKnowledgeScope, number> = {
  // Anchored at the #2521 hand-authored doc (10,274 B), then RAISED to 10,500 B by
  // #3751 (Sub-Issue K) — a deliberate, reviewed governance bump (this PR is
  // expert-review gated): K adds two genuine Tier-1 MCP tools (`hapi_catalog`,
  // `hapi_call`) that legitimately render into the user detail doc (~10,334 B).
  // Truncating their descriptions to preserve the legacy byte target would degrade
  // the agent-facing catalog for no benefit; the doc stays far below the ~64–80 KB
  // REST-inclusion runaway R3 exists to catch. Raise again — in review — if a later
  // sub-issue's user-scope surface legitimately outgrows this (do NOT re-admit REST).
  user: 10500,
  // Greenfield: no replaced-doc anchor. Fits the current full user∪operator
  // render (~16 KB) with headroom for the catalog to fill as #3745 lands more
  // RPC entries, and catches the ~64–80 KB REST-inclusion runaway (R3). A
  // deliberate, reviewed governance point — raise it in review if the operator
  // surface legitimately outgrows it (do NOT re-admit REST to fit).
  operator: 24000,
};

/** Fixed surface render order within a domain (rest/ui are never rendered). */
const SURFACE_ORDER: readonly CatalogEntry["surface"][] = ["rpc", "mcp", "cli"];

/** Human label for a rendered surface heading. */
const SURFACE_LABEL: Record<string, string> = {
  rpc: "RPC methods",
  mcp: "MCP tools",
  cli: "CLI (`hapi …`)",
};

/**
 * A render CANDIDATE (scope-independent eligibility): trusted, agent-actionable.
 * `surface: "ui"` is not a callable action; `surface: "rest"` is Tier-1
 * on-demand (F1-T0) and excluded to keep the always-loaded doc bounded (R3).
 * Carried over from #3748's `isTier0Eligible` MINUS the hardcoded `scope:"user"`
 * (this renderer parameterizes scope) and MINUS the destructive exclusion
 * (destructive entries are NAMED here without an invocation, R2 / V4).
 */
function isRenderCandidate(entry: CatalogEntry): boolean {
  if (entry.trusted === false) return false;
  if (entry.surface === "ui" || entry.surface === "rest") return false;
  return true;
}

/** The compact invocation coordinate for an entry (never rendered for destructive). */
function invocationAction(inv: Invocation): string {
  switch (inv.kind) {
    case "rest":
      return `${inv.method} ${inv.path}`;
    case "rpc":
      return inv.method;
    case "mcp":
      return inv.tool;
    case "cli":
      return `hapi ${inv.command}`;
    case "ui":
      return inv.location;
  }
}

/**
 * One entry → one markdown line. `readonly | mutating` carry the invocation +
 * auth + tier; `destructive` is NAMED (by `whenToUse`) but carries NO invocation
 * (V4) — an agent learns the capability EXISTS without a copy-paste destructive
 * recipe (the gated/bespoke path owns that).
 */
function renderEntryLine(entry: CatalogEntry): string {
  if (entry.riskTier === "destructive") {
    return `- ${entry.whenToUse} · destructive (gated — no direct invocation)`;
  }
  return `- \`${invocationAction(entry.invocation)}\` — ${entry.whenToUse} · auth: ${entry.auth} · ${entry.riskTier}`;
}

/**
 * The eligible entries for one scope, grouped by domain (D1–D13) then surface,
 * each group id-sorted. Throws (D4) if a render candidate carries no `scope`.
 */
function selectByScope(
  entries: readonly CatalogEntry[],
  scope: SelfKnowledgeScope
): CatalogEntry[] {
  const candidates = entries.filter(isRenderCandidate);

  // D4 fail-loud: a candidate with no scope is a #3741-schema bypass. Throw
  // rather than let it default into (or vanish from) a rendering.
  for (const e of candidates) {
    const s = e.availability?.scope;
    if (s !== "user" && s !== "operator") {
      throw new Error(
        `renderSelfKnowledge: entry "${e.id}" is render-eligible but declares no ` +
          `availability.scope. Every catalog entry MUST declare a scope (#3741 R9 / ` +
          `#3750 D4) — a no-scope entry must never default into a rendering.`
      );
    }
  }

  return candidates
    .filter(e => isVisibleToScope(e.availability, { scope }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Render the full `agent-self-knowledge.md` document for one scope (R1). The
 * output is: frontmatter (with the LITERAL `__HAPIMATIC_VERSION__` stamp, R1b) →
 * a generated-file header comment naming the generator (AC-6) → the verbatim
 * `preambleText` → a one-line Tier-0 pointer (R3, no Tier-0 table) → the
 * domain→surface capability detail. THROWS past `SELF_KNOWLEDGE_CEILING[scope]`
 * (R3) and on a no-scope candidate (D4).
 */
export function renderSelfKnowledge(
  entries: readonly CatalogEntry[],
  scope: SelfKnowledgeScope,
  preambleText: string
): string {
  const eligible = selectByScope(entries, scope);
  const scopeLabel =
    scope === "user"
      ? "this single-tenant user VM"
      : "an operator node (RP1 / RP2 / SL7)";

  const lines: string[] = [];

  // Frontmatter — `scope` distinct per doc; version stamp is the LITERAL
  // placeholder (R1b): push_agent_self_knowledge substitutes it per push.
  lines.push(
    "---",
    "doc: hapimatic-agent-self-knowledge",
    "audience: agent",
    `scope: ${SCOPE_FRONTMATTER[scope]}`,
    "hapimatic-version: __HAPIMATIC_VERSION__",
    "---",
    ""
  );

  // Generated-file header comment (AC-6): this doc is generated; name the generator.
  lines.push(
    "<!-- GENERATED — do not hand-edit. Generated by scripts/generate-capability-catalog.ts",
    `  (\`bun run gen:capabilities\`) from the defineCapability({...}) call sites (issue #3750). Scope:`,
    `  ${scopeLabel}. Prose preamble: infrastructure/cloud-vm/selfKnowledge.preamble.md. Edits here or`,
    "  on a node are overwritten by the next regeneration / reconcile. -->",
    ""
  );

  // Verbatim preamble (the hand-authored prose with no catalog counterpart).
  lines.push(preambleText.replace(/\n+$/, ""), "");

  // (R3) The ONE-LINE Tier-0 pointer — the compact primer is injected separately;
  // this doc is the on-demand detail, so the Tier-0 table is NOT repeated here.
  lines.push(
    "> The compact need → native-action primer is injected into your context separately (the Tier-0 " +
      "block); this is the on-demand DETAIL, so that quick list is not repeated here. Anything not " +
      "listed below — including the full REST surface — is discoverable via " +
      "`GET /api/capabilities/catalog` and the `hapi_capabilities` / `hapi_invoke` MCP tools.",
    ""
  );

  // Domain → surface capability detail (R2). Skip empty domains/surfaces.
  lines.push("## Hapimatic-native capabilities (by domain)", "");
  for (const domain of DOMAIN_SLUGS) {
    const inDomain = eligible.filter(e => e.domain === (domain as DomainSlug));
    if (inDomain.length === 0) continue;
    lines.push(`### ${DOMAIN_LABELS[domain]}`, "");
    for (const surface of SURFACE_ORDER) {
      const inSurface = inDomain.filter(e => e.surface === surface);
      if (inSurface.length === 0) continue;
      lines.push(`**${SURFACE_LABEL[surface]}**`, "");
      for (const e of inSurface) lines.push(renderEntryLine(e));
      lines.push("");
    }
  }

  const out = lines.join("\n").replace(/\n+$/, "") + "\n";

  // (R3) HARD size budget — a render past the ceiling fails the build rather than
  // shipping an unbounded always-loaded doc. `TextEncoder` (WHATWG, browser-safe)
  // gives the UTF-8 byte length without the Node `Buffer` global.
  const bytes = new TextEncoder().encode(out).length;
  const ceiling = SELF_KNOWLEDGE_CEILING[scope];
  if (bytes > ceiling) {
    throw new Error(
      `renderSelfKnowledge: the ${scope} rendering is ${bytes} B, over the ` +
        `${ceiling} B ceiling (SELF_KNOWLEDGE_CEILING.${scope}). An always-loaded ` +
        `self-knowledge doc must stay bounded (#3750 R3 / KD-3) — trim content, move ` +
        `detail to on-demand discovery, or (deliberately, in review) raise the ceiling.`
    );
  }

  return out;
}
