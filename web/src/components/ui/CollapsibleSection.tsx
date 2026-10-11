// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from "react";
import { ChevronIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

export interface CollapsibleSectionProps {
  /** Header title. Accepts any node (e.g. text, or text + inline glyph). */
  title: React.ReactNode;
  /** Optional icon rendered inside the leading accent-tinted icon-tile. */
  icon?: React.ReactNode;
  /** One-line digest shown ONLY when collapsed (hidden when expanded). */
  summary?: React.ReactNode;
  /** Controlled open state. When provided, the parent owns the state. */
  open?: boolean;
  /** Uncontrolled initial open state (ignored when `open` is provided). */
  defaultOpen?: boolean;
  /** Fired with the next open state whenever the header is activated. */
  onOpenChange?: (open: boolean) => void;
  /** Body content, rendered ONLY when expanded. */
  children: React.ReactNode;
  /** Optional wrapper class passthrough (merged via `cn`). */
  className?: string;
  "data-testid"?: string;
}

/**
 * `CollapsibleSection` — the accordion shell shared by the Session Metadata
 * (SM03) and About (AB06) pages (Epic B, #1982 / #1983). A header row
 * (leading icon-tile + title + collapsed-only summary + rotating chevron)
 * expands to reveal a body. The summary shows only when collapsed; the body
 * shows only when expanded — the two never render simultaneously.
 *
 * Reads all colors / spacing / radii from the design tokens (#1977 A1): the
 * accent tile/ring use the `accent` utilities (`bg-accent/15`, `text-accent`,
 * `ring-accent`, runtime-swappable via `--palette-accent`); non-accent
 * surfaces use the `var(--app-*)` tokens. No literal hex or hardcoded radius.
 *
 * Uncontrolled (self-managed):
 * ```tsx
 * <CollapsibleSection title="Details" summary="3 items" defaultOpen>
 *   <Body />
 * </CollapsibleSection>
 * ```
 *
 * Controlled (parent owns a `Set<string>` of open keys — the idiom Epic B
 * consumes; use a per-item closure, do NOT invent a keyed variant):
 * ```tsx
 * <CollapsibleSection
 *   title="Details"
 *   open={openKeys.has(key)}
 *   onOpenChange={next =>
 *     setOpenKeys(prev => {
 *       const nextSet = new Set(prev);
 *       next ? nextSet.add(key) : nextSet.delete(key);
 *       return nextSet;
 *     })
 *   }
 * >
 *   <Body />
 * </CollapsibleSection>
 * ```
 */
export function CollapsibleSection({
  title,
  icon,
  summary,
  open,
  defaultOpen,
  onOpenChange,
  children,
  className,
  "data-testid": dataTestid,
}: CollapsibleSectionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen ?? false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const bodyId = useId();

  const toggle = () => {
    const next = !isOpen;
    // In controlled mode the parent owns the state — notify only, don't fork it.
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div
      data-testid={dataTestid}
      className={cn(
        "overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)]",
        className
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        // Conditional: the body is only in the DOM while expanded, so the
        // referenced id must exist whenever aria-controls is present (axe
        // aria-valid-attr-value). Native <button> gives Enter/Space for free.
        aria-controls={isOpen ? bodyId : undefined}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--app-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        {icon && (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
            {icon}
          </span>
        )}
        <span className="min-w-0 truncate text-sm font-medium text-[var(--app-fg)]">
          {title}
        </span>
        {!isOpen && summary && (
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)] text-[var(--app-hint)]">
            {summary}
          </span>
        )}
        <ChevronIcon
          className="ml-auto h-4 w-4 shrink-0 text-[var(--app-hint)]"
          collapsed={!isOpen}
        />
      </button>
      {isOpen && (
        <div id={bodyId} className="px-3 pb-3">
          {children}
        </div>
      )}
    </div>
  );
}
