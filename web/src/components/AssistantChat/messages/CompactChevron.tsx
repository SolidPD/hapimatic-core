// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "@/lib/utils";

/**
 * Shared collapse chevron (#2989, epic #2987 coordination b2). Lives in its OWN
 * pure module — NOT inside the heavily-mocked `ToolMessage` — so the shared
 * `CollapsibleSectionRow` primitive (and S3/S4) can import it without every
 * `vi.mock("…/ToolMessage")` in the suite having to re-export it. Under the
 * web suite's `isolate: false` shared module registry, an incomplete ToolMessage
 * mock in one test file would otherwise poison this import for every other file
 * (the CI-only failure this module fixes). `ToolMessage` re-exports it for the
 * b2 contract, so existing `from "…/ToolMessage"` importers keep working.
 */
export function CompactChevron(props: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        // `hapi-cat-chevron`: the S4 marker (#2991) the `[data-cat] .hapi-cat-chevron`
        // rule tints with the category hue. Inert outside a `[data-cat]` ancestor.
        "hapi-cat-chevron shrink-0 transition-transform duration-200",
        props.open ? "rotate-90" : ""
      )}
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
