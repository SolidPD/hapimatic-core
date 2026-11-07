// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ONE summary toast for the bulk session actions (#3815, epic #4406 K1):
 * Connect, Disconnect, Stop turn, and #3818's Send. It reads the shared
 * per-session `BulkSessionResult` and counts four buckets — it never reports
 * an aggregate success while any session failed. Delete ends with its own
 * toast since #6210 (`summarizeBulkDelete`, below).
 *
 *   done    = ok && code !== "queued"
 *   queued  = ok && code === "queued"
 *   skipped = skipped === true
 *   failed  = !ok && !skipped
 *
 * e.g. "Stopped 3 · skipped 1 (inactive)", "Sent 2 · queued 1 · skipped 2 (idle)",
 * "Stopped 12 · 3 have queued prompts that will run next".
 */
import type {
  BulkSessionResult,
  BulkSessionResultCode,
  BulkSessionResultItem,
} from "@hapi/protocol/bulkSessionResult";

/** `"send"` is #3818's send-to-selected. */
export type BulkToastAction =
  | "connect"
  | "archive"
  | "abort"
  | "delete"
  | "send";

export type BulkToastType = "success" | "error" | "warning";

const DONE_VERB: Record<BulkToastAction, string> = {
  connect: "Reconnected",
  archive: "Disconnected",
  abort: "Stopped",
  delete: "Deleted",
  send: "Sent",
};

const REASON_LABEL: Record<BulkSessionResultCode, string> = {
  session_inactive: "inactive",
  session_idle: "idle",
  session_active: "still connected",
  session_spawning: "spawning",
  node_offline: "node offline",
  not_found: "not found",
  forbidden: "access denied",
  queued: "queued",
  denied: "refused by a hook",
};

/** "(inactive)" for one reason; "(2 idle, 1 inactive)" for several. */
function reasons(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  if (counts.size === 1) return `(${labels[0]})`;
  const parts = Array.from(counts, ([label, n]) => `${n} ${label}`);
  return `(${parts.join(", ")})`;
}

export function summarizeBulkSessionResult(
  action: BulkToastAction,
  results: BulkSessionResult
): { message: string; type: BulkToastType } {
  let done = 0;
  let queued = 0;
  const skipped: string[] = [];
  const failed: string[] = [];
  let withQueuedPrompts = 0;

  for (const r of results) {
    if (r.ok) {
      if (r.code === "queued") queued += 1;
      else done += 1;
      if ((r.queued ?? 0) > 0) withQueuedPrompts += 1;
    } else if (r.skipped) {
      skipped.push(r.code ? REASON_LABEL[r.code] : "skipped");
    } else {
      failed.push(r.code ? REASON_LABEL[r.code] : "error");
    }
  }

  const parts = [`${DONE_VERB[action]} ${done}`];
  if (queued > 0) parts.push(`queued ${queued}`);
  if (skipped.length > 0) {
    parts.push(`skipped ${skipped.length} ${reasons(skipped)}`);
  }
  if (failed.length > 0) {
    parts.push(`failed ${failed.length} ${reasons(failed)}`);
  }
  // Ruling D2: Stop turn keeps stop-button parity — a stopped session's queue
  // drains as soon as its turn ends, so say so instead of implying it is idle.
  if (action === "abort" && withQueuedPrompts > 0) {
    parts.push(
      `${withQueuedPrompts} ${withQueuedPrompts === 1 ? "has" : "have"} queued prompts that will run next`
    );
  }

  const type: BulkToastType =
    failed.length > 0 ? "error" : skipped.length > 0 ? "warning" : "success";
  return { message: parts.join(" · "), type };
}

/** A code-less failure whose text says the outcome is unknown (a timeout). */
const TIMEOUT_TEXT = /timed out|timeout|no answer within/i;
const ERROR_LABEL_MAX = 60;

/**
 * #6210: the reason one session was not deleted, for the bulk-delete toast.
 * A result `code` uses the shared label ("node offline", "still connected"…);
 * an error text is shortened to "timed out" for a timeout, else kept (≤ 60
 * characters). A code-less failure in the disconnect step is named as one
 * ("disconnect timed out" / "disconnect failed: …"), because that session was
 * never sent to delete; a coded one uses its shared label in either step.
 */
export function bulkFailureLabel(
  item: BulkSessionResultItem,
  phase: "disconnect" | "delete"
): string {
  if (item.code) return REASON_LABEL[item.code];
  const text = (item.error ?? "").trim();
  if (TIMEOUT_TEXT.test(text)) {
    return phase === "disconnect" ? "disconnect timed out" : "timed out";
  }
  const short =
    text.length === 0
      ? "error"
      : text.length > ERROR_LABEL_MAX
        ? `${text.slice(0, ERROR_LABEL_MAX - 1)}…`
        : text;
  return phase === "disconnect" ? `disconnect failed: ${short}` : short;
}

/**
 * #6210: the ONE toast a background bulk delete ends with. All deleted →
 * "Deleted 50 sessions". Any failure → "2 sessions could not be deleted: node
 * offline", with counted labels when the reasons differ ("3 sessions could not
 * be deleted: 2 node offline, 1 timed out"), most frequent first.
 */
export function summarizeBulkDelete(
  deletedCount: number,
  failures: ReadonlyArray<{ id: string; label: string }>
): { message: string; type: BulkToastType } {
  const noun = (n: number) => (n === 1 ? "session" : "sessions");
  if (failures.length === 0) {
    return {
      message: `Deleted ${deletedCount} ${noun(deletedCount)}`,
      type: "success",
    };
  }
  const counts = new Map<string, number>();
  for (const f of failures) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
  const reasonText =
    counts.size === 1
      ? (failures[0]?.label ?? "error")
      : Array.from(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([label, n]) => `${n} ${label}`)
          .join(", ");
  const n = failures.length;
  return {
    message: `${n} ${noun(n)} could not be deleted: ${reasonText}`,
    type: "error",
  };
}
