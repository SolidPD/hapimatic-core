// SPDX-License-Identifier: AGPL-3.0-only
import { type JobRegistry, SupervisedLoop } from "@hapi/protocol";
import {
  FEEDBACK_SINK_DESCRIPTION_MAX,
  FEEDBACK_SINK_FILENAME_MAX,
  FEEDBACK_SINK_MIME_TYPE_MAX,
  FeedbackSinkPayloadSchema,
  FeedbackSinkResponseSchema,
  truncateSinkMetadata,
  type FeedbackSinkAttachmentRef,
  type FeedbackSinkPayload,
} from "@hapi/protocol/feedbackSink";

import { isEnvFlagTruthy } from "../provisioner/capability";
import { clampText } from "./clampText";
import type { Store } from "../store";
import type {
  FeedbackForwardOutcome,
  StoredFeedback,
} from "../store/feedbackStore";

/**
 * Forward locally persisted feedback to the gateway's central sink (issue #2911,
 * epic #2909 Sub B).
 *
 * The local `feedback` row is written first and stays the durable buffer; this
 * module copies it to `POST /api/feedback-sink`, the fleet's store of record.
 * Two senders share {@link forwardRow}: a fire-and-forget kick right after
 * `POST /api/feedback` persists, and a reconciler loop that retries every row
 * still pending (and delivers the support-escalation rows, which get no kick).
 * The gateway insert is idempotent, so a kick and the reconciler racing on one
 * row is harmless.
 *
 * Sink config is its own seam, never a field of the email sender's config (the
 * #2667 rule). Nothing here throws, and no error string ever carries the token.
 */

/** Where and as whom this instance forwards (resolved by `resolveFeedbackSinkConfig`). */
export interface FeedbackSinkConfig {
  /** The full sink endpoint, e.g. `https://hapimatic.com/api/feedback-sink`. */
  url: string;
  /** Operator nodes: the shared operator bearer. Customer VMs: the relay token. */
  token: string;
  originKind: "operator" | "customer";
  /** The node's own id (operator nodes); null on a customer VM (the gateway derives it). */
  originInstanceId: string | null;
  originLabel: string | null;
  appVersion: string;
}

/** Federation identity used to name an operator node's origin. */
export interface FeedbackSinkOrigin {
  nodeId?: string | null;
  nodeLabel?: string | null;
}

/** The classified result of one POST to the sink. */
export type SinkForwardResult =
  | { kind: "forwarded"; centralId: string; duplicate: boolean }
  | { kind: "retryable"; error: string; retryAfterMs?: number }
  | { kind: "rejected"; error: string }
  | { kind: "config-error"; error: string };

/** How long one POST to the sink may take. */
export const SINK_FORWARD_TIMEOUT_MS = 5000;
/** Rows the reconciler sends per pass. */
export const SINK_RECONCILE_BATCH = 10;
/** The reconciler's cadence while the sink is healthy. */
export const SINK_RECONCILE_INTERVAL_MS = 60_000;
/** The longest the reconciler backs off after failing passes. */
export const SINK_RECONCILE_MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Build the sink payload from the PERSISTED (already scrubbed) row — never from
 * request data — and validate it with the canonical schema. A row that fails
 * validation is reported, never sent.
 *
 * The route scrubs secrets AFTER the request's 5000-character cap, and the
 * redaction marker can lengthen the text ("Bearer abc" becomes
 * "Bearer [REDACTED]"), so the text fields are clamped to the sink's caps here
 * rather than letting the row be rejected for good. Clamping only removes
 * characters from already-scrubbed text, so it never re-exposes a secret.
 */
export function buildSinkPayload(
  row: StoredFeedback,
  config: FeedbackSinkConfig
): { ok: true; payload: FeedbackSinkPayload } | { ok: false; error: string } {
  let metadata: unknown;
  let attachments: unknown;
  try {
    metadata = JSON.parse(row.metadataJson);
    attachments =
      row.attachmentsJson === null
        ? undefined
        : JSON.parse(row.attachmentsJson);
  } catch {
    return { ok: false, error: "stored row holds invalid JSON" };
  }
  const refs = Array.isArray(attachments)
    ? attachments.map((ref: Partial<FeedbackSinkAttachmentRef>): unknown => ({
        filename: clampText(ref?.filename, FEEDBACK_SINK_FILENAME_MAX),
        mimeType: clampText(ref?.mimeType, FEEDBACK_SINK_MIME_TYPE_MAX),
        size: ref?.size,
      }))
    : attachments;
  const candidate = {
    localRowId: row.id,
    createdAt: row.createdAt,
    originInstanceId: config.originInstanceId,
    originLabel: config.originLabel,
    appVersion: config.appVersion,
    category: row.category,
    description: clampText(row.description, FEEDBACK_SINK_DESCRIPTION_MAX),
    submitterEmail: row.submitterEmail,
    metadata:
      metadata !== null &&
      typeof metadata === "object" &&
      !Array.isArray(metadata)
        ? truncateSinkMetadata(metadata as Record<string, unknown>)
        : metadata,
    ...(refs === undefined ? {} : { attachments: refs }),
  };
  const parsed = FeedbackSinkPayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map(issue => issue.path.join(".") || "(root)")
      ),
    ];
    return { ok: false, error: `invalid sink payload: ${fields.join(", ")}` };
  }
  return { ok: true, payload: parsed.data };
}

/** An error's class name for a log line; never its message, which may echo a URL or header. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "error";
}

/** Parse a `Retry-After` header given in seconds. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * POST one payload to the sink and classify the answer. Never throws; the error
 * strings name a status or an error class, never a header or the token.
 */
export async function forwardToSink(
  payload: FeedbackSinkPayload,
  config: FeedbackSinkConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = SINK_FORWARD_TIMEOUT_MS
): Promise<SinkForwardResult> {
  let res: Response;
  try {
    res = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = errorName(err);
    return {
      kind: "retryable",
      error:
        name === "TimeoutError" || name === "AbortError"
          ? "sink request timed out"
          : `sink unreachable (${name})`,
    };
  }
  const status = res.status;
  if (status === 200) {
    const body = await res.json().catch(() => null);
    const parsed = FeedbackSinkResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { kind: "retryable", error: "sink answered 200 without an id" };
    }
    return {
      kind: "forwarded",
      centralId: parsed.data.id,
      duplicate: parsed.data.duplicate,
    };
  }
  if (status === 400 || status === 413) {
    return {
      kind: "rejected",
      error: `sink rejected the row (HTTP ${status})`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "config-error",
      error: `sink refused the credential (HTTP ${status})`,
    };
  }
  if (status === 404) {
    // An older gateway without the route: keep the rows pending until it ships.
    return { kind: "config-error", error: "sink route not found (HTTP 404)" };
  }
  return {
    kind: "retryable",
    error: `sink answered HTTP ${status}`,
    retryAfterMs: retryAfterMs(res),
  };
}

function toOutcome(result: SinkForwardResult): FeedbackForwardOutcome {
  return result.kind === "forwarded"
    ? { kind: "forwarded" }
    : { kind: result.kind, error: result.error };
}

/** Forward one stored row and record the outcome on it. Never throws. */
export async function forwardRow(
  store: Store,
  config: FeedbackSinkConfig,
  row: StoredFeedback,
  fetchImpl: typeof fetch = fetch
): Promise<SinkForwardResult> {
  let result: SinkForwardResult;
  const built = buildSinkPayload(row, config);
  if (!built.ok) {
    result = { kind: "rejected", error: built.error };
  } else {
    result = await forwardToSink(built.payload, config, fetchImpl);
  }
  try {
    store.feedback.markForwarded(row.id, toOutcome(result));
  } catch (err) {
    console.error(
      `[feedback-sink] could not record the forward outcome for ${row.id}: ${errorName(err)}`
    );
  }
  return result;
}

/**
 * The POST kick: forward one freshly persisted row once. A no-op without sink
 * config; its promise never rejects, so the caller can `void` it.
 */
export function createSinkForwardKick(
  store: Store,
  config: FeedbackSinkConfig | null,
  fetchImpl?: typeof fetch
): (localRowId: string) => Promise<void> {
  return async localRowId => {
    if (config === null) return;
    try {
      const row = store.feedback.getEntry(localRowId);
      if (row === null || row.forwardState !== "pending") return;
      // The global fetch is read per kick, not when the route is built.
      await forwardRow(store, config, row, fetchImpl ?? fetch);
    } catch (err) {
      console.error(
        `[feedback-sink] forward kick failed for ${localRowId}: ${errorName(err)}`
      );
    }
  };
}

/** Next reconcile delay after a pass: 60 s × 2^failures, capped, honouring Retry-After. */
export function nextReconcileDelayMs(
  consecutiveFailures: number,
  retryAfter?: number
): number {
  const backoff =
    consecutiveFailures === 0
      ? SINK_RECONCILE_INTERVAL_MS
      : Math.min(
          SINK_RECONCILE_INTERVAL_MS * 2 ** consecutiveFailures,
          SINK_RECONCILE_MAX_BACKOFF_MS
        );
  return Math.min(
    Math.max(backoff, retryAfter ?? 0),
    SINK_RECONCILE_MAX_BACKOFF_MS
  );
}

/**
 * One reconcile pass: send up to {@link SINK_RECONCILE_BATCH} pending rows in
 * order, stopping at the first retryable or credential failure (the rest wait for
 * the next pass). A rejected row is recorded and does not block the next one.
 * Never throws — a gateway outage is data, not a loop fault.
 */
export async function reconcileSinkOnce(
  store: Store,
  config: FeedbackSinkConfig,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; sent: number; retryAfterMs?: number }> {
  let sent = 0;
  try {
    for (const row of store.feedback.getUnforwarded(SINK_RECONCILE_BATCH)) {
      const result = await forwardRow(store, config, row, fetchImpl);
      if (result.kind === "forwarded") sent += 1;
      if (result.kind === "retryable" || result.kind === "config-error") {
        console.warn(`[feedback-sink] reconcile paused: ${result.error}`);
        return {
          ok: false,
          sent,
          retryAfterMs:
            result.kind === "retryable" ? result.retryAfterMs : undefined,
        };
      }
    }
    return { ok: true, sent };
  } catch (err) {
    console.error(`[feedback-sink] reconcile pass failed: ${errorName(err)}`);
    return { ok: false, sent };
  }
}

/**
 * Start-of-life wiring for the reconciler: `null` (no loop, no query) without
 * sink config. With `HAPI_FEEDBACK_SINK_BACKFILL` truthy it first requeues the
 * legacy rows (the operator's one-shot backfill of history).
 */
export function startSinkReconciler(opts: {
  store: Store;
  sinkConfig: FeedbackSinkConfig | null;
  node: string;
  registry: JobRegistry;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): SupervisedLoop | null {
  const config = opts.sinkConfig;
  if (config === null) return null;
  const env = opts.env ?? process.env;
  if (isEnvFlagTruthy(env.HAPI_FEEDBACK_SINK_BACKFILL)) {
    try {
      const requeued = opts.store.feedback.requeueLegacyRows();
      console.log(
        `[feedback-sink] HAPI_FEEDBACK_SINK_BACKFILL: requeued ${requeued} legacy row(s)`
      );
    } catch (err) {
      console.error(
        `[feedback-sink] backfill requeue failed: ${errorName(err)}`
      );
    }
  }
  let failures = 0;
  let delay = SINK_RECONCILE_INTERVAL_MS;
  return new SupervisedLoop({
    name: "feedback-sink-reconcile",
    node: opts.node,
    intervalMs: SINK_RECONCILE_INTERVAL_MS,
    getIntervalMs: () => delay,
    registry: opts.registry,
    tick: async () => {
      const pass = await reconcileSinkOnce(opts.store, config, opts.fetchImpl);
      failures = pass.ok ? 0 : failures + 1;
      delay = nextReconcileDelayMs(failures, pass.retryAfterMs);
    },
  });
}
