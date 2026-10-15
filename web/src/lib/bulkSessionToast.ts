// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ONE summary toast for every bulk session action (#3815, epic #4406 K1):
 * Connect, Disconnect, Delete, Stop turn, and #3818's Send. It reads the
 * shared per-session `BulkSessionResult` and counts four buckets — it never
 * reports an aggregate success while any session failed.
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
