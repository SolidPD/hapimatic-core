// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

/**
 * CatalogKit — the small presentational scaffolding shared by every catalog entry
 * (Interface Design System Sub-Issue H, #3036). Intentionally trivial: the catalog's
 * job is to render the REAL design-system components, so the scaffolding around them
 * stays out of the way. Dev-only — this module is only reachable through the
 * `import.meta.env.DEV`-gated `/design` route.
 */

/** One component's showcase block: heading + kind badge + a column of specimen rows. */
export function CatalogEntry({
  id,
  title,
  kind,
  note,
  children,
}: {
  id: string;
  title: string;
  kind: "primitive" | "composite" | "template";
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article
      id={id}
      className="scroll-mt-24 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-4"
    >
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-[var(--app-fg)]">
          {title}
        </h3>
        <Badge variant={kind === "primitive" ? "mint" : "subscription"}>
          {kind}
        </Badge>
      </header>
      {note ? (
        <p className="mb-3 text-xs text-[var(--app-hint)]">{note}</p>
      ) : null}
      <div className="flex flex-col gap-4">{children}</div>
    </article>
  );
}

/** A labelled row of specimens (e.g. "variants", "sizes", "states"). */
export function SpecimenRow({
  label,
  children,
  align = "center",
}: {
  label: string;
  children: ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
        {label}
      </span>
      <div
        className={`flex flex-wrap gap-3 ${
          align === "start" ? "items-start" : "items-center"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

/** A single specimen cell: the rendered example over an optional caption. */
export function Specimen({
  caption,
  children,
}: {
  caption?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex min-h-8 items-center">{children}</div>
      {caption ? (
        <span className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
          {caption}
        </span>
      ) : null}
    </div>
  );
}
