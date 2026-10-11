// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `@hapi/protocol` graph-viz barrel — issue #2887 (Phase 1, sub-issue E).
 *
 * Re-exports the web-safe Mermaid visualizer. Re-exported in turn from the root
 * graph barrel (`shared/src/graph/index.ts`) as the 5th and final CF-2 append —
 * `toMermaid` is pure string output with no runtime dependency, so it is safe to
 * pull through the browser-facing root barrel.
 */
export * from "./mermaid";
