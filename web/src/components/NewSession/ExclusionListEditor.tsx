// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useState } from "react";
import { generateUSHolidayExclusions } from "@hapi/protocol";
import { FormField } from "./FormField";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";

function nowDatetimeLocal(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export type ExclusionEntryUI = {
  id: string;
  startAt: string;
  endAt: string;
  description: string;
  annualRepeat: boolean;
};

export function ExclusionListEditor(props: {
  exclusions: ExclusionEntryUI[];
  onChange: (exclusions: ExclusionEntryUI[]) => void;
  isDisabled?: boolean;
}) {
  const { exclusions, onChange, isDisabled = false } = props;
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newEntry, setNewEntry] = useState<Omit<ExclusionEntryUI, "id">>({
    startAt: "",
    endAt: "",
    description: "",
    annualRepeat: true,
  });

  const handleAdd = () => {
    if (!newEntry.startAt || !newEntry.endAt) return;
    if (editingId) {
      // Save edit
      onChange(
        exclusions.map(e =>
          e.id === editingId ? { ...newEntry, id: editingId } : e
        )
      );
      setEditingId(null);
    } else {
      // Add new
      const entry: ExclusionEntryUI = {
        ...newEntry,
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      };
      onChange([...exclusions, entry]);
    }
    setNewEntry({
      startAt: "",
      endAt: "",
      description: "",
      annualRepeat: true,
    });
    setAdding(false);
  };

  const handleEdit = (entry: ExclusionEntryUI) => {
    setEditingId(entry.id);
    setNewEntry({
      startAt: entry.startAt,
      endAt: entry.endAt,
      description: entry.description,
      annualRepeat: entry.annualRepeat,
    });
    setAdding(true);
  };

  const handleCancelForm = () => {
    setAdding(false);
    setEditingId(null);
    setNewEntry({
      startAt: "",
      endAt: "",
      description: "",
      annualRepeat: true,
    });
  };

  const handleRemove = (id: string) => {
    onChange(exclusions.filter(e => e.id !== id));
  };

  const handleAddUSHolidays = () => {
    const currentYear = new Date().getFullYear();
    const holidays = generateUSHolidayExclusions(currentYear, 3);

    const entries: ExclusionEntryUI[] = holidays.map(h => {
      const year = h.year ?? currentYear;
      const monthStr = String(h.month).padStart(2, "0");
      const dayStr = String(h.day).padStart(2, "0");
      return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        startAt: `${year}-${monthStr}-${dayStr}T00:00`,
        endAt: `${year}-${monthStr}-${dayStr}T23:59`,
        description: h.name,
        annualRepeat: true,
      };
    });

    onChange([...exclusions, ...entries]);
  };

  return (
    <div className="flex flex-col gap-2">
      {exclusions.length === 0 && !adding && (
        <p className="text-xs text-[var(--app-hint)] italic">No exclusions</p>
      )}

      {/* Exclusion list */}
      {exclusions.length > 0 && (
        <div className="max-h-48 overflow-y-auto flex flex-col gap-1.5">
          {exclusions.map(entry => (
            <div
              key={entry.id}
              className={`flex items-start gap-2 rounded-md border bg-[var(--app-secondary-bg)] px-2.5 py-1.5 transition-colors ${
                editingId === entry.id
                  ? "border-[var(--app-link)]"
                  : "border-[var(--app-border)] cursor-pointer hover:bg-[var(--app-hover)]"
              }`}
              onClick={() => {
                if (!isDisabled && editingId !== entry.id) handleEdit(entry);
              }}
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-[var(--app-fg)] truncate">
                  {entry.description || "Untitled"}
                </div>
                <div className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
                  {formatDateRange(entry.startAt, entry.endAt)}
                  {entry.annualRepeat && " (annual)"}
                </div>
              </div>
              <BareButton
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  handleRemove(entry.id);
                }}
                disabled={isDisabled}
                className="shrink-0 p-0.5 text-[var(--app-hint)] hover:text-red-400 transition-colors disabled:opacity-50 focus-visible:ring-0"
                title="Remove"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </BareButton>
            </div>
          ))}
        </div>
      )}

      {/* Add entry form */}
      {adding && (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2.5">
          <FormField label="Description">
            <input
              autoCapitalize="none"
              type="text"
              value={newEntry.description}
              onChange={e =>
                setNewEntry(prev => ({ ...prev, description: e.target.value }))
              }
              disabled={isDisabled}
              placeholder="e.g. Company holiday"
              className="w-full rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
            />
          </FormField>

          <div className="grid grid-cols-2 gap-2">
            <FormField label="Start">
              <input
                type="datetime-local"
                value={newEntry.startAt}
                onChange={e =>
                  setNewEntry(prev => ({ ...prev, startAt: e.target.value }))
                }
                disabled={isDisabled}
                className="w-full rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
              />
            </FormField>
            <FormField label="End">
              <div className="flex gap-1">
                <input
                  type="datetime-local"
                  value={newEntry.endAt}
                  onChange={e =>
                    setNewEntry(prev => ({ ...prev, endAt: e.target.value }))
                  }
                  disabled={isDisabled}
                  className="flex-1 min-w-0 rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
                />
                <BareButton
                  type="button"
                  onClick={() =>
                    setNewEntry(prev => ({
                      ...prev,
                      endAt: nowDatetimeLocal(),
                    }))
                  }
                  disabled={isDisabled}
                  className="shrink-0 rounded-md border border-[var(--app-border)] px-1.5 py-1 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] transition-colors disabled:opacity-30"
                  title="Set to current date/time"
                >
                  Now
                </BareButton>
              </div>
            </FormField>
          </div>

          <label className="flex items-center gap-2 text-xs text-[var(--app-fg)]">
            <input
              type="checkbox"
              checked={newEntry.annualRepeat}
              onChange={e =>
                setNewEntry(prev => ({
                  ...prev,
                  annualRepeat: e.target.checked,
                }))
              }
              disabled={isDisabled}
              className="accent-[var(--app-link)]"
            />
            Repeat annually
          </label>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="accent"
              onClick={handleAdd}
              disabled={isDisabled || !newEntry.startAt || !newEntry.endAt}
              className="h-auto flex-1 px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {editingId ? "Save" : "Add"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancelForm}
              className="h-auto flex-1 px-3 py-1.5 text-xs text-[var(--app-fg)]"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {!adding && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setAdding(true)}
            disabled={isDisabled}
            className="h-auto px-3 py-1.5 text-xs text-[var(--app-fg)] hover:bg-[var(--app-hover)] disabled:opacity-50"
          >
            + Add Entry
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleAddUSHolidays}
            disabled={isDisabled}
            className="h-auto px-3 py-1.5 text-xs text-[var(--app-link)] hover:bg-[var(--app-hover)] disabled:opacity-50"
          >
            + US Holidays
          </Button>
          {exclusions.length > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (
                  window.confirm(
                    `Clear all ${exclusions.length} exclusion${exclusions.length === 1 ? "" : "s"}?`
                  )
                ) {
                  onChange([]);
                }
              }}
              disabled={isDisabled}
              className="h-auto border-red-400/30 px-3 py-1.5 text-xs text-red-400 hover:bg-red-400/10 disabled:opacity-50"
            >
              Clear All
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function formatDateRange(start: string, end: string): string {
  try {
    const s = new Date(start);
    const e = new Date(end);
    const fmt = (d: Date) =>
      d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (s.toDateString() === e.toDateString()) {
      return fmt(s);
    }
    return `${fmt(s)} - ${fmt(e)}`;
  } catch {
    return `${start} - ${end}`;
  }
}
