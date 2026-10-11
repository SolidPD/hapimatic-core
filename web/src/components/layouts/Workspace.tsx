// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode } from "react";

export interface WorkspaceProps {
  /** Optional header region (e.g. a session sub-header). Never scrolls. */
  header?: ReactNode;
  /** Working-area content — clamped to the readable content column by default. */
  children: ReactNode;
  /** Optional footer region (e.g. a composer). Never scrolls. */
  footer?: ReactNode;
  /**
   * SPATIAL toggle: fill the full width instead of the readable content column
   * (`max-w-content`). WIDTH/spatial only — never an interaction or device signal
   * (decision-layout-adaptation.md L-2).
   */
  fullWidth?: boolean;
  /**
   * When true (default) the content region owns a single scroll container
   * (`overflow-y-auto`). When false it is `overflow-hidden` and the child manages
   * its own fixed display (terminal / desktop / canvas).
   */
  scrollable?: boolean;
}

/**
 * Workspace — the working-area layout template (Interface Design System Sub-Issue E,
 * epic #3028). The sessions chat / terminal working surface: an optional header, a
 * content region centered to the readable content column (`max-w-content`), and an
 * optional footer (composer).
 *
 * Regions (top → bottom): header · content · footer. Exactly ONE scroll owner: the
 * content region (`overflow-y-auto`), or `overflow-hidden` when `scrollable={false}`
 * and the child owns its display. Header/footer are `flex-shrink-0` and never scroll
 * (#2830 invariant, generalized).
 *
 * See the layout catalog at `docs/design/design-system/layouts.md`.
 */
export function Workspace({
  header,
  children,
  footer,
  fullWidth = false,
  scrollable = true,
}: WorkspaceProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {header != null && <div className="flex-shrink-0">{header}</div>}
      <div
        data-region="workspace-content"
        className={`flex min-h-0 flex-1 flex-col ${
          scrollable ? "overflow-y-auto" : "overflow-hidden"
        }`}
      >
        <div
          className={`flex min-h-0 w-full flex-1 flex-col ${
            fullWidth ? "" : "mx-auto max-w-content"
          }`}
        >
          {children}
        </div>
      </div>
      {footer != null && <div className="flex-shrink-0">{footer}</div>}
    </div>
  );
}
