// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from "node:crypto";

import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import {
  GitHubWebhookEventSchema,
  type PmQueueEventKind,
} from "@hapi/protocol";

import type { GitHubWebhookConfig } from "../../config/githubWebhookConfig";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { Store } from "../../store";
import type { ScorecardStore } from "../../store/scorecardStore";
import { constantTimeEquals } from "../../utils/crypto";
import { createRateLimiter } from "../middleware/rateLimit";
import { logAndJson } from "./routeErrorHelper";

/**
 * Skill-revamp 3.2 (#2157, epic rp1-home#1319) — the PUBLIC GitHub webhook
 * receiver. Verifies the `X-Hub-Signature-256` HMAC and appends one event to the
 * matching initiative's #2156 event log, with no poll (R1). This is the only new
 * PUBLIC code in the issue, and the only endpoint mounted OUTSIDE the JWT gate —
 * GitHub delivers from the public internet and cannot present a JWT, so the route
 * is a plain `Hono` (like `createTelemetryIngestRoute`) and authenticates by HMAC
 * ALONE. Its compensating controls are load-bearing, not optional:
 *   - DEFAULT-DISABLED flag → `404` when off (the endpoint does not exist)
 *   - refuse to enable without a secret (see `githubWebhookConfig.ts`)
 *   - constant-time HMAC compare over the RAW body (`constantTimeEquals`)
 *   - narrow zod parse (`GitHubWebhookEventSchema`) — model only what we consume
 *   - unknown repo → `202 ignored` (never an error, never a synthesized initiative)
 *   - NO `gh`/subprocess call in the handler (no SSRF / command surface)
 *   - ~1MB pre-verification body cap (`413`) + the house rate limiter
 *
 * The exactly-once key is `X-GitHub-Delivery` (stable across GitHub redeliveries);
 * the dedup INSERT + `appendEvent` + `webhook_health` stamp are ONE transaction
 * (`InitiativeStore.recordWebhookEvent`, R3/R6 atomicity).
 */

/** ~1MB pre-verification cap on an unauthenticated public body → `413`. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * The GitHub `X-Hub-Signature-256` value for a raw body:
 * `sha256=<hex HMAC-SHA256 of the raw UTF-8 body>`. Exported so the test can pin
 * it against GitHub's published vector (secret `It's a Secret to Everybody`,
 * body `Hello, World!` → `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`).
 */
export function computeGitHubSignature(
  secret: string,
  rawBody: string
): string {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  );
}

type ParsedWebhook = ReturnType<typeof GitHubWebhookEventSchema.parse>;

/**
 * Map `x-github-event` + the payload → a queue event kind + the issue/PR number
 * used to resolve the target initiative. Returns `null` for anything not in the
 * #2157 taxonomy (a `ping`, a PR closed-without-merge, a `label`-definition event,
 * etc.) — the caller answers `202 ignored`.
 *
 * Issue-LABEL changes arrive as the `issues` event (actions `labeled`/`unlabeled`),
 * NOT the `label` event (which is label-definition CRUD and is not subscribed).
 */
function mapWebhook(
  event: string,
  payload: ParsedWebhook
): { kind: PmQueueEventKind; issueNumber: number } | null {
  if (event === "issues" && payload.issue) {
    switch (payload.action) {
      case "labeled":
        return {
          kind: "github_issue_labeled",
          issueNumber: payload.issue.number,
        };
      case "unlabeled":
        return {
          kind: "github_issue_unlabeled",
          issueNumber: payload.issue.number,
        };
      case "closed":
        return {
          kind: "github_issue_closed",
          issueNumber: payload.issue.number,
        };
      default:
        return null;
    }
  }
  if (event === "pull_request" && payload.pull_request) {
    if (payload.action === "opened") {
      return {
        kind: "github_pr_opened",
        issueNumber: payload.pull_request.number,
      };
    }
    if (payload.action === "closed" && payload.pull_request.merged === true) {
      return {
        kind: "github_pr_merged",
        issueNumber: payload.pull_request.number,
      };
    }
    return null; // reopened / synchronize / closed-without-merge — not in-scope
  }
  return null;
}

/**
 * The checkpoint-label prefix a gate revert re-adds/removes (issue #3128 KD3).
 * The server-side workflow gate reverts an illegal transition by mutating a
 * `✅ checkpoint:` label as the gate bot — that label event IS the attributable
 * instruction-following failure the scorecard scores.
 */
const CHECKPOINT_LABEL_PREFIX = "✅ checkpoint:";

/**
 * Record a `gate_violation` scorecard event iff a webhook is a gate-bot
 * checkpoint-label event (issue #3128 KD3). Detection rule (pinned to the
 * webhook's REAL taxonomy — ruling 1B-21vi): an `issues.labeled`/`unlabeled`
 * event whose `sender.login` is the gate bot AND whose `label.name` starts with
 * `✅ checkpoint:`. A GitHub label webhook carries NO #3130 provenance, so the
 * violation is recorded `unattributed` (harness/model/skill null — OR4) with the
 * repo/issue/label stashed for future retro-attribution. NEVER throws — the
 * caller wraps it so a scorecard fault cannot affect the webhook 200/202
 * (fire-and-forget, OR2).
 */
function recordGateViolationIfApplicable(
  scorecardStore: ScorecardStore,
  event: string,
  payload: ParsedWebhook,
  gateBotLogin: string
): void {
  if (event !== "issues") return;
  if (payload.action !== "labeled" && payload.action !== "unlabeled") return;
  const sender = payload.sender?.login;
  if (!sender || sender !== gateBotLogin) return;
  const label = payload.label?.name;
  if (!label || !label.startsWith(CHECKPOINT_LABEL_PREFIX)) return;

  scorecardStore.recordEvent({
    skill: null,
    harness: "unattributed",
    model: null,
    kind: "gate_violation",
    provenance: {
      repo: payload.repository?.full_name ?? null,
      issueNumber: payload.issue?.number ?? null,
      label,
      action: payload.action,
      sender,
    },
  });
}

export function createGitHubWebhookRoutes(
  getStore: () => Store | null,
  config: GitHubWebhookConfig,
  options?: {
    errorLogger?: ErrorLogger | null;
    /** Issue #3128: the scorecard store gate violations are recorded into. */
    getScorecardStore?: () => ScorecardStore | null;
    /**
     * Issue #3128 (KD3): the gate-bot sender login. Default `github-actions[bot]`
     * (the standard Actions actor); override via `HAPI_SCORECARD_GATE_BOT_LOGIN`
     * when the workflow gate reverts under a PAT-authenticated actor.
     */
    scorecardGateBotLogin?: string;
  }
): Hono {
  const app = new Hono();
  const errorLogger = options?.errorLogger ?? null;
  const getScorecardStore = options?.getScorecardStore ?? null;
  const gateBotLogin =
    options?.scorecardGateBotLogin ||
    process.env.HAPI_SCORECARD_GATE_BOT_LOGIN ||
    "github-actions[bot]";
  // Global bucket (public endpoint has no namespace) — DoS defense on the only
  // public-internet route. `createRateLimiter` defaults its key to
  // `c.get("namespace")`, absent here, so it falls back to "anonymous" for all
  // callers; a constant keyFn makes that explicit.
  const limiter = createRateLimiter({
    name: "github-webhook",
    keyFn: () => "github-webhook",
  });

  // POST /github/webhook — HMAC-verified GitHub delivery ingest (pre-JWT).
  app.post(
    "/github/webhook",
    limiter,
    cataloged(
      defineCapability({
        id: "harness-admin.github-webhook",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Receive a GitHub webhook delivery, authenticated by HMAC signature; a no-op 404 when the feature flag is off.",
        whenToUse: "When GitHub delivers an issue/PR event to this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/github/webhook",
        },
        auth: "hmac",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      // 1. Feature off ⇒ the endpoint does not exist (R7).
      if (!config.enabled) {
        return c.json({ error: "Not found" }, 404);
      }

      try {
        // 8a. Pre-verification body-size cap — reject an oversized unauthenticated
        // body via Content-Length BEFORE buffering it.
        const contentLength = Number.parseInt(
          c.req.header("content-length") ?? "",
          10
        );
        if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
          return c.json({ error: "Payload too large" }, 413);
        }

        // 2. 🔴 Read the RAW body FIRST. NEVER json()-then-stringify — re-
        // serialization changes bytes and the HMAC will not match.
        const raw = await c.req.text();
        if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
          return c.json({ error: "Payload too large" }, 413);
        }

        // 3. HMAC verify over the raw body, constant-time. Missing or mismatched
        // header → 401, append nothing (R2). SHA-1 `X-Hub-Signature` is legacy and
        // is deliberately NOT accepted as a fallback.
        const signature = c.req.header("x-hub-signature-256");
        const expected = computeGitHubSignature(config.secret, raw);
        if (!signature || !constantTimeEquals(signature, expected)) {
          return c.json({ error: "Invalid signature" }, 401);
        }

        const store = getStore();
        if (!store) {
          return c.json({ error: "Store not available" }, 503);
        }

        // 4. Idempotency pre-check (R3): a repeated X-GitHub-Delivery is a no-op.
        // The AUTHORITATIVE dedup is the PK INSERT inside recordWebhookEvent's
        // transaction (step 6) — this only saves the parse+resolve work.
        const deliveryId = c.req.header("x-github-delivery");
        if (!deliveryId) {
          return c.json({ error: "Missing X-GitHub-Delivery" }, 400);
        }
        if (store.initiatives.isDeliverySeen(deliveryId)) {
          return c.json({ status: "duplicate" }, 200);
        }

        // 5. Parse permissively; unparseable → 400.
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          return c.json({ error: "Invalid JSON body" }, 400);
        }
        const parsed = GitHubWebhookEventSchema.safeParse(json);
        if (!parsed.success) {
          return c.json(
            { error: "Invalid webhook body", details: parsed.error.issues },
            400
          );
        }
        const payload = parsed.data;

        const event = c.req.header("x-github-event") ?? "";

        // Issue #3128 (KD3): score a gate-bot checkpoint-label revert BEFORE and
        // INDEPENDENT of initiative resolution — a revert on a repo with NO
        // matching initiative must still be scored. Fire-and-forget: guarded so a
        // scorecard fault never affects the webhook response (OR2).
        const scorecardStore = getScorecardStore?.() ?? null;
        if (scorecardStore) {
          try {
            recordGateViolationIfApplicable(
              scorecardStore,
              event,
              payload,
              gateBotLogin
            );
          } catch (scorecardError) {
            errorLogger?.warn(
              "gate-violation scorecard record failed (non-fatal)",
              {
                category: "github-webhook-scorecard",
                context: { error: String(scorecardError) },
              }
            );
          }
        }

        const mapped = mapWebhook(event, payload);
        // Unmapped event/action (ping, PR-closed-without-merge, …) → ignore.
        if (!mapped) {
          return c.json({ status: "ignored", reason: "unmapped-event" }, 202);
        }
        const repoFullName = payload.repository?.full_name;
        if (!repoFullName) {
          return c.json({ status: "ignored", reason: "no-repository" }, 202);
        }
        const initiativeId = store.initiatives.resolveByRepoIssue(
          repoFullName,
          mapped.issueNumber
        );
        // No matching initiative → 202 ignored, NOT an error (R1 / KD).
        if (!initiativeId) {
          return c.json({ status: "ignored", reason: "no-initiative" }, 202);
        }

        // 6. 🔴 ONE transaction: dedup INSERT + appendEvent + health stamp.
        const eventPayload: Record<string, unknown> = {
          repo: repoFullName,
          action: payload.action ?? null,
          issueNumber: mapped.issueNumber,
          deliveryId,
          sender: payload.sender?.login ?? null,
        };
        if (payload.label?.name) eventPayload.label = payload.label.name;
        if (payload.pull_request?.merged !== undefined) {
          eventPayload.merged = payload.pull_request.merged;
        }

        const { duplicate } = store.initiatives.recordWebhookEvent({
          deliveryId,
          event,
          repo: repoFullName,
          initiativeId,
          kind: mapped.kind,
          payload: eventPayload,
        });
        if (duplicate) {
          return c.json({ status: "duplicate" }, 200);
        }
        // Return 202 fast — GitHub expects a response within ~10s and treats slow
        // endpoints as failures. All work above is synchronous (sync store, low
        // volume) and no `gh`/subprocess is called here.
        return c.json({ status: "accepted", kind: mapped.kind }, 202);
      } catch (error) {
        // A receiver 500 must never crash the process (fail-open).
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "github-webhook",
          fallbackMessage: "Webhook processing failed",
        });
      }
    }
  );

  return app;
}
