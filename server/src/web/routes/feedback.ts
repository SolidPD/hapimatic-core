// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import {
  FeedbackRequestSchema,
  FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES,
  FEEDBACK_MAX_REQUEST_BYTES,
} from "@hapi/protocol/schemas";
import type {
  FeedbackAttachment,
  FeedbackEntryCategory,
  FeedbackMetadata,
} from "@hapi/protocol/types";
import type { Store } from "../../store";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import { operatorOnly } from "../middleware/operatorOnly";
import { cataloged } from "../../capabilities/cataloged";
import { scrubString } from "../../sentry";
import { isFileTypeAllowed } from "./upload";
import {
  buildFeedbackEmail,
  sendFeedbackEmail,
  type FeedbackEmailInput,
  type FeedbackSenderConfig,
} from "../../feedback/feedbackSender";
import {
  createSinkForwardKick,
  type FeedbackSinkConfig,
} from "../../feedback/sinkForward";
import type { ErrorLogger } from "../../logging/errorLogger";

/**
 * Deep-scrub every string leaf of the composed metadata (R4 defense-in-depth).
 * The client already composes by whitelist, but the server re-scrubs so a token
 * that somehow rode along in a metadata value is redacted before it is persisted
 * or emailed. Structure-preserving: the object shape is untouched.
 */
function scrubDeep(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubDeep(v);
    }
    return out;
  }
  return value;
}

function scrubMetadata(metadata: FeedbackMetadata): FeedbackMetadata {
  return scrubDeep(metadata) as FeedbackMetadata;
}

/**
 * The request body as UTF-8 text, or `null` once more than `maxBytes` have
 * arrived (issue #2951 L2). It pulls the body stream one chunk at a time and
 * cancels it at the cap, so the read holds at most the cap plus one chunk (the
 * final concat and decode briefly copy it); `c.req.text()` or `c.req.json()`
 * would buffer a chunked body of any size
 * before its length could be checked. Same shape as the gateway's
 * `readCappedText` (`gateway/src/lib/readCappedBody.ts`, #5744). A request with
 * no body reads as `""`.
 */
async function readCappedText(
  raw: Request,
  maxBytes: number
): Promise<string | null> {
  const stream = raw.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export interface PersistAndSendInput {
  namespace: string;
  category: FeedbackEntryCategory;
  /** Already scrubbed by the caller. */
  description: string;
  submitterEmail: string | null;
  /** Already scrubbed by the caller. */
  metadata: FeedbackMetadata;
  /** Already validated by the caller (MIME allowlist + size cap). */
  attachments: FeedbackAttachment[];
}

export interface PersistAndSendResult {
  id: string;
  delivery: "sent" | "skipped" | "error";
}

export interface PersistAndSendOptions {
  /**
   * Raises a failed send as a centralized `feedback-email` error (issue #2952):
   * an `error_logs` row, and a Sentry event where the server runs with a DSN.
   * Absent or null keeps the plain `console.error`.
   */
  errorLogger?: ErrorLogger | null;
}

/**
 * The Sentry-facing message for a failed send. It carries only the transport
 * and the HTTP status, never the row id or the transport's response text, so
 * a sustained outage groups into one Sentry issue (the server client groups
 * by message). The full error stays in the row and the `error_logs` context.
 */
export function feedbackEmailFailureMessage(
  transport: FeedbackSenderConfig["transport"],
  error: string
): string {
  const status = error.match(/HTTP (\d{3})/)?.[1];
  return status
    ? `feedback email send failed (${transport}, HTTP ${status})`
    : `feedback email send failed (${transport}, threw)`;
}

/**
 * The feedback pipeline's persist-then-send core (R7, R10), shared by
 * `POST /api/feedback` and the support escalation (`routes/support.ts`, issue
 * #4371): persist the row FIRST, then deliver best-effort through the resolved
 * transport and record the outcome. A skipped or failed send never loses the
 * persisted row.
 */
export async function persistAndSendFeedback(
  store: Store,
  senderConfig: FeedbackSenderConfig,
  input: PersistAndSendInput,
  options: PersistAndSendOptions = {}
): Promise<PersistAndSendResult> {
  const attachmentRefs = input.attachments.map(att => ({
    filename: att.filename,
    mimeType: att.mimeType,
    size: Buffer.from(att.data, "base64").length,
  }));
  const attachmentsJson =
    attachmentRefs.length > 0 ? JSON.stringify(attachmentRefs) : null;

  // R7 — persist FIRST. The row is the durable record; email is best-effort.
  const entry = store.feedback.createEntry({
    namespace: input.namespace,
    category: input.category,
    description: input.description,
    submitterEmail: input.submitterEmail,
    metadataJson: JSON.stringify(input.metadata),
    attachmentsJson,
  });

  // R10 — best-effort email. A skip/failure never loses the persisted row.
  // The SAME structured input both renders the direct-AgentMail email and is
  // the relay's request payload (#2667): the relay rebuilds the email from these
  // fields rather than trusting a caller-rendered body. Kept fork-free (R3) — the
  // route always builds `emailInput`; `sendFeedbackEmail` selects the transport.
  const emailInput: FeedbackEmailInput = {
    category: input.category,
    description: input.description,
    submitterEmail: input.submitterEmail,
    metadata: input.metadata,
    attachments: input.attachments.length > 0 ? input.attachments : undefined,
  };
  // Issue #2951 F3: everything after the persist is caught here. The row is
  // already saved, so a throw from the email build, the send, or an
  // `updateEmailStatus` write must not reach the caller: a 500 for a saved
  // submission makes the user retry and store the same feedback twice. The
  // catch never writes to the store (the store may be what failed), and the
  // row keeps `emailed = 0`. `delivery` reports the send outcome even when the
  // status write after it is what threw.
  let delivery: PersistAndSendResult["delivery"] = "error";
  try {
    const email = buildFeedbackEmail(emailInput);
    const result = await sendFeedbackEmail(senderConfig, email, emailInput);
    delivery = result.status;
    if (result.status === "sent") {
      store.feedback.updateEmailStatus(entry.id, true, null);
    } else if (result.status === "error") {
      // Issue #2952: raise the alert BEFORE the status write, so a status-write
      // fault can never skip it (the K6 contract with #2951).
      if (options.errorLogger) {
        options.errorLogger.error(
          feedbackEmailFailureMessage(senderConfig.transport, result.error),
          {
            category: "feedback-email",
            namespace: input.namespace,
            context: { feedbackId: entry.id, error: result.error },
          }
        );
      } else {
        console.error(
          `[feedback] email send failed for ${entry.id}: ${result.error}`
        );
      }
      store.feedback.updateEmailStatus(entry.id, false, result.error);
    } else {
      console.log(`[feedback] email skipped for ${entry.id}: ${result.reason}`);
    }
  } catch (e) {
    // Issue #6015 S2: the tail throw reaches Sentry through ErrorLogger, with
    // `persist: false` because `error_logs` shares the SQLite connection that
    // may have just failed (the #3631 busy_timeout class). The message carries
    // only the transport and the send outcome, so it groups in Sentry; the
    // Error's stack and the row id ride in the stack and context. Without a
    // logger, the journal line keeps the Error itself, so it keeps its stack.
    if (options.errorLogger) {
      options.errorLogger.error(
        `feedback post-persist tail failed (${senderConfig.transport}, send outcome: ${delivery})`,
        {
          category: "feedback-email",
          namespace: input.namespace,
          stack: e instanceof Error ? (e.stack ?? null) : null,
          context: {
            feedbackId: entry.id,
            delivery,
            error: e instanceof Error ? e.message : String(e),
          },
          persist: false,
        }
      );
    } else {
      console.error(
        `[feedback] post-persist tail failed for ${entry.id} (send outcome: ${delivery}):`,
        e
      );
    }
  }
  return { id: entry.id, delivery };
}

/** Options for {@link createFeedbackRoutes} (issue #2910 K2 contract). */
export interface FeedbackRoutesOptions {
  senderConfig: FeedbackSenderConfig;
  /**
   * The operator-instance capability (`resolveOperatorInstanceEnabled`,
   * `HAPI_OPERATOR_INSTANCE`). Only a literal `true` opens the read routes;
   * absent means closed.
   */
  operatorInstanceEnabled?: boolean;
  /**
   * Where to forward each new row: the gateway's central feedback sink (issue
   * #2911, `resolveFeedbackSinkConfig`). Absent or null means no forwarding. The
   * forward never delays or fails the 201; rows it cannot send stay pending for
   * the reconciler.
   */
  sinkConfig?: FeedbackSinkConfig | null;
  /**
   * Raises a failed feedback email as a centralized `feedback-email` error
   * (issue #2952). Absent or null keeps the plain `console.error`.
   */
  errorLogger?: ErrorLogger | null;
}

/**
 * `POST /api/feedback` (issue #2664, epic #2663). Zod-validated + rate-limited
 * with parity to `POST /api/error-reports` (10/60s). The invariants:
 *
 *  - R4: `scrubString` is applied to BOTH the description AND every metadata
 *    string; the payload schema is `.strict()` so un-whitelisted keys 400.
 *  - R7: the row is persisted BEFORE the email is attempted — the SQLite row is
 *    the durable record (read by the #2666 admin viewer).
 *  - R10: an unconfigured / failed email still returns 201 with the row
 *    persisted; the outcome is recorded via `updateEmailStatus`.
 *
 * Issue #2665 extends this with optional `attachments` (base64-in-payload):
 * each is re-validated server-side against the `upload.ts` MIME allowlist +
 * a 10 MB total cap and rejected 400 on violation (never trust the client);
 * valid attachment refs persist in the row's `attachments_json` and the bytes
 * are delivered as native AgentMail attachments. A failed send still 201s.
 *
 * Issue #2910 (epic #2909 Sub A): the READ routes (`GET /feedback`,
 * `GET /feedback/preflight`) are operator-only — each takes the `operatorOnly`
 * gate as a method-scoped route argument and 404s unless
 * `operatorInstanceEnabled === true`. `POST /feedback` is never gated.
 */
export function createFeedbackRoutes(
  store: Store,
  options: FeedbackRoutesOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const { senderConfig } = options;
  const kickSinkForward = createSinkForwardKick(
    store,
    options.sinkConfig ?? null
  );

  const limiter = createRateLimiter({ name: "feedback", limit: 10 });
  // Method-scoped, never `app.use("/feedback", …)`: the POST shares the path.
  const operatorGate = operatorOnly(options.operatorInstanceEnabled === true);

  app.post(
    "/feedback",
    cataloged(
      defineCapability({
        id: "harness-admin.submit-feedback",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Submit in-app user feedback (category, description, optional attachments); the entry is persisted first, then emailed best-effort.",
        whenToUse: "When the user sends product feedback from the app.",
        invocation: { kind: "rest", method: "POST", path: "/api/feedback" },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    limiter,
    async c => {
      const namespace = c.get("namespace");

      // Issue #2951 L2: refuse an over-cap body before it is buffered or parsed.
      // The Content-Length check turns away an honest oversize upload at once;
      // the capped read covers a chunked body or a lying header by counting the
      // bytes as they arrive and cancelling the stream past the cap.
      const declaredLength = Number(c.req.header("content-length") ?? "0");
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > FEEDBACK_MAX_REQUEST_BYTES
      ) {
        return c.json({ error: "Payload too large" }, 413);
      }
      let raw: string | null;
      try {
        raw = await readCappedText(c.req.raw, FEEDBACK_MAX_REQUEST_BYTES);
      } catch (e) {
        // A body stream that errors (the client dropped mid-upload) is
        // malformed, as it was under `c.req.json().catch(() => null)`: a 400.
        // Logged, so a server-side read fault is not mistaken for bad input.
        console.warn("[feedback] request body read failed:", e);
        raw = "";
      }
      if (raw === null) {
        return c.json({ error: "Payload too large" }, 413);
      }
      let json: unknown = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      const parsed = FeedbackRequestSchema.safeParse(json);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );
      }

      const data = parsed.data;
      const description = scrubString(data.description);
      const metadata = scrubMetadata(data.metadata);

      // Issue #2665 — validate + associate attachments (Path A: base64-in-payload).
      // MIME allowlist + byte size are RE-VALIDATED server-side (never trust the
      // client): a disallowed / empty / oversize attachment is rejected 400, at
      // parity with POST /sessions/:id/upload (V1). This is distinct from the R4
      // graceful-degradation path below — a failed EMAIL send still 201s with the
      // row (and its attachment refs) persisted. The bytes ride the email; the row
      // persists only the refs (filename/mimeType/size), not the file bytes.
      const emailAttachments: FeedbackAttachment[] = [];
      let attachmentBytes = 0;
      for (const att of data.attachments ?? []) {
        const bytes = Buffer.from(att.data, "base64").length;
        if (bytes === 0) {
          return c.json({ error: "Attachment is empty or malformed" }, 400);
        }
        if (!isFileTypeAllowed(att.mimeType, att.filename)) {
          return c.json(
            { error: `Attachment type not allowed: ${att.mimeType}` },
            400
          );
        }
        attachmentBytes += bytes;
        if (attachmentBytes > FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES) {
          return c.json(
            {
              error: `Attachments too large. Maximum total size is ${
                FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024
              }MB`,
            },
            400
          );
        }
        // Scrub the free-text filename (defense-in-depth, same discipline as the
        // description/metadata); the file bytes are consented content — never scrubbed.
        const filename = scrubString(att.filename);
        emailAttachments.push({
          filename,
          mimeType: att.mimeType,
          data: att.data,
        });
      }

      const { id } = await persistAndSendFeedback(
        store,
        senderConfig,
        {
          namespace,
          category: data.category,
          description,
          submitterEmail: data.submitterEmail ?? null,
          metadata,
          attachments: emailAttachments,
        },
        { errorLogger: options.errorLogger }
      );
      void kickSinkForward(id);

      return c.json({ id }, 201);
    }
  );

  // ── Admin viewer list endpoint (issue #2666, epic #2663 Sub C) ─────────────
  // Kept in a DISTINCT region from the POST above so the parallel #2665
  // (attachments) edits to this file rebase cleanly. `GET /api/feedback` is a
  // read-only admin surface: it inherits its auth from mount position — the
  // factory mounts at `/api` AFTER the global JWT middleware
  // (`app.use("/api/*", createAuthMiddleware(...))`, buildWebApp.ts), exactly
  // like `sessionMetadata` / `errorLogs`, so an unauthenticated request is
  // rejected (401) before it reaches this handler, on open and closed instances
  // alike. Issue #2910: it is also OPERATOR-ONLY — `operatorGate` 404s it unless
  // `HAPI_OPERATOR_INSTANCE` is truthy (`1`/`true`/`yes`), so a customer instance never
  // advertises the route — and, since #5571, a closed gate also drops the entry
  // from the capability catalog (`operatorOnly` marks it). The gate is a
  // visibility gate, not an authorization boundary (an instance owner can read
  // the SQLite directly); the central
  // inbox's boundary is #2912's gateway operator credential. On an operator
  // instance the list is node-global (no namespace filter). Rows carry
  // `emailed`/`email_error`, so a persist-only (`emailed=0`) row is visibly the
  // durable safety net (R3).
  app.get(
    "/feedback",
    cataloged(
      defineCapability({
        id: "harness-admin.list-feedback",
        domain: "harness-admin",
        surface: "rest",
        description:
          "List submitted user-feedback entries (node-global) with their email-delivery status, for the admin feedback viewer.",
        whenToUse: "When reviewing submitted feedback in the admin viewer.",
        invocation: { kind: "rest", method: "GET", path: "/api/feedback" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    operatorGate,
    c => {
      const url = new URL(c.req.url);

      // Clamp `limit` per the real precedent (errorLogs.ts): default 100, max 500.
      let limit = 100;
      const rawLimit = url.searchParams.get("limit");
      if (rawLimit) {
        const parsed = Number(rawLimit);
        if (!Number.isNaN(parsed) && parsed > 0) {
          limit = Math.min(parsed, 500);
        }
      }

      let offset = 0;
      const rawOffset = url.searchParams.get("offset");
      if (rawOffset) {
        const parsed = Number(rawOffset);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          offset = parsed;
        }
      }

      const items = store.feedback.getEntries({ limit, offset });
      const total = store.feedback.countEntries();
      return c.json({ items, total });
    }
  );

  // ── Operator-instance preflight (issue #2910) ─────────────────────────────
  // Mirrors `/admin-vms/preflight`: a closed instance answers 404 (the gate),
  // which the web treats as "closed" — only `{ enabled: true }` opens the
  // settings Feedback row and page. A distinct exact path from `/feedback`, so
  // it never collides with the POST/GET routes. Scope `user` (#5571): the gate is
  // per instance, so on an operator instance any authenticated caller is served;
  // `scope: "operator"` would mean the provisioner-host proof plus a matching
  // operator binding (`deriveScope`) instead.
  app.get(
    "/feedback/preflight",
    cataloged(
      defineCapability({
        id: "harness-admin.feedback-preflight",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Report whether this instance is an operator instance that shows the feedback inbox; a non-operator instance answers 404.",
        whenToUse:
          "When deciding whether to show the feedback viewer on this instance.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/feedback/preflight",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    operatorGate,
    c => c.json({ enabled: true })
  );

  return app;
}
