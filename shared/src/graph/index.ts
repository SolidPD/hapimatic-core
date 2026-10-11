// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `@hapi/protocol` graph-engineering barrel — issue #2883 (Phase 1, sub-issue A).
 *
 * 🔒 APPEND-ONLY (coordination constraint CF-2): sub-issues #2884, #2885, #2886,
 * and #2887 append their own `export * from "./…"` lines below. Do NOT reorder
 * or remove existing exports — downstream sub-issues import specific symbols and
 * a reorder is a needless churn diff for every consumer.
 */
export * from "./ir";
export * from "./validate";

// ── issue #2884 (Phase 1, sub-issue B) — lint contract + INCIDENT_DERIVED rules ──
// APPEND-ONLY (CF-2): #2885/#2886/#2887 append their own lines below; do not reorder.
export * from "./lint/types";
export * from "./lint/incident-derived";

// ── issue #2885 (Phase 1, sub-issue C) — linter engine + SEMANTIC_INVARIANT rules ──
// APPEND-ONLY (CF-2): #2886/#2887 append their own lines below; do not reorder.
export * from "./lint/engine";
export * from "./lint/semantic-invariant";

// ── issue #2886 (Phase 1, sub-issue D) — deterministic compiler + STRICT_RESUME + effect ledger ──
// APPEND-ONLY (CF-2): #2887 appends its own line below; do not reorder.
// WEB-SAFE re-export: only the compile TYPES go in the root-barrel-reachable
// graph barrel (browser consumers like #2887 need `CompiledWorkflow`). The
// node:crypto RUNTIME (compileIR / recordLaunchHash / checkResume / …) is exposed
// via the `@hapi/protocol/graph/compile` subpath — NOT here — mirroring the
// `@hapi/protocol/gitRoot` (node:fs) subpath pattern. See compile/types.ts.
export * from "./compile/types";

// ── issue #2887 (Phase 1, sub-issue E) — Mermaid visualizer (5th & FINAL CF-2 append) ──
// APPEND-ONLY (CF-2): #2887 is the last Phase-1 writer to this barrel. `toMermaid`
// is pure, web-safe string output (no runtime dep), so it is safe to re-export
// here for browser consumers. The example workflows (`./examples/*`) stay
// UN-barreled — the locked Phase-2 export is the `@hapi/protocol/graph/examples/
// issue-workflow` package.json subpath, not a root-barrel re-export.
export * from "./viz";

// ── issue #2891 (Phase 2, sub-issue C) — RunRecord canonical execution view ──
// APPEND-ONLY (the CF-2 discipline continues into Phase 2): the FIRST Phase-2
// export appended here, after the five Phase-1 lines. `run-record.ts` is
// WEB-SAFE (zod-only, no `node:crypto` — see its "WEB-SAFE MODULE" note), so it
// is barrel-reachable exactly like the compile TYPES. #2892 (the evidence report)
// reads `RunRecord` by field; do NOT reorder or remove the exports above it.
export * from "./run-record";
