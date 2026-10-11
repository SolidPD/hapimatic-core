// SPDX-License-Identifier: AGPL-3.0-only
import type { TelemetrySummary } from "@/types/api";

interface UsageOverviewProps {
  summary: TelemetrySummary | null;
  isLoading: boolean;
}

export function UsageOverview({ summary, isLoading }: UsageOverviewProps) {
  const totalEvents = summary?.byType.reduce((acc, t) => acc + t.count, 0) ?? 0;
  const uniqueFiles = summary?.byFile.length ?? 0;
  const typeBreakdown = summary?.byType ?? [];

  const cards = [
    { label: "Total Events", value: totalEvents },
    { label: "Unique Files", value: uniqueFiles },
    ...typeBreakdown.map(t => ({
      label: `${t.fileType.charAt(0).toUpperCase() + t.fileType.slice(1)}s`,
      value: t.count,
    })),
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map(card => (
        <div
          key={card.label}
          className="rounded-lg bg-[var(--app-secondary-bg)] p-4"
        >
          <div className="text-xs text-[var(--app-muted)] uppercase tracking-wider">
            {card.label}
          </div>
          <div className="mt-1 text-2xl font-semibold text-[var(--app-fg)]">
            {isLoading ? "..." : card.value.toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}
