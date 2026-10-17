// SPDX-License-Identifier: AGPL-3.0-only
import type {
  FeedbackEmailInput,
  FeedbackSenderConfig,
  FeedbackSendResult,
} from "./feedbackSender";

/**
 * The category the relay accepts on the wire (issue #4371). The gateway's relay
 * schema (`gateway/src/lib/feedbackEmail.ts`) predates `support-escalation` and
 * rejects an unknown category with a 400, and the gateway deploys separately
 * from tenant VMs — so a support escalation travels as `other`. Its description
 * already opens with "Support escalation", so the operator still sees what it
 * is. The persisted row keeps the true category.
 */
export function relayWireCategory(
  category: FeedbackEmailInput["category"]
): "bug" | "feature" | "other" {
  return category === "support-escalation" ? "other" : category;
}

/**
 * Relay transport (Sub-Issue D, #2667, epic #2663).
 *
 * Cloud tenancy is single-user-per-VM (1 VM = 1 untrusted customer), so the
 * shared `AGENTMAIL_API_KEY` must never live on a VM. `sendViaRelay` POSTs the
 * feedback to a Matt-controlled relay that ALONE holds the AgentMail key and
 * sends the email; the caller authenticates with a per-VM `relayToken` (Bearer).
 *
 * Two deliberate invariants:
 *
 *  - **Structured payload, not rendered HTML.** We POST the structured feedback
 *    fields (category/description/metadata/…), NOT a pre-rendered email body, so
 *    the relay re-validates and rebuilds the email server-side. A compromised
 *    customer VM therefore cannot make the relay send arbitrary markup as Matt's
 *    identity — it can only submit feedback-shaped data (expert-review ruling).
 *  - **The raw AgentMail key is never referenced here.** This function reads only
 *    `relayUrl`/`relayToken` and the structured input; `config.apiKey` is never
 *    touched, so it is structurally impossible for the shared key to leak into a
 *    relay request (R4).
 *
 * Same result contract as the direct AgentMail sender (`sent | skipped | error`)
 * and — like it — NEVER throws: a missing credential returns `skipped` and any
 * network/HTTP failure returns `error`, so the caller's persist-before-send row
 * is the durable record and a relay outage degrades gracefully (R6).
 */
export async function sendViaRelay(
  config: FeedbackSenderConfig,
  input: FeedbackEmailInput
): Promise<FeedbackSendResult> {
  if (!config.relayUrl || !config.relayToken) {
    return {
      status: "skipped",
      reason:
        "relay transport selected but FEEDBACK_RELAY_URL/FEEDBACK_RELAY_TOKEN missing",
    };
  }

  try {
    const res = await fetch(config.relayUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.relayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        category: relayWireCategory(input.category),
        description: input.description,
        submitterEmail: input.submitterEmail,
        metadata: input.metadata,
        // Omit `attachments` entirely when there are none so the plain-feedback
        // request body stays minimal (parity with the AgentMail sender).
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
      }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return {
        status: "error",
        error: `Feedback relay send failed: HTTP ${res.status}${
          bodyText ? ` — ${bodyText.slice(0, 300)}` : ""
        }`,
      };
    }
    // Tolerant of the relay's success-body shape: accept either `messageId`
    // (camelCase, the natural relay response) or `message_id` (AgentMail's raw
    // field, if the relay passes it through). Absent → empty string (still sent).
    const json = (await res.json().catch(() => ({}))) as {
      messageId?: string;
      message_id?: string;
    };
    return {
      status: "sent",
      messageId: json.messageId ?? json.message_id ?? "",
    };
  } catch (err) {
    return {
      status: "error",
      error: `Feedback relay send threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
