// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentPropsWithoutRef, ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkGemoji from "remark-gemoji";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { SyntaxHighlighter } from "@/components/assistant-ui/shiki-highlighter";
import {
  InlineMarkdownAnchor,
  InlineMarkdownCode,
} from "@/components/assistant-ui/sharedMarkdownComponents";
import { cn } from "@/lib/utils";

/**
 * StageReportCard — the PWA structured-block renderer for a stage report (issue
 * #3591, epic #3329; follow-up to #3333 and rp1-home epic #1754). Sibling of
 * {@link file://./QuickReplies.tsx} and built to the exact same seam.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WIRE GRAMMAR — `hapi_stage_report` (this file DEFINES what the rp1-home producer
 * must emit; the producer emission is a coordinated cross-repo lockstep change,
 * filed as an rp1-home follow-up — see § Cross-repo lockstep below).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A stage report is authored as a fixed heading + a vertical plain-markdown table
 * (`| Field | Value |`) — the mandatory fallback every channel (CLI, Telegram, any
 * non-rich harness) receives byte-for-byte. The PWA additionally recognises a
 * fenced JSON block tagged `hapi_stage_report` and renders a rich card from it.
 *
 * Fence body shape (ONE physical line of JSON — see § Single-line rule):
 *
 *   ```hapi_stage_report
 *   {"payload_schema_version":"1.0.0","stage":"worker","fields":{"issue":"#1755","outcome":"worked","artifacts":"…","next_step_cta":"→ /issue-tester #1755","branch":"…","commits":"3","files_changed":"7","deploy_target":"3009","test_plan":"…","handoff":"https://github.com/…"},"extras":[{"label":"Cycles","value":"2"}]}
 *   ```
 *
 * - **Fence language literal** `hapi_stage_report` — UNDERSCORE form, mandatory:
 *   assistant-ui extracts the language via `/language-(\w+)/` and `\w` excludes `-`,
 *   so a hyphenated tag would silently truncate to `hapi` and never route here.
 * - **`fields`** is ONE flat map keyed by the {@link STAGE_REPORT_SPEC} field ids
 *   (globally unique across the five common-core rows and all six per-stage
 *   variants, so no nesting is needed).
 * - **Top-level `stage`** is authoritative and DOUBLES as the `stage` core row. A
 *   `fields.stage` key, if present, is ignored (never an error).
 * - **`extras`** is `[{label, value}]` — label-keyed, not id-keyed (the SPEC's
 *   `variant_columns_are_minimum: true` means extra rows arrive with a human label
 *   and no id). Rendered after the variant rows.
 * - **Every value is an INLINE-MARKDOWN string.** Values render through a scoped
 *   `react-markdown` with `[remarkGfm, remarkGemoji]` (the shared `MARKDOWN_PLUGINS`
 *   set), so bare URLs autolink, `` `paths` `` become inline code, and `#N` stays
 *   live — matching the plain table's live cells, which R4 replaces.
 * - **`payload_schema_version`** (`STAGE_REPORT_PAYLOAD_SCHEMA_VERSION`): MISSING →
 *   accept and render (forward-compatible with a pre-field producer); any `1.x` →
 *   accept; a different MAJOR → `parseStageReportBlock` returns `null` (falls
 *   through to a plain code fence, R2 preserved). A major bump is a coordinated
 *   cross-repo change.
 * - **Single-line rule.** The fence body MUST be one physical line of JSON. Every
 *   agent text block passes through `preserveBlankLines`, which rewrites any
 *   `\n{3,}` run — INCLUDING inside a fence — into a `U+00A0`-bearing sequence;
 *   `U+00A0` is not JSON whitespace, so a payload carrying a blank line parses to
 *   `null` and degrades to a raw code block. A newline inside a value must be the
 *   escaped two-character `\n`. No body line may begin with a triple backtick.
 * - **Display-only.** No value in the card is tappable and nothing sends. CTAs stay
 *   in the adjacent `hapi_quick_replies` menu, which is the single send path and the
 *   single choke point that strips `USER-APPROVAL-` payloads; a value that contains
 *   that literal renders here as inert text.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * R4 — TABLE REPLACEMENT / TAG-AND-STYLE (the adopted D6 hybrid, A+C)
 * ─────────────────────────────────────────────────────────────────────────────
 * {@link remarkStageReport} is a mdast pre-pass with TWO outcomes off ONE predicate:
 *   (A) when a `hapi_stage_report` fence parses, it REMOVES the immediately-owning
 *       `heading + table` pair so the PWA shows the card once, not a table stacked
 *       over a card;
 *   (C) when a stage-report `heading + table` pair is present but NO valid
 *       `hapi_stage_report` fence follows it (the shape today's producers emit — a
 *       table plus an inert `hapi_quick_replies` fence), it does not delete: it TAGS
 *       the table (`data-stage-report`) and each body row (`data-field-id`), and the
 *       real table is styled as the card via {@link STAGE_REPORT_TABLE_CLASS} on the
 *       existing `Table`/`Tr`/`Th`/`Td` overrides. This is what keeps the card live
 *       at merge against producers shipping today.
 * Suppression (A) is CLIENT-side only: the rp1-home contract's "additive, never a
 * replacement" rule binds the producer's emitted BYTES, not the client's rendered
 * DOM, so every non-rich channel keeps the mandatory plain-markdown fallback and no
 * producer change is required for R4. A mis-detected table (C) is mis-STYLED, never
 * deleted — deletion stays gated on a parsing fence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Surface gap (recorded): the single `markdown-text.tsx` seam covers assistant TEXT
 * parts only (AssistantMessage full render / narration fold / output-only-collapsed).
 * A stage report surfaced as a tool/sub-agent RESULT renders through
 * `MarkdownRenderer.tsx`, which passes no `componentsByLanguage` and is NOT wired
 * with `remarkStageReport` — both fences render as plain code there. Acceptable: the
 * contract has each stage carry its table in its own assistant message. Hoisting
 * `MARKDOWN_COMPONENTS_BY_LANGUAGE` in `markdown-text.tsx` makes a later opt-in a
 * one-liner (provided the plugin is passed alongside it).
 *
 * Cross-repo lockstep: this repo owns the RENDERER; the rp1-home producer must emit
 * the matching `hapi_stage_report` fence. The follow-up is filed as an rp1-home
 * issue (linked from the PR). The fence goes immediately AFTER the
 * `hapi_quick_replies` fence (closer order: table → quick-replies fence →
 * stage-report fence → wrapped token line); `stage-report-lint.sh` is unaffected (it
 * skips fence bodies). Until that lands, branch (C) keeps the card live.
 */

/** The wire fence tag — UNDERSCORE form (see the `/language-(\w+)/` note above). */
export const STAGE_REPORT_FENCE_LANGUAGE = "hapi_stage_report";

/**
 * The card's payload schema version. `parseStageReportBlock` accepts a missing
 * version and any `1.x`; a different MAJOR is rejected (plain fence). A major bump
 * is a coordinated cross-repo change — record it in the rp1-home producer issue too.
 */
export const STAGE_REPORT_PAYLOAD_SCHEMA_VERSION = "1.0.0";

/** The six emitting stages (the SPEC `stage` core-row vocabulary). */
export const STAGE_NAMES = [
  "researcher",
  "expert-reviewer",
  "worker",
  "tester",
  "refactor-reflector",
  "closer",
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

interface SpecRow {
  id: string;
  label: string;
}

/**
 * The five common-core rows, in fixed order. Mirrors the rp1-home
 * `STAGE_REPORT_SPEC` `core` block (read-only cross-repo contract).
 */
export const STAGE_REPORT_CORE: readonly SpecRow[] = [
  { id: "stage", label: "Stage" },
  { id: "issue", label: "Issue" },
  { id: "outcome", label: "Outcome" },
  { id: "artifacts", label: "Artifacts / evidence" },
  { id: "next_step_cta", label: "Next-step CTA" },
];

/**
 * The per-stage variant rows, in fixed order. Mirrors the rp1-home
 * `STAGE_REPORT_SPEC` `variants` block one-to-one. The `closer` variant has 8 ids
 * (4 of them the debrief buckets) → 13 rows with core.
 */
export const STAGE_REPORT_VARIANTS: Record<StageName, readonly SpecRow[]> = {
  researcher: [
    { id: "confidence", label: "Confidence %" },
    { id: "complexity_risk", label: "Complexity / risk reassessed" },
    { id: "directive_path", label: "Directive path" },
    { id: "open_questions", label: "Open questions" },
  ],
  "expert-reviewer": [
    { id: "findings", label: "Findings {crit/high/med/low}" },
    { id: "refuted_confirmed", label: "Refuted / confirmed" },
    { id: "ground_truth_sha", label: "Ground-truth SHA" },
    { id: "decisions", label: "Decisions / rulings" },
    { id: "refinement_applied", label: "Refinement applied" },
  ],
  worker: [
    { id: "branch", label: "Branch" },
    { id: "commits", label: "Commits" },
    { id: "files_changed", label: "Files changed" },
    { id: "deploy_target", label: "Deploy target / port" },
    { id: "test_plan", label: "Test plan" },
    { id: "handoff", label: "Handoff" },
  ],
  tester: [
    { id: "tests_pass_fail", label: "Tests pass / fail" },
    { id: "testability", label: "Testability {full/partial/cli/none}" },
    { id: "rework_iterations", label: "Rework iterations" },
    { id: "evidence_artifacts", label: "Evidence artifacts" },
  ],
  "refactor-reflector": [
    { id: "reflect_verdict", label: "Reflect verdict" },
    { id: "reflections", label: "Reflections applied / passed-through" },
    { id: "gate_outcome", label: "Gate-presentation outcome" },
    { id: "files_touched", label: "Files touched" },
  ],
  closer: [
    { id: "pr", label: "PR" },
    { id: "version", label: "Version" },
    { id: "milestone", label: "Milestone" },
    { id: "debrief_ship", label: "📦 Ship" },
    { id: "debrief_learn", label: "🧠 Learn" },
    { id: "debrief_self_reflect", label: "🔍 Self-Reflect" },
    { id: "debrief_notable", label: "📋 Notable" },
    { id: "debrief", label: "Debrief comment" },
  ],
};

/**
 * Normalise a label for lookup: strip a leading emoji/space run, trim, casefold.
 * Four closer labels lead with a glyph (`📦 Ship`, `🧠 Learn`, `🔍 Self-Reflect`,
 * `📋 Notable`) — the same glyph-unreliability that makes the heading match key on
 * WORDS. Applied to BOTH sides of the {@link STAGE_REPORT_LABEL_TO_ID} lookup.
 */
export function normalizeStageReportLabel(label: string): string {
  return label
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
    .toLowerCase();
}

/**
 * Inverse of the SPEC labels: normalised rendered label → field id. Covers the five
 * core rows plus all six variants. Used by the R4(C) tag branch to map a plain
 * table's `Field` cell back to its stable id.
 */
export const STAGE_REPORT_LABEL_TO_ID: Readonly<Record<string, string>> =
  (() => {
    const map: Record<string, string> = {};
    const add = (rows: readonly SpecRow[]): void => {
      for (const { id, label } of rows)
        map[normalizeStageReportLabel(label)] = id;
    };
    add(STAGE_REPORT_CORE);
    for (const stage of STAGE_NAMES) add(STAGE_REPORT_VARIANTS[stage]);
    return map;
  })();

const STAGE_NAME_SET: ReadonlySet<string> = new Set(STAGE_NAMES);

function isStageName(value: unknown): value is StageName {
  return typeof value === "string" && STAGE_NAME_SET.has(value);
}

/** The set of field ids valid for a given stage (core ∪ that stage's variants). */
function validIdsForStage(stage: StageName): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const { id } of STAGE_REPORT_CORE) ids.add(id);
  for (const { id } of STAGE_REPORT_VARIANTS[stage]) ids.add(id);
  return ids;
}

export interface StageReportExtra {
  label: string;
  value: string;
}

export interface StageReportSpec {
  stage: StageName;
  /** Field id → inline-markdown value string (only valid, string-typed ids kept). */
  fields: Record<string, string>;
  /** Label-keyed extra rows, rendered after the variant rows. */
  extras: StageReportExtra[];
  /** The declared payload schema version, when present. */
  payloadSchemaVersion?: string;
}

/**
 * Parse the JSON body of a `hapi_stage_report` fence into a validated spec, or
 * `null`. NEVER throws.
 *
 * STRUCTURAL failures → `null` (falls through to a plain code fence, R2): JSON parse
 * failure (including a truncated / mid-stream payload), a non-object root, a `stage`
 * outside the six, a non-object `fields`, or a `payload_schema_version` whose MAJOR
 * is not 1. PER-ENTRY failures are NOT structural (mirrors `parseQuickRepliesBlock`):
 * a `fields` value that is not a string, or an id not in the SPEC for this stage, is
 * SKIPPED and the rest of the card renders; a non-string / malformed `extras` entry
 * is skipped; a `fields.stage` key is ignored (top-level `stage` wins).
 */
export function parseStageReportBlock(code: string): StageReportSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return null; // streaming / invalid → plain fence (R2)
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // payload_schema_version: missing → accept; 1.x → accept; other major → null.
  const version = obj.payload_schema_version;
  if (version !== undefined) {
    if (typeof version !== "string") return null;
    const major = Number.parseInt(version.split(".")[0], 10);
    if (Number.isNaN(major) || major !== 1) return null;
  }

  if (!isStageName(obj.stage)) return null;
  const stage = obj.stage;

  if (
    !obj.fields ||
    typeof obj.fields !== "object" ||
    Array.isArray(obj.fields)
  ) {
    return null;
  }
  const rawFields = obj.fields as Record<string, unknown>;
  const validIds = validIdsForStage(stage);
  const fields: Record<string, string> = {};
  for (const [id, val] of Object.entries(rawFields)) {
    if (id === "stage") continue; // top-level stage is authoritative
    if (typeof val !== "string") continue; // per-entry skip, not structural
    if (!validIds.has(id)) continue; // id not in SPEC for this stage → skip
    fields[id] = val;
  }

  const extras: StageReportExtra[] = [];
  if (Array.isArray(obj.extras)) {
    for (const candidate of obj.extras) {
      if (!candidate || typeof candidate !== "object") continue;
      const entry = candidate as Record<string, unknown>;
      if (typeof entry.label !== "string" || typeof entry.value !== "string") {
        continue;
      }
      extras.push({ label: entry.label, value: entry.value });
    }
  }

  return {
    stage,
    fields,
    extras,
    payloadSchemaVersion: typeof version === "string" ? version : undefined,
  };
}

/** A rendered row: the `stage`/variant/extra id (null for an extra) + label + value. */
interface StageReportRenderRow {
  id: string | null;
  label: string;
  value: string;
}

/**
 * Build the ordered render rows: common-core rows first (present ones; the `stage`
 * core row always renders with the authoritative top-level value), then this
 * stage's variant rows (present ones), then the label-keyed extras.
 */
export function stageReportRows(spec: StageReportSpec): StageReportRenderRow[] {
  const rows: StageReportRenderRow[] = [];
  for (const { id, label } of STAGE_REPORT_CORE) {
    if (id === "stage") {
      rows.push({ id, label, value: spec.stage });
      continue;
    }
    const value = spec.fields[id];
    if (typeof value === "string") rows.push({ id, label, value });
  }
  for (const { id, label } of STAGE_REPORT_VARIANTS[spec.stage]) {
    const value = spec.fields[id];
    if (typeof value === "string") rows.push({ id, label, value });
  }
  for (const extra of spec.extras) {
    rows.push({ id: null, label: extra.label, value: extra.value });
  }
  return rows;
}

/**
 * Inline-markdown components for a card VALUE. `p` is unwrapped to a fragment so the
 * value renders inline (matching a plain GFM table cell, which has no `<p>`); `a`
 * and `code` mirror the house `markdown-text.tsx` styling so a value's links/paths
 * look identical whether rendered here (fence path) or by the table cell (tag path).
 */
const STAGE_REPORT_VALUE_MARKDOWN_COMPONENTS = {
  p: (props: ComponentPropsWithoutRef<"p">): ReactElement => (
    <>{props.children}</>
  ),
  // Inline `a` / `code` share the house styling via the leaf module (#3719) so a
  // value's links/paths look identical whether rendered here (fence path) or by
  // the table cell (tag path) — a single source of truth across all three surfaces.
  a: InlineMarkdownAnchor,
  code: InlineMarkdownCode,
};

/** Render one card value as live inline markdown (no assistant-ui thread context). */
function StageReportValue({ value }: { value: string }): ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkGemoji]}
      components={STAGE_REPORT_VALUE_MARKDOWN_COMPONENTS}
    >
      {value}
    </ReactMarkdown>
  );
}

/**
 * The single shared styling for a stage-report table, applied to the `<table>` in
 * BOTH render paths: the fence-path {@link StageReportCard} renders its OWN
 * `<table>` with this class, and the R4(C) tag branch styles the real markdown table
 * by applying it in the `Table` override (`markdown-text.tsx`). All cell styling is
 * expressed via descendant / `first-child` / `last-child` arbitrary variants, so:
 *   (1) the two paths cannot drift (one class governs both), and
 *   (2) the label vs value columns are styled WITHOUT per-cell classes — the tag
 *       branch tags the table + rows but never the cells, so descendant selectors
 *       are the only mechanism that reaches a cell, and their (0,1,1) specificity
 *       reliably overrides the base `Td` utilities (0,1,0).
 * The `[&_thead]:hidden` rule drops the plain table's `| Field | Value |` header row
 * in the tag path (the fence path renders no header) so both look identical.
 */
export const STAGE_REPORT_TABLE_CLASS = cn(
  "stage-report-card my-2 w-full border-collapse rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)]",
  "[&_thead]:hidden",
  "[&_tr]:border-b [&_tr]:border-[var(--app-border)] [&_tr:last-child]:border-b-0",
  "[&_td]:border-0 [&_td]:px-3 [&_td]:py-1.5 [&_td]:align-top [&_td]:text-xs",
  "[&_td:first-child]:w-[38%] [&_td:first-child]:font-medium [&_td:first-child]:text-[var(--app-hint)]",
  "[&_td:last-child]:whitespace-pre-wrap [&_td:last-child]:break-words [&_td:last-child]:text-[var(--app-fg)]"
);

/**
 * The rich stage-report card (fence path). Renders a vertical two-column table using
 * the SPEC labels — core rows first, then this stage's variant rows, then extras —
 * with each value as live inline markdown. Display-only: nothing is tappable, nothing
 * sends. Carries `data-stage-report` / per-row `data-field-id` so it matches the
 * tag-path table exactly.
 */
export function StageReportCard({
  spec,
}: {
  spec: StageReportSpec;
}): ReactElement {
  const rows = stageReportRows(spec);
  return (
    <div className="aui-md-table-wrapper max-w-full overflow-x-auto">
      <table
        className={STAGE_REPORT_TABLE_CLASS}
        data-stage-report={spec.stage}
        data-testid="stage-report-card"
      >
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row.id ?? `extra-${index}`}
              {...(row.id ? { "data-field-id": row.id } : {})}
            >
              <td>{row.label}</td>
              <td>
                <StageReportValue value={row.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The `SyntaxHighlighter` override registered for the `hapi_stage_report` fence. On a
 * valid spec it renders `<StageReportCard>`; on a `null` parse (streaming / invalid /
 * unknown-stage / major mismatch) it delegates to the real highlighter so the block
 * renders as an ordinary code fence (R2) — no throw, plain-text-operable, and it uses
 * no chat context so it degrades cleanly outside a thread.
 */
export function StageReportFence(props: SyntaxHighlighterProps): ReactElement {
  const spec = parseStageReportBlock(props.code);
  if (!spec) {
    return <SyntaxHighlighter {...props} />;
  }
  return <StageReportCard spec={spec} />;
}

/**
 * Per-language override map merged into `MarkdownText` (`markdown-text.tsx`). Routes a
 * `hapi_stage_report` fence through `StageReportFence` on every MarkdownText surface;
 * CodeHeader is suppressed so a rendered card carries no stray language header.
 */
export const STAGE_REPORT_COMPONENTS_BY_LANGUAGE = {
  [STAGE_REPORT_FENCE_LANGUAGE]: {
    SyntaxHighlighter: StageReportFence,
    CodeHeader: (): null => null,
  },
} as const;

// ── R4 mdast pre-pass (delete-on-fence + tag-on-no-fence) ────────────────────
//
// A minimal structural mdast typing — `unist-util-visit` and `@types/mdast` are
// transitive-only deps, and the heading / table / fence triple are all root-level
// `tree.children`, so a single `tree.children` scan needs neither.

interface MdastNode {
  type: string;
  value?: string;
  lang?: string | null;
  children?: MdastNode[];
  data?: { hProperties?: Record<string, string> } & Record<string, unknown>;
}
interface MdastRoot {
  type: string;
  children?: MdastNode[];
}

/** Concatenate all descendant text of an mdast node (formatting flattened). */
function mdastText(node: MdastNode): string {
  if (typeof node.value === "string") return node.value;
  if (Array.isArray(node.children)) {
    return node.children.map(mdastText).join("");
  }
  return "";
}

/** A heading whose text contains the WORDS "stage report" (never the 📊 glyph). */
function isStageReportHeading(node: MdastNode): boolean {
  return (
    node.type === "heading" &&
    mdastText(node).toLowerCase().includes("stage report")
  );
}

function isStageReportFence(node: MdastNode): boolean {
  return node.type === "code" && node.lang === STAGE_REPORT_FENCE_LANGUAGE;
}

/** Set an hProperty on a node's `data.hProperties` (create the chain as needed). */
function setHProperty(node: MdastNode, key: string, value: string): void {
  const data = node.data ?? (node.data = {});
  const hProperties = data.hProperties ?? (data.hProperties = {});
  hProperties[key] = value;
}

/**
 * R4(C) — TAG a plain stage-report table so it renders as the card. Reads the
 * `stage` from the table's own `Stage` row (`"unknown"` when absent), tags the
 * `<table>` with `data-stage-report`, and tags each body row whose `Field` cell maps
 * through {@link STAGE_REPORT_LABEL_TO_ID} with `data-field-id`. An unmatched label
 * gets no `data-field-id` and renders as an ordinary row (never an error).
 */
function tagStageReportTable(table: MdastNode): void {
  const rows = table.children ?? [];
  // Body rows are rows[1..] — rows[0] is the GFM header (`| Field | Value |`).
  let stage = "unknown";
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].children ?? [];
    if (cells.length < 2) continue;
    if (normalizeStageReportLabel(mdastText(cells[0])) === "stage") {
      const value = mdastText(cells[1]).trim();
      if (value) stage = value;
      break;
    }
  }
  setHProperty(table, "data-stage-report", stage);
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].children ?? [];
    if (cells.length < 1) continue;
    const id =
      STAGE_REPORT_LABEL_TO_ID[normalizeStageReportLabel(mdastText(cells[0]))];
    if (id) setHProperty(rows[r], "data-field-id", id);
  }
}

/**
 * The R4 remark plugin. ONE predicate, TWO outcomes (the adopted D6 hybrid):
 *   (A) a `hapi_stage_report` fence that PARSES removes its owning `heading + table`
 *       pair (the fence's nearest preceding table, skipping any intervening code
 *       fences such as an adjacent `hapi_quick_replies` block, plus a "Stage
 *       Report"-worded heading before it);
 *   (C) a stage-report `heading + table` pair with NO stage-report fence claiming it
 *       is TAGGED (data-stage-report + per-row data-field-id) — the shipping-producer
 *       path that keeps the card live.
 * A stage-report fence that is PRESENT but does NOT parse (truncated / mid-stream /
 * unknown-stage) leaves its table UNCHANGED (neither deleted nor tagged) — the table
 * stays visible until a complete fence arrives. Never throws.
 */
export function remarkStageReport(): (tree: MdastRoot) => void {
  return (tree: MdastRoot): void => {
    const children = tree.children;
    if (!Array.isArray(children)) return;

    const toDelete = new Set<number>();
    const hasPendingFence = new Set<number>();

    // Pass 1 — associate each stage-report fence with its nearest preceding table.
    for (let i = 0; i < children.length; i++) {
      if (!isStageReportFence(children[i])) continue;
      let j = i - 1;
      while (j >= 0 && children[j].type === "code") j--; // skip adjacent fences
      if (j < 0 || children[j].type !== "table") continue; // no owning table → no-op
      if (parseStageReportBlock(children[i].value ?? "")) {
        toDelete.add(j);
        if (j - 1 >= 0 && isStageReportHeading(children[j - 1])) {
          toDelete.add(j - 1);
        }
      } else {
        hasPendingFence.add(j); // present but invalid → leave the table unchanged
      }
    }

    // Pass 2 — tag a stage-report heading+table that no fence claims.
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node.type !== "table") continue;
      if (toDelete.has(i) || hasPendingFence.has(i)) continue;
      const prev = i - 1 >= 0 ? children[i - 1] : undefined;
      if (prev && isStageReportHeading(prev)) tagStageReportTable(node);
    }

    // Apply deletions high→low so earlier indices stay valid.
    for (const idx of [...toDelete].sort((a, b) => b - a)) {
      children.splice(idx, 1);
    }
  };
}
