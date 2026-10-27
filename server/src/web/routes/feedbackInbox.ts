// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Feedback inbox proxy — the operator instance's browser-facing half of the
 * universal feedback inbox (issue #2912, epic #2909 Sub C).
 *
 * The browser only ever talks to its own instance; these routes forward to the
 * gateway's operator-bearer inbox (`gateway/src/routes/feedbackInbox.ts`)
 * through `feedback/inboxClient.ts`. Every route takes #2910's `operatorOnly`
 * gate as a route argument, opened only when BOTH `HAPI_OPERATOR_INSTANCE` is
 * set AND the gateway credential (`FEEDBACK_INBOX_URL` + `FEEDBACK_INBOX_TOKEN`)
 * is configured — closed is a plain 404, and since #5571 a closed gate also
 * drops the route from the capability catalog. A customer VM is closed by
 * construction: it never holds the operator credential.
 *
 * The acting operator is computed here, never taken from the browser: the
 * node label plus the JWT namespace (`<nodeLabel>/<namespace>`), sent to the
 * gateway in `x-hapi-feedback-actor`. The namespace is self-asserted by the
 * access token (`utils/accessToken.ts`), so it is an attribution hint, not
 * authentication.
 *
 * Convert-to-issue files the row into the server-configured repo
 * (`FEEDBACK_ISSUE_REPO`) with the host `gh` CLI, idempotently: claim the row
 * (`acknowledged`, compare-and-set) → reuse an existing link → find an issue
 * already filed for it by its `feedback-row:<id>` marker → else file one →
 * stamp the row `actioned` with the issue. A failed stamp answers `stamped:
 * false`, and repeating Convert stamps the issue already filed.
 */
import {
  FEEDBACK_ROW_MARKER_PREFIX,
  FeedbackInboxFiltersSchema,
  FeedbackPatchSchema,
  feedbackLinkedIssueUrl,
  neutralizeUntrustedText,
  renderUntrustedFeedbackText,
  type FeedbackInboxItem,
} from "@hapi/protocol/feedbackSink";
import { defineCapability } from "@hapi/protocol";
import { Hono, type Context } from "hono";

import { cataloged } from "../../capabilities/cataloged";
import type { FeedbackInboxConfig } from "../../config/serverSettings";
import {
  createFeedbackInboxClient,
  type FeedbackInboxClient,
  type FeedbackInboxResult,
} from "../../feedback/inboxClient";
import { runGhWithBunSpawn, type GhRunner } from "../../utils/githubCli";
import type { WebAppEnv } from "../middleware/auth";
import { operatorOnly } from "../middleware/operatorOnly";
import { createRateLimiter } from "../middleware/rateLimit";

/** The canonical label every converted issue carries. */
export const FEEDBACK_ISSUE_LABEL = "🏷️ type: ✉️ feedback";
/** Bound on one `gh` call. */
export const FEEDBACK_GH_TIMEOUT_MS = 30_000;
/** How far before the claim an existing issue may be dated (clock skew). */
const MARKER_SKEW_MS = 5 * 60 * 1000;
const TITLE_MAX = 80;

export interface FeedbackInboxProxyOptions {
  /** `HAPI_OPERATOR_INSTANCE` (`resolveOperatorInstanceEnabled`). */
  operatorInstanceEnabled?: boolean;
  /** The gateway credential; null keeps every route closed. */
  inboxConfig: FeedbackInboxConfig | null;
  /** This node's label, the first half of the recorded actor. */
  nodeLabel: string;
  /** `FEEDBACK_ISSUE_REPO`; null turns Convert off (`issue_repo_invalid`). */
  issueRepo: string | null;
  runGh?: GhRunner;
  fetchImpl?: typeof fetch;
}

/** `<nodeLabel>/<namespace>` as printable ASCII, at most 200 characters. */
export function feedbackActor(nodeLabel: string, namespace: string): string {
  const printable = (text: string) => text.replace(/[^\x20-\x7e]/g, "?");
  const actor = `${printable(nodeLabel) || "node"}/${printable(namespace) || "anonymous"}`;
  return actor.slice(0, 200);
}

/** Map a failed gateway call to the instance's stable error body. */
function failure(c: Context<WebAppEnv>, result: FeedbackInboxResult<unknown>) {
  if (result.ok) throw new Error("failure() called on a success");
  switch (result.reason) {
    case "not_found":
      return c.json({ error: "not_found" }, 404);
    case "conflict":
      return c.json({ error: "conflict", current: result.current }, 409);
    case "invalid":
      return c.json({ error: "invalid" }, 400);
    case "unavailable":
      return c.json({ error: "inbox_unavailable" }, 502);
  }
}

export function createFeedbackInboxProxyRoutes(
  options: FeedbackInboxProxyOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const gate = operatorOnly(
    options.operatorInstanceEnabled === true && options.inboxConfig !== null
  );
  const limiter = createRateLimiter({ name: "feedback-inbox", limit: 120 });
  const convertLimiter = createRateLimiter({
    name: "feedback-inbox-convert",
    limit: 20,
  });
  const client: FeedbackInboxClient | null =
    options.inboxConfig === null
      ? null
      : createFeedbackInboxClient(options.inboxConfig, options.fetchImpl);
  const runGh = withTimeout(options.runGh ?? runGhWithBunSpawn);
  // Only reached past the gate, which is closed whenever the client is null.
  const inbox = (): FeedbackInboxClient => client as FeedbackInboxClient;
  const actorOf = (c: Context<WebAppEnv>) =>
    feedbackActor(options.nodeLabel, c.get("namespace"));

  app.get(
    "/feedback/inbox",
    cataloged(
      defineCapability({
        id: "harness-admin.feedback-inbox-list",
        domain: "harness-admin",
        surface: "rest",
        description:
          "List the operators' shared feedback inbox (every instance's feedback, from the gateway's central store) with status, category, origin and text filters.",
        whenToUse:
          "When triaging submitted feedback across every node and customer VM.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/feedback/inbox",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    gate,
    limiter,
    async c => {
      const filters = FeedbackInboxFiltersSchema.safeParse(c.req.query());
      if (!filters.success) return c.json({ error: "invalid_query" }, 400);
      const result = await inbox().list(filters.data);
      return result.ok ? c.json(result.data) : failure(c, result);
    }
  );

  // Registered before `/:id`, so "counts" is never read as an id.
  app.get(
    "/feedback/inbox/counts",
    cataloged(
      defineCapability({
        id: "harness-admin.feedback-inbox-counts",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Per-status totals of the shared feedback inbox, plus every origin with its row count.",
        whenToUse:
          "When showing how much feedback is waiting, or listing the origins to filter by.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/feedback/inbox/counts",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    gate,
    limiter,
    async c => {
      const result = await inbox().counts();
      return result.ok ? c.json(result.data) : failure(c, result);
    }
  );

  app.get(
    "/feedback/inbox/:id",
    cataloged(
      defineCapability({
        id: "harness-admin.feedback-inbox-get",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Read one row of the shared feedback inbox with its lifecycle (status, who acted, note, linked issue).",
        whenToUse: "When checking a single feedback row's current state.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/feedback/inbox/:id",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    gate,
    limiter,
    async c => {
      const result = await inbox().get(c.req.param("id"));
      return result.ok ? c.json(result.data) : failure(c, result);
    }
  );

  app.patch(
    "/feedback/inbox/:id",
    cataloged(
      defineCapability({
        id: "harness-admin.feedback-inbox-patch",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Move a feedback inbox row through its lifecycle (acknowledge, dismiss with a note, reopen), recorded against the acting operator; compare-and-set with expectedStatus.",
        whenToUse:
          "When acknowledging, dismissing or reopening a feedback row.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/api/feedback/inbox/:id",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    limiter,
    async c => {
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
      // The schema strips any actor the browser sends; the actor is ours.
      const body = FeedbackPatchSchema.safeParse(json);
      if (!body.success) return c.json({ error: "invalid_body" }, 400);
      const result = await inbox().patch(
        c.req.param("id"),
        body.data,
        actorOf(c)
      );
      return result.ok ? c.json(result.data) : failure(c, result);
    }
  );

  app.post(
    "/feedback/inbox/:id/convert",
    cataloged(
      defineCapability({
        id: "harness-admin.feedback-inbox-convert",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Convert a feedback inbox row into a GitHub issue labeled feedback in the server-configured repo, then mark the row actioned with the issue reference. Idempotent.",
        whenToUse: "When a feedback row should become a tracked GitHub issue.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/feedback/inbox/:id/convert",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    convertLimiter,
    async c => {
      if (options.issueRepo === null) {
        return c.json({ error: "issue_repo_invalid" }, 503);
      }
      return convert(c, {
        inbox: inbox(),
        id: c.req.param("id"),
        actor: actorOf(c),
        repo: options.issueRepo,
        runGh,
      });
    }
  );

  return app;
}

interface ConvertDeps {
  inbox: FeedbackInboxClient;
  id: string;
  actor: string;
  repo: string;
  runGh: GhRunner;
}

async function convert(c: Context<WebAppEnv>, deps: ConvertDeps) {
  const { inbox, id, actor, repo, runGh } = deps;

  // 1) The row as it is now; an existing link means it was already converted.
  const found = await inbox.get(id);
  if (!found.ok) return failure(c, found);
  let row = found.data;
  if (row.linkedIssue !== null) {
    return c.json(converted(row.linkedIssue, true));
  }

  // 2) Claim it. A row another actor acknowledged, or one already handled,
  //    is theirs: 409 with the row as it is.
  if (row.status === "new") {
    const claim = await inbox.patch(
      id,
      { status: "acknowledged", expectedStatus: ["new"] },
      actor
    );
    if (!claim.ok) return failure(c, claim);
    row = claim.data;
  } else if (row.status !== "acknowledged" || row.actedBy !== actor) {
    return c.json({ error: "conflict", current: row }, 409);
  }

  // 3) An issue already filed for this row (a retry after a lost stamp, or a
  //    create that timed out but succeeded) — found by its marker line.
  let issue: string;
  try {
    const existing = await findMarkedIssue(runGh, repo, row);
    issue = existing ?? (await createIssue(runGh, repo, row));
  } catch (err) {
    return ghFailure(c, err);
  }

  // 4) Stamp. A failure here leaves the issue filed; Convert again re-stamps it.
  const stamp = await inbox.patch(
    id,
    {
      status: "actioned",
      expectedStatus: ["acknowledged"],
      linkedIssue: issue,
    },
    actor
  );
  return c.json(converted(issue, stamp.ok));
}

function converted(issue: string, stamped: boolean) {
  return { issue, url: feedbackLinkedIssueUrl(issue), stamped };
}

/** A `gh` failure, carried through as a typed error (never its stderr). */
class GhError extends Error {
  constructor(readonly code: "gh_unavailable" | "label_missing" | "gh_failed") {
    super(code);
  }
}

function ghFailure(c: Context<WebAppEnv>, err: unknown) {
  const code = err instanceof GhError ? err.code : "gh_failed";
  const status =
    code === "gh_unavailable" ? 503 : code === "label_missing" ? 422 : 502;
  return c.json({ error: code }, status);
}

/** Run `gh`, mapping a missing binary and a non-zero exit to {@link GhError}. */
async function gh(runGh: GhRunner, args: string[]): Promise<string> {
  let result;
  try {
    result = await runGh(["gh", ...args]);
  } catch (err) {
    if (err instanceof Error && /Executable not found/i.test(err.message)) {
      throw new GhError("gh_unavailable");
    }
    throw new GhError("gh_failed");
  }
  if (result.code !== 0) {
    // `gh issue create --label <missing>` exits non-zero naming the label.
    if (
      /not found/i.test(result.stderr) &&
      result.stderr.includes("feedback")
    ) {
      throw new GhError("label_missing");
    }
    throw new GhError("gh_failed");
  }
  return result.stdout;
}

/**
 * The issue already filed for `row`, as `owner/repo#N`, or null. A consistent
 * list read, not a search (the search index lags): the labeled issues whose
 * body carries this row's marker and that were created no earlier than the
 * claim — so a row reopened after a misfiled issue files a fresh one.
 */
async function findMarkedIssue(
  runGh: GhRunner,
  repo: string,
  row: FeedbackInboxItem
): Promise<string | null> {
  const stdout = await gh(runGh, [
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    FEEDBACK_ISSUE_LABEL,
    "--state",
    "all",
    "--limit",
    "100",
    "--json",
    "number,body,createdAt",
  ]);
  let issues: Array<{ number: number; body: string; createdAt: string }>;
  try {
    issues = JSON.parse(stdout);
  } catch {
    throw new GhError("gh_failed");
  }
  const marker = `${FEEDBACK_ROW_MARKER_PREFIX}${row.id}`;
  const since = (row.actedAt ?? 0) - MARKER_SKEW_MS;
  const hit = issues.find(
    issue =>
      typeof issue.body === "string" &&
      issue.body.includes(marker) &&
      Date.parse(issue.createdAt) >= since
  );
  return hit ? `${repo}#${hit.number}` : null;
}

/** File the issue for `row` and return it as `owner/repo#N`. */
async function createIssue(
  runGh: GhRunner,
  repo: string,
  row: FeedbackInboxItem
): Promise<string> {
  const stdout = await gh(runGh, [
    "issue",
    "create",
    "--repo",
    repo,
    "--label",
    FEEDBACK_ISSUE_LABEL,
    "--title",
    issueTitle(row),
    "--body",
    issueBody(row),
  ]);
  const match = stdout.match(/\/issues\/(\d+)/);
  if (!match) throw new GhError("gh_failed");
  return `${repo}#${match[1]}`;
}

/** The description's first line, control characters stripped and neutralized, ≤ 80 chars. */
export function issueTitle(row: FeedbackInboxItem): string {
  // Strip control characters BEFORE neutralizing, so a control character inside
  // "<!--" cannot reassemble the marker after the neutralizing ran.
  const first = neutralizeUntrustedText(
    (row.description.split(/\r?\n/)[0] ?? "")
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f]/g, "")
  ).trim();
  const title = first === "" ? `Feedback ${row.id.slice(0, 8)}` : first;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

/** Plain inline code: the value with any backtick removed. */
function code(text: string): string {
  return `\`${text.replace(/`/g, "")}\``;
}

/**
 * The issue body: an operator-authored header (category, origin, received
 * time, the marker line), then the customer's text through
 * `renderUntrustedFeedbackText`, since unattended agents read these issues.
 */
export function issueBody(row: FeedbackInboxItem): string {
  return [
    "## ✉️ Feedback",
    "",
    `- **Category**: ${code(row.category)}`,
    `- **Origin**: ${code(row.originLabel)} (${row.originKind}, ${code(row.originInstanceId)})`,
    `- **Received**: ${new Date(row.receivedAt).toISOString()}`,
    `- **Central feedback row**: ${code(`${FEEDBACK_ROW_MARKER_PREFIX}${row.id}`)}`,
    "",
    "### Description",
    "",
    renderUntrustedFeedbackText(row.description),
    "",
  ].join("\n");
}

/** Bound every `gh` call; a timeout is reported as a failed call. */
function withTimeout(runGh: GhRunner): GhRunner {
  return argv =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("gh timed out")),
        FEEDBACK_GH_TIMEOUT_MS
      );
      runGh(argv).then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        err => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
}
