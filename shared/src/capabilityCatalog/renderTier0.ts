// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tier-0 capability-catalog renderer (issue #3748, Sub H, Task 1 / R1, R1a, R1b).
 *
 * `renderTier0` turns the committed capability catalog into a compact plain-text
 * block that is injected into EVERY harness's context (Claude system prompt,
 * Codex `developer_instructions`, Gemini/opencode first-turn prompt), so an agent
 * running inside Hapimatic knows what Hapimatic itself can do and how to reach it.
 *
 * Pure + deterministic — no `trimIdent`, no timestamp/git-SHA/build-id (R1b): the
 * version stamp is a content hash of the eligible entry set, so the committed
 * `tier0.generated.ts` (Task 2) stays byte-stable and `check:capabilities-gen-clean`
 * + the CI codegen diff never flap.
 *
 * `shared/` is the zod-only, browser-safe contract layer — this module imports
 * ONLY from within `shared/src` and pulls in no Node built-ins.
 */
import type { CatalogEntry, Invocation } from "./types";
import { evaluateAvailability, type AvailabilityContext } from "./availability";

/**
 * Per-session render context (#3749, Sub-Issue I / R4). A PARTIAL
 * `AvailabilityContext` — every axis optional, so the neutral render (`{}`) is a
 * valid value and includes the full eligible set (the R4a subset invariant). A
 * concrete context can only ever OMIT entries (a Codex session drops Claude-only
 * actions), never add — so every harness × scope render is a SUBSET of the
 * committed snapshot and the budget gate cannot be pushed over by the variance.
 */
export type Tier0Context = Partial<AvailabilityContext>;

/**
 * The explicit NEUTRAL context: no launcher, no agent, no session. The generator
 * passes this to produce the committed budget/determinism snapshot. Named so a
 * worker never has to invent a "no context" value. Rendering with it is
 * byte-identical to the pre-#3749 context-independent render.
 */
export const TIER0_NEUTRAL_CONTEXT: Tier0Context = Object.freeze({});

/**
 * R1a eligibility — FAIL CLOSED. An entry is Tier-0-eligible iff ALL hold:
 * - `availability.scope === "user"` (a missing/`undefined` scope is NOT
 *   user-visible → excluded; never read as "not operator-only");
 * - `trusted !== false` (`trusted` defaults to `true` on parse per #3741 R9;
 *   only an EXPLICIT `false` — the runtime-loaded / extension-contributed class,
 *   #3752 R3 — is excluded, keeping third-party text out of the system prompt);
 * - `surface !== "ui"` (agent-actionable — a UI location is not a callable action);
 * - `surface !== "rest"` (ruling F1-T0, 2026-09-18): REST routes are **Tier-1,
 *   not Tier-0**. The epic (#3740) rules BOTH "ALL REST routes in the catalog"
 *   (completeness — a capability absent from the catalog is blind) AND the
 *   ~650-token Tier-0 byte-cap. ~412 user-scope REST routes cannot fit an
 *   always-injected primer (F.1's 7 scheduler entries alone pushed the delta past
 *   the cap), so REST lives in the catalog and is discovered ON DEMAND via
 *   `GET /api/capabilities/catalog` + the `hapi_capabilities` / `hapi_invoke` MCP
 *   tools (Tier-0 stays the rpc+mcp native-action primer; the scheduler REST route
 *   is already surfaced by the hardcoded part-(5) line);
 * - `riskTier ∈ {readonly, mutating}` (destructive capabilities are never
 *   advertised as always-available).
 *
 * The invariant "the committed Tier-0 index NEVER surfaces runtime-loaded
 * entries" is enforced HERE by the `trusted !== false` filter (issue #3748 R1a).
 */
export function isTier0Eligible(entry: CatalogEntry): boolean {
  if (entry.availability?.scope !== "user") return false;
  if (entry.trusted === false) return false;
  if (entry.surface === "ui") return false;
  // Ruling F1-T0 (#3746): REST routes are Tier-1 (catalog, discovered on demand),
  // never Tier-0 — the always-injected ~650-token primer cannot hold the ~412
  // user-scope REST routes the epic rules into the catalog.
  if (entry.surface === "rest") return false;
  if (entry.riskTier !== "readonly" && entry.riskTier !== "mutating") {
    return false;
  }
  return true;
}

/**
 * Select the eligible entries for a render (#3749 / R4). An entry survives iff it
 * passes H's fail-closed eligibility (`isTier0Eligible` — Tier-0 stays user-scope,
 * excludes operator/no-scope/untrusted/ui/destructive) AND its per-session
 * mode-dependence evaluates as available (`evaluateAvailability`). A missing
 * context axis imposes no constraint, so the NEUTRAL context yields the full
 * eligible set — byte-identical to H's context-independent render. The scope axis
 * defaults to `user`: Tier-0 is never operator-scoped here (R4a).
 */
function selectTier0Eligible(
  entries: readonly CatalogEntry[],
  context: Tier0Context
): CatalogEntry[] {
  const evalContext: AvailabilityContext = {
    ...context,
    scope: context.scope ?? "user",
  };
  return entries
    .filter(
      entry =>
        isTier0Eligible(entry) &&
        evaluateAvailability(entry.availability, evalContext).available
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Compact "how to invoke" string for an entry's invocation coordinate. */
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
 * FNV-1a (32-bit) hex digest — a deterministic, dependency-free content hash for
 * the version stamp (R1b forbids a timestamp/SHA/build-id). `Math.imul` keeps the
 * multiply in 32-bit space; `>>> 0` coerces to unsigned before hex.
 */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministic stamp over exactly the render-relevant projection of the
 * eligible set (id + whenToUse + action), sorted — so the stamp changes when the
 * rendered content would change and is stable otherwise.
 */
function catalogStamp(eligible: readonly CatalogEntry[]): string {
  const canonical = eligible
    .map(e => `${e.id} ${e.whenToUse} ${invocationAction(e.invocation)}`)
    .join("\n");
  return fnv1aHex(canonical);
}

/**
 * Render the Tier-0 capability block (R1's six parts):
 *   1. "you are inside Hapimatic" framing + catalog version stamp;
 *   2. plain-language → native-action list from every eligible `whenToUse`;
 *   3. the discovery/MCP tool list, GENERATED from the catalog's `mcp` entries;
 *   4. the one-line auth recipe;
 *   5. the scheduler one-liner (durable scheduled events vs session-local `/loop`);
 *   6. the "capability registry vs catalog" glossary line.
 */
export function renderTier0(
  entries: readonly CatalogEntry[],
  context: Tier0Context = TIER0_NEUTRAL_CONTEXT
): string {
  const eligible = selectTier0Eligible(entries, context);
  const stamp = catalogStamp(eligible);
  const mcpTools = eligible.filter(e => e.invocation.kind === "mcp");

  const lines: string[] = [];

  // (1) Framing + stamp.
  lines.push(
    "You are running inside Hapimatic — a harness wrapping this agent session " +
      "that exposes its own capabilities over HTTP and MCP. Reach for the " +
      "Hapimatic capabilities below before assuming a task needs a tool you lack " +
      `(capability catalog rev ${stamp}).`
  );

  // (2) Plain need → native action.
  lines.push("", "Hapimatic capabilities (what you need → how to do it):");
  for (const e of eligible) {
    lines.push(`- ${e.whenToUse} → ${invocationAction(e.invocation)}`);
  }

  // (3) Discovery / MCP tools, generated from the catalog's mcp entries.
  lines.push("", "MCP tools available directly in this session:");
  for (const e of mcpTools) {
    lines.push(`- ${invocationAction(e.invocation)}: ${e.whenToUse}`);
  }

  // (4) Auth recipe.
  lines.push(
    "",
    "Auth: for `/cli/*` routes send `CLI_API_TOKEN` as `Authorization: Bearer`; " +
      "for `/api/*` routes POST it to `/api/auth` to get a JWT, then send that " +
      "JWT as `Authorization: Bearer`."
  );

  // (5) Scheduler disambiguation.
  lines.push(
    "Scheduling: `POST /api/schedules` creates a durable Hapimatic scheduled " +
      "event that survives this session; the built-in `/loop` is session-local " +
      "and dies with the session."
  );

  // (6) Registry vs catalog glossary.
  lines.push(
    "Registry vs catalog: this catalog is the static authored index of what " +
      "Hapimatic can do; the live capability registry is the per-session RPC " +
      "surface you enumerate and invoke via the `hapi_capabilities` and " +
      "`hapi_invoke` MCP tools."
  );

  return lines.join("\n");
}
