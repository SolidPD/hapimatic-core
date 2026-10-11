// SPDX-License-Identifier: AGPL-3.0-only
import { type FormEvent, type ReactNode } from "react";

export interface DialogFormProps {
  /** Title / heading region. Never scrolls. */
  title?: ReactNode;
  /** Form body — the single scroll owner. */
  children: ReactNode;
  /** Action row (e.g. Cancel / Submit). Never scrolls; stays pinned to the bottom. */
  footer?: ReactNode;
  /** Submit handler for the wrapping `<form>`. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  /** Extra classes merged onto the `<form>` root. */
  className?: string;
}

/**
 * DialogForm — the form-inside-a-surface layout template (Interface Design System
 * Sub-Issue E, epic #3028). A form laid out for a bounded surface (dialog / drawer /
 * sheet): a pinned title, a scrollable body, and a pinned action footer.
 *
 * Regions (top → bottom): title · body · footer. Exactly ONE scroll owner: the body
 * (`overflow-y-auto`). Title and footer are `flex-shrink-0` so the actions stay
 * reachable while a long form scrolls beneath them (#2830 invariant, generalized).
 *
 * Surface selection (dialog vs drawer vs popover vs full page) is a documented
 * decision in the layout catalog — DialogForm is the CONTENT of whichever bounded
 * surface the caller picks, not the surface chrome itself.
 *
 * See the layout catalog at `docs/design/design-system/layouts.md`.
 */
export function DialogForm({
  title,
  children,
  footer,
  onSubmit,
  className,
}: DialogFormProps) {
  return (
    <form
      onSubmit={onSubmit}
      className={`flex max-h-full min-h-0 flex-col${
        className ? ` ${className}` : ""
      }`}
    >
      {title != null && <div className="flex-shrink-0">{title}</div>}
      <div data-region="body" className="min-h-0 flex-1 overflow-y-auto">
        {children}
      </div>
      {footer != null && <div className="flex-shrink-0">{footer}</div>}
    </form>
  );
}
