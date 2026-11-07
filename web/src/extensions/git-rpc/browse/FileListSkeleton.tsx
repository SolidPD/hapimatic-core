// SPDX-License-Identifier: AGPL-3.0-only

// The Files tab's loading placeholder, moved from routes/files.tsx (#6224).
export function FileListSkeleton(props: { label: string; rows?: number }) {
  const titleWidths = ["w-1/3", "w-1/2", "w-2/3", "w-2/5", "w-3/5"];
  const subtitleWidths = ["w-1/2", "w-2/3", "w-3/4", "w-1/3"];
  const rows = props.rows ?? 6;

  return (
    <div
      className="p-3 animate-pulse space-y-3"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">{props.label}</span>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={`skeleton-row-${index}`} className="flex items-center gap-3">
          <div className="h-6 w-6 rounded bg-[var(--app-subtle-bg)]" />
          <div className="flex-1 space-y-2">
            <div
              className={`h-3 ${titleWidths[index % titleWidths.length]} rounded bg-[var(--app-subtle-bg)]`}
            />
            <div
              className={`h-2 ${subtitleWidths[index % subtitleWidths.length]} rounded bg-[var(--app-subtle-bg)]`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
