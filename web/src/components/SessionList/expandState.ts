// SPDX-License-Identifier: AGPL-3.0-only
// Per-project + per-session expand/collapse state (localStorage-backed hooks).
// Extracted from SessionList.tsx (issue #2083, epic #2077 F) — verbatim move,
// re-exported through the SessionList barrel to preserve public import paths.
// NOTE: SESSION_EXPANDED_KEY ("hapi:expandedSessions") is also hardcoded in
// web/src/lib/localStorageCleanup.ts:82 (pre-existing duplication; unaffected here).
import { useState } from "react";

// Per-project expand/collapse state - stores expanded project directories
// Format: { "/path": { expanded: true, lastAccessed: 1707145200000 } }
// Legacy format (auto-migrated): { "/path": true }
const PROJECT_EXPAND_KEY = "hapi:projectExpandState";

interface ProjectExpandEntry {
  expanded: boolean;
  lastAccessed: number;
}

type ProjectExpandStore = Record<string, ProjectExpandEntry>;

/**
 * Load project expand state from localStorage, migrating legacy boolean format if needed.
 */
function loadProjectExpandState(): Map<string, boolean> {
  try {
    const stored = localStorage.getItem(PROJECT_EXPAND_KEY);
    if (!stored) return new Map();

    const parsed = JSON.parse(stored) as Record<
      string,
      boolean | ProjectExpandEntry
    >;
    const now = Date.now();
    const result = new Map<string, boolean>();
    let needsMigration = false;

    for (const [path, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") {
        // Legacy format — migrate
        result.set(path, value);
        needsMigration = true;
      } else if (
        typeof value === "object" &&
        value !== null &&
        "expanded" in value
      ) {
        result.set(path, value.expanded);
      }
    }

    if (needsMigration) {
      // Write back in new format
      const migrated: ProjectExpandStore = {};
      result.forEach((expanded, path) => {
        migrated[path] = { expanded, lastAccessed: now };
      });
      localStorage.setItem(PROJECT_EXPAND_KEY, JSON.stringify(migrated));
    }

    return result;
  } catch {
    return new Map();
  }
}

export function useProjectExpandState(): [
  Map<string, boolean>,
  (directory: string, expanded: boolean) => void,
] {
  const [expandState, setExpandState] = useState<Map<string, boolean>>(
    loadProjectExpandState
  );

  const setExpanded = (directory: string, expanded: boolean) => {
    setExpandState(prev => {
      const next = new Map(prev);
      next.set(directory, expanded);
      // Persist to localStorage in timestamped format
      try {
        const raw = localStorage.getItem(PROJECT_EXPAND_KEY);
        const existing: ProjectExpandStore = raw ? JSON.parse(raw) : {};
        // Preserve existing entries and their timestamps, update the changed one
        const obj: ProjectExpandStore = {};
        for (const [path, entry] of Object.entries(existing)) {
          if (
            typeof entry === "object" &&
            entry !== null &&
            "expanded" in entry
          ) {
            obj[path] = entry as ProjectExpandEntry;
          }
        }
        next.forEach((v, k) => {
          obj[k] = {
            expanded: v,
            lastAccessed:
              k === directory
                ? Date.now()
                : (obj[k]?.lastAccessed ?? Date.now()),
          };
        });
        localStorage.setItem(PROJECT_EXPAND_KEY, JSON.stringify(obj));
      } catch {
        // Ignore localStorage errors
      }
      return next;
    });
  };

  return [expandState, setExpanded];
}

// Per-session expand/collapse state - stores expanded session IDs
const SESSION_EXPANDED_KEY = "hapi:expandedSessions";

export function useExpandedSessions(): [
  Set<string>,
  (sessionId: string) => void,
  (ids: Set<string>) => void,
] {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(SESSION_EXPANDED_KEY);
      if (stored) {
        const ids = JSON.parse(stored) as string[];
        return new Set(ids);
      }
    } catch {
      // Ignore parse errors
    }
    return new Set();
  });

  const toggleExpanded = (sessionId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      // Persist to localStorage
      try {
        localStorage.setItem(SESSION_EXPANDED_KEY, JSON.stringify([...next]));
      } catch {
        // Ignore localStorage errors
      }
      return next;
    });
  };

  const setAllExpanded = (ids: Set<string>) => {
    setExpandedIds(ids);
    try {
      localStorage.setItem(SESSION_EXPANDED_KEY, JSON.stringify([...ids]));
    } catch {
      // Ignore localStorage errors
    }
  };

  return [expandedIds, toggleExpanded, setAllExpanded];
}
