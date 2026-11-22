// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6779 (plan section 6): "Recent changes", the last rows of the list's
 * history, collapsed by default and shown on the owner only. The query runs
 * only while the section is open. One line per row: the time, then what
 * changed in words.
 */
import { useState } from "react";
import type { BillingCategoryHistoryRow } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { useBillingCategoryHistory } from "@/hooks/queries/useBillingCategories";
import { BILLING_ROW_BOX, rateLabel } from "./BillingCategoryRow";

type Snapshot = Record<string, unknown>;

function asSnapshot(value: unknown): Snapshot | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Snapshot)
    : null;
}

function str(snapshot: Snapshot | null, key: string): string | null {
  const value = snapshot?.[key];
  return typeof value === "string" ? value : null;
}

/** A snapshot's rate in words, or null for no rate or an unreadable pair. */
function rateWords(snapshot: Snapshot | null): string | null {
  const minor = snapshot?.defaultRateMinor;
  const currency = snapshot?.defaultCurrency;
  if (typeof minor !== "number" || typeof currency !== "string") return null;
  return rateLabel({ minor, currency }).text;
}

/**
 * What one history row says, e.g. "Renamed Kestrel review to Kestrel design
 * review". `names` resolves a category id the row does not name itself.
 */
export function describeHistoryRow(
  row: BillingCategoryHistoryRow,
  names: ReadonlyMap<string, string>
): string {
  const before = asSnapshot(row.before);
  const after = asSnapshot(row.after);
  const name =
    str(after, "name") ??
    str(before, "name") ??
    (row.subjectId ? names.get(row.subjectId) : undefined) ??
    "a category";
  switch (row.kind) {
    case "seeded":
      return "Started the list";
    case "added":
      return `Added ${name}`;
    case "renamed":
      return `Renamed ${str(before, "name") ?? "a category"} to ${name}`;
    case "rate-set": {
      const rate = rateWords(after);
      return rate
        ? `Set the default rate of ${name} to ${rate}`
        : `Set the default rate of ${name}`;
    }
    case "rate-cleared":
      return `Cleared the default rate of ${name}`;
    case "retired":
      return `Retired ${name}`;
    case "restored":
      return `Restored ${name}`;
    case "updated":
      return `Changed ${name}`;
    case "reordered":
      return "Reordered the list";
    case "default-set": {
      const id = str(after, "defaultCategoryId");
      return `Made ${(id && names.get(id)) ?? "a category"} the default`;
    }
    case "currency-set":
      return `Set the currency for new rates to ${str(after, "currency") ?? "another code"}`;
    case "settings-updated":
      return "Changed the list's settings";
    default:
      return "Changed the list";
  }
}

/** "14:02" today, else "Nov 19 14:02" (a date, never a currency). */
export function historyTime(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  const day = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day} ${time}`;
}

export function BillingCategoryHistoryList(props: {
  api: ApiClient | null;
  names: ReadonlyMap<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const history = useBillingCategoryHistory(props.api, open);
  return (
    <CollapsibleSection
      title="Recent changes"
      open={open}
      onOpenChange={setOpen}
    >
      {history.isLoading ? (
        <p className="text-sm text-[var(--app-hint)]">Loading…</p>
      ) : history.isError ? (
        <p className="text-sm text-[var(--status-warn)]" role="status">
          Recent changes could not be loaded.
        </p>
      ) : (history.data?.rows.length ?? 0) === 0 ? (
        <p className="text-sm text-[var(--app-hint)]">No changes yet.</p>
      ) : (
        <ul
          className="flex flex-col gap-1"
          data-testid="billing-category-history"
        >
          {history.data?.rows.map(row => {
            const text = describeHistoryRow(row, props.names);
            return (
              <li key={row.id} className={`${BILLING_ROW_BOX} text-sm`}>
                <span className="shrink-0 tabular-nums text-[var(--app-hint)]">
                  {historyTime(row.at)}
                </span>
                <span aria-hidden className="text-[var(--app-hint)]">
                  ·
                </span>
                <span
                  className="min-w-0 truncate text-[var(--app-fg)]"
                  title={text}
                >
                  {text}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </CollapsibleSection>
  );
}
