// SPDX-License-Identifier: AGPL-3.0-only
import { getStorageKey } from "./storage-keys";
import { safeSetItem } from "./localStorageCleanup";

// Cap how many failed reports we hold on disk. 50 events × ~4KB each = ~200KB
// worst case, well under the 5MB per-origin localStorage quota even when other
// Hapimatic features (branch cache, prompt drafts, expand state) are competing.
export const MAX_OUTBOX_ENTRIES = 50;

// Per-event truncation at persist time bounds storage footprint AND limits the
// PII residency window. The full payload still goes to the server on the first
// (failed) attempt — only the durable copy is trimmed.
export const MAX_STACK_LENGTH = 2048;
export const MAX_CONTEXT_LENGTH = 1024;

const STORAGE_KEY_BASE = "hapi:errorOutbox";

export type PersistableReport = {
  id: string;
  enqueuedAt: number;
  message: string;
  stack: string | null;
  category: string;
  source: "client";
  severity: "debug" | "info" | "warn" | "error" | "fatal";
  sessionId: string | null;
  context: string | null;
  // userAgent intentionally omitted — re-derived from navigator.userAgent at replay.
  requestPath: string | null;
  requestMethod: string | null;
  statusCode: number | null;
};

export type EnqueueResult = {
  dropped: boolean;
  reason?: "evicted" | "quota";
};

function truncate(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  return s.length <= max ? s : s.slice(0, max);
}

function generateId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class ErrorOutbox {
  private dropCount = 0;

  private get storageKey(): string {
    return getStorageKey(STORAGE_KEY_BASE);
  }

  private read(): PersistableReport[] {
    const raw = localStorage.getItem(this.storageKey);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        console.warn("[ErrorOutbox] Corrupted outbox (not an array), clearing");
        localStorage.removeItem(this.storageKey);
        return [];
      }
      return parsed as PersistableReport[];
    } catch (err) {
      console.warn("[ErrorOutbox] Corrupted outbox JSON, clearing", err);
      localStorage.removeItem(this.storageKey);
      return [];
    }
  }

  private write(entries: PersistableReport[]): boolean {
    return safeSetItem(this.storageKey, JSON.stringify(entries));
  }

  enqueue(report: Omit<PersistableReport, "id" | "enqueuedAt">): EnqueueResult {
    // Explicit field-by-field assignment — never spread `report` directly.
    // If a caller passes an object with extra fields (e.g. userAgent) via type
    // assertion, the spread would leak those into the persisted form. The
    // explicit form ensures only the documented persistable fields land on disk.
    const persisted: PersistableReport = {
      id: generateId(),
      enqueuedAt: Date.now(),
      message: report.message,
      stack: truncate(report.stack, MAX_STACK_LENGTH),
      category: report.category,
      source: report.source,
      severity: report.severity,
      sessionId: report.sessionId,
      context: truncate(report.context, MAX_CONTEXT_LENGTH),
      requestPath: report.requestPath,
      requestMethod: report.requestMethod,
      statusCode: report.statusCode,
    };

    const entries = this.read();
    let evicted = false;

    // FIFO eviction. Loop guards against length-cap reductions between writes.
    while (entries.length >= MAX_OUTBOX_ENTRIES) {
      entries.shift();
      evicted = true;
    }

    entries.push(persisted);

    const ok = this.write(entries);
    if (!ok) {
      this.dropCount++;
      return { dropped: true, reason: "quota" };
    }

    if (evicted) {
      this.dropCount++;
      return { dropped: true, reason: "evicted" };
    }

    return { dropped: false };
  }

  peekAll(): PersistableReport[] {
    return this.read();
  }

  removeById(id: string): void {
    const entries = this.read();
    const filtered = entries.filter(e => e.id !== id);
    if (filtered.length === entries.length) return;
    this.write(filtered);
  }

  size(): number {
    return this.read().length;
  }

  getDropCount(): number {
    return this.dropCount;
  }

  resetDropCount(): void {
    this.dropCount = 0;
  }
}
