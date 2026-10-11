// SPDX-License-Identifier: AGPL-3.0-only
import type { TelemetrySessionAggregate } from "@/types/api";

interface SessionProfilesProps {
  sessions: TelemetrySessionAggregate[];
  isLoading: boolean;
}

const ARCHETYPE_CONFIG: Record<
  string,
  { label: string; color: string; icon: string }
> = {
  "issue-workflow": {
    label: "Issue Workflow",
    color: "bg-[#5ae6ab]/20 text-[#5ae6ab]",
    icon: "🔧",
  },
  debugging: {
    label: "Debugging",
    color: "bg-red-500/20 text-red-400",
    icon: "🐛",
  },
  "skill-driven": {
    label: "Skill-Driven",
    color: "bg-blue-500/20 text-blue-400",
    icon: "⚡",
  },
  "agent-driven": {
    label: "Agent-Driven",
    color: "bg-purple-500/20 text-purple-400",
    icon: "🤖",
  },
  exploratory: {
    label: "Exploratory",
    color: "bg-yellow-500/20 text-yellow-400",
    icon: "🔍",
  },
  empty: {
    label: "Empty",
    color: "bg-gray-500/20 text-gray-400",
    icon: "💤",
  },
};

export function SessionProfiles({ sessions, isLoading }: SessionProfilesProps) {
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        No session data yet
      </div>
    );
  }

  // Group by archetype for summary
  const archetypeCounts: Record<string, number> = {};
  for (const s of sessions) {
    archetypeCounts[s.archetype] = (archetypeCounts[s.archetype] ?? 0) + 1;
  }

  const sortedArchetypes = Object.entries(archetypeCounts).sort(
    ([, a], [, b]) => b - a
  );

  return (
    <div>
      {/* Archetype distribution */}
      <div className="mb-4 flex flex-wrap gap-2">
        {sortedArchetypes.map(([archetype, count]) => {
          const cfg = ARCHETYPE_CONFIG[archetype] ?? {
            label: archetype,
            color: "bg-gray-500/20 text-gray-400",
            icon: "?",
          };
          return (
            <div
              key={archetype}
              className={`rounded-full px-3 py-1 text-xs font-medium ${cfg.color}`}
            >
              {cfg.icon} {cfg.label}: {count}
            </div>
          );
        })}
      </div>

      {/* Session list */}
      <div className="space-y-2 overflow-y-auto" style={{ maxHeight: "20rem" }}>
        {sessions.slice(0, 30).map(s => {
          const cfg = ARCHETYPE_CONFIG[s.archetype] ?? {
            label: s.archetype,
            color: "bg-gray-500/20 text-gray-400",
            icon: "?",
          };
          const duration = s.endTime - s.startTime;
          const durationMin = Math.round(duration / 60000);

          return (
            <div
              key={s.sessionId}
              className="rounded-md bg-[var(--app-bg)] p-3"
            >
              <div className="flex items-center justify-between">
                <span className="truncate text-xs font-mono text-[var(--app-fg)]">
                  {s.sessionId.slice(0, 20)}...
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cfg.color}`}
                >
                  {cfg.icon} {cfg.label}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
                <div>
                  <div className="text-[var(--app-muted)]">Events</div>
                  <div className="font-medium text-[var(--app-fg)]">
                    {s.totalEvents}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--app-muted)]">Files</div>
                  <div className="font-medium text-[var(--app-fg)]">
                    {s.uniqueFiles}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--app-muted)]">Duration</div>
                  <div className="font-medium text-[var(--app-fg)]">
                    {durationMin}m
                  </div>
                </div>
                <div>
                  <div className="text-[var(--app-muted)]">Errors</div>
                  <div
                    className={`font-medium ${s.errorCount > 0 ? "text-red-400" : "text-[var(--app-fg)]"}`}
                  >
                    {s.errorCount}
                  </div>
                </div>
              </div>
              <div className="mt-1 text-[10px] text-[var(--app-muted)]">
                {new Date(s.startTime).toLocaleString()} — H:{s.hookCount} S:
                {s.skillCount} A:{s.agentCount}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
