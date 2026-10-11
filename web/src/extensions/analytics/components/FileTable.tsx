// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useMemo } from "react";
import type { TelemetryFile } from "@/types/api";

type SortKey = "filePath" | "fileType" | "count" | "lastSeen";
type SortDir = "asc" | "desc";

interface FileTableProps {
  files: TelemetryFile[];
  isLoading: boolean;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function FileTable({ files, isLoading }: FileTableProps) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("count");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const now = Date.now();

  const filtered = useMemo(() => {
    let result = files;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(f => f.filePath.toLowerCase().includes(q));
    }
    result = [...result].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortDir === "asc"
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }
      return sortDir === "asc"
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return result;
  }, [files, search, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  const formatLastSeen = (ts: number): string => {
    const diff = now - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  };

  const isPruningCandidate = (ts: number): boolean => now - ts > THIRTY_DAYS_MS;

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }

  return (
    <div>
      <input
        autoCapitalize="none"
        type="text"
        placeholder="Search files..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="mb-3 w-full rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-muted)] outline-none"
      />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--app-border)] text-[var(--app-muted)]">
              <th
                className="cursor-pointer px-2 py-2"
                onClick={() => handleSort("filePath")}
              >
                File{sortIndicator("filePath")}
              </th>
              <th
                className="cursor-pointer px-2 py-2"
                onClick={() => handleSort("fileType")}
              >
                Type{sortIndicator("fileType")}
              </th>
              <th
                className="cursor-pointer px-2 py-2 text-right"
                onClick={() => handleSort("count")}
              >
                Count{sortIndicator("count")}
              </th>
              <th
                className="cursor-pointer px-2 py-2 text-right"
                onClick={() => handleSort("lastSeen")}
              >
                Last Seen{sortIndicator("lastSeen")}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="py-8 text-center text-[var(--app-muted)]"
                >
                  {search ? "No matching files" : "No telemetry data"}
                </td>
              </tr>
            )}
            {filtered.map(f => (
              <tr
                key={f.filePath}
                className={`border-b border-[var(--app-border)] ${
                  isPruningCandidate(f.lastSeen) ? "bg-amber-900/20" : ""
                }`}
              >
                <td
                  className="max-w-[200px] truncate px-2 py-2 text-[var(--app-fg)]"
                  title={f.filePath}
                >
                  {f.filePath.split("/").pop()}
                </td>
                <td className="px-2 py-2">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                      f.fileType === "hook"
                        ? "bg-emerald-900/40 text-emerald-300"
                        : f.fileType === "skill"
                          ? "bg-blue-900/40 text-blue-300"
                          : "bg-orange-900/40 text-orange-300"
                    }`}
                  >
                    {f.fileType}
                  </span>
                </td>
                <td className="px-2 py-2 text-right text-[var(--app-fg)] tabular-nums">
                  {f.count.toLocaleString()}
                </td>
                <td className="px-2 py-2 text-right text-[var(--app-muted)] tabular-nums">
                  {formatLastSeen(f.lastSeen)}
                  {isPruningCandidate(f.lastSeen) && (
                    <span
                      className="ml-1 text-amber-400"
                      title="Pruning candidate — no usage in 30+ days"
                    >
                      ⚠
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
