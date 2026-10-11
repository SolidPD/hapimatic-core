// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * KVGrid — a responsive key/value metadata grid for the shared design-system
 * dense-list atoms (A3 / #1979). This is the SM03 expanded-metadata layout consumed
 * by #1982 (Session Metadata) and A4 page migrations.
 *
 * Renders a two-column grid on >= sm (640px) that reflows to a SINGLE readable column
 * at 393px (below the sm breakpoint), guaranteeing no horizontal scroll on mobile.
 * Each cell stacks a small uppercase key label above its value.
 *
 * Locked prop-API contract: `items` is a flat `{ key, value }[]` array (a single API,
 * not a compound `KVGrid` + `KVGrid.Item`).
 */
export interface KVGridItem {
  key: ReactNode;
  value: ReactNode;
}

export interface KVGridProps {
  items: KVGridItem[];
  className?: string;
}

export function KVGrid({ items, className }: KVGridProps) {
  return (
    <dl
      className={cn(
        "grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2",
        className
      )}
    >
      {items.map((item, i) => (
        <div key={i} className="flex min-w-0 flex-col">
          <dt className="truncate text-[length:var(--text-body-dense)] uppercase tracking-wide text-[var(--app-hint)]">
            {item.key}
          </dt>
          <dd className="text-[length:var(--text-body)] break-words text-[var(--app-fg)]">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
