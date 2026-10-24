// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import {
  FeedbackRequestSchema,
  FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES,
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
  input: PersistAndSendInput
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
  const email = buildFeedbackEmail(emailInput);
  const result = await sendFeedbackEmail(senderConfig, email, emailInput);
  if (result.status === "sent") {
    store.feedback.updateEmailStatus(entry.id, true, null);
  } else if (result.status === "error") {
    console.error(
      `[feedback] email send failed for ${entry.id}: ${result.error}`
    );
    store.feedback.updateEmailStatus(entry.id, false, result.error);
  } else {
    console.log(`[feedback] email skipped for ${entry.id}: ${result.reason}`);
  }
  return { id: entry.id, delivery: result.status };
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

      const json = await c.req.json().catch(() => null);
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

      const { id } = await persistAndSendFeedback(store, senderConfig, {
        namespace,
        category: data.category,
        description,
        submitterEmail: data.submitterEmail ?? null,
        metadata,
        attachments: emailAttachments,
      });

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
  // advertises the route. That gate is a visibility gate, not an authorization
  // boundary (an instance owner can read the SQLite directly); the central
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
  // it never collides with the POST/GET routes.
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
        availability: { scope: "operator" },
      })
    ),
    operatorGate,
    c => c.json({ enabled: true })
  );

  return app;
}
