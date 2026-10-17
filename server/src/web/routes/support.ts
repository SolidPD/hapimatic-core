// SPDX-License-Identifier: AGPL-3.0-only
/**
 * In-app self-help support (issue #4371, E6 Sub F).
 *
 *  - `GET  /api/support/channel`            where escalations go + the hours text
 *  - `POST /api/support/session`            open — or reuse — the support session
 *  - `POST /api/support/escalation/preview` the redacted bundle + its sha256
 *  - `POST /api/support/escalation/send`    send exactly the previewed bundle
 *
 * All four mount under `/api` behind the JWT middleware.
 *
 * THE SUPPORT SESSION (R1, R4) is a normal simple session of the user's own
 * harness and account, in `<dataDir>/support` — the materialized persona +
 * offline docs (`support/supportWorkspace.ts`). It is spawned with `yolo: false`
 * written EXPLICITLY (an omitted `yolo` spawns in YOLO mode — the daemon tests
 * `options.yolo !== false`) and with `safeMode` unset (safe mode disables
 * CLAUDE.md and would strip the persona). It spawns on the machine whose daemon
 * runs on THIS server host (`metadata.host === os.hostname()`), because the
 * workspace exists only here and a federated hub lists remote machines too.
 * Reuse matches an ACTIVE session IN THE CALLER'S NAMESPACE at the workspace
 * path, so one user is never handed another user's support transcript.
 *
 * THE ESCALATION (R3) is bound to what the user saw: `preview` returns the
 * bundle text and its sha256; `send` recomposes and answers 409 when the hash
 * differs (the conversation moved on — preview again). Delivery reuses the
 * feedback pipeline (persist the row first, category `support-escalation`, the
 * bundle as a JSON attachment), so every transport the feedback feature has
 * also carries escalations; `telegram` (operator installs only — never a hosted
 * tenant, decision 2) persists the row and posts the bundle to the operator's
 * chat.
 */
import { Hono } from "hono";
import { hostname } from "node:os";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import type { Session } from "@hapi/protocol/types";
import type { Store } from "../../store";
import type { ErrorLogSeverity } from "../../store/types";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import { cataloged } from "../../capabilities/cataloged";
import type { FeedbackSenderConfig } from "../../feedback/feedbackSender";
import type { SupportChannelConfig } from "../../config/serverSettings";
import { persistAndSendFeedback, type PersistAndSendInput } from "./feedback";
import {
  materializeSupportWorkspace,
  supportWorkspacePath,
} from "../../support/supportWorkspace";
import {
  composeEscalationBundle,
  escalationBundleHash,
  serializeEscalationBundle,
  type EscalationBundle,
} from "../../support/escalationBundle";

export const SUPPORT_SESSION_NAME = "Help";
export const ESCALATION_ATTACHMENT_NAME = "support-escalation.json";

/** Error-log severities that count as "recent errors" in an escalation. */
const BUNDLE_ERROR_SEVERITIES: readonly ErrorLogSeverity[] = ["error", "fatal"];

const openSessionBodySchema = z
  .object({
    agent: z.enum(["claude", "codex", "gemini", "opencode"]).optional(),
  })
  .strict();

const previewBodySchema = z.object({ sessionId: z.string().min(1).max(200) });

const sendBodySchema = z.object({
  sessionId: z.string().min(1).max(200),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The login username (≡ account email), so the operator can reply — the
   *  same field the feedback form sends. */
  submitterEmail: z.string().max(320).nullable().optional(),
});

export interface SupportRouteOptions {
  store: Store;
  getSyncEngine: () => SyncEngine | null;
  dataDir: string;
  version: string;
  feedbackSender: FeedbackSenderConfig;
  channel: SupportChannelConfig;
  telegramBotToken: string | null;
  /** Exact secret values this instance knows, read at compose time. */
  getSecretLiterals: () => readonly string[];
  /** The resolved launcher kind (`GET /api/launcher/status`'s value). */
  getLauncherKind: () => string;
  /** Test seam: this host's name (default `os.hostname()`). */
  getHostname?: () => string;
  /** Test seam: Telegram delivery (default: the Bot API `sendDocument`). */
  sendTelegram?: (args: {
    botToken: string;
    chatId: string;
    caption: string;
    filename: string;
    text: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** Post the bundle to a Telegram chat as a document (operator installs only). */
export async function sendTelegramDocument(args: {
  botToken: string;
  chatId: string;
  caption: string;
  filename: string;
  text: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const form = new FormData();
    form.set("chat_id", args.chatId);
    form.set("caption", args.caption.slice(0, 1000));
    form.set(
      "document",
      new Blob([args.text], { type: "application/json" }),
      args.filename
    );
    const res = await fetch(
      `https://api.telegram.org/bot${args.botToken}/sendDocument`,
      { method: "POST", body: form }
    );
    if (!res.ok) {
      return { ok: false, error: `Telegram sendDocument: HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    // Never echo the URL: it carries the bot token.
    return {
      ok: false,
      error: `Telegram sendDocument failed: ${err instanceof Error ? err.name : "error"}`,
    };
  }
}

function isSupportSession(session: Session, workspace: string): boolean {
  return session.metadata?.path === workspace;
}

export function createSupportRoutes(
  opts: SupportRouteOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const workspace = supportWorkspacePath(opts.dataDir);
  const getHostname = opts.getHostname ?? hostname;
  const sendTelegram = opts.sendTelegram ?? sendTelegramDocument;
  const sessionLimiter = createRateLimiter({
    name: "support-session",
    limit: 10,
  });
  const escalationLimiter = createRateLimiter({
    name: "support-escalation",
    limit: 10,
  });

  /** Compose the bundle for a support session in the caller's namespace. */
  function compose(
    engine: SyncEngine,
    sessionId: string,
    namespace: string
  ): { bundle: EscalationBundle; text: string; hash: string } | null {
    const session = engine.getSessionByNamespace(sessionId, namespace);
    if (!session || !isSupportSession(session, workspace)) return null;
    // Real errors only: info and warn rows (a rename, a retitle) would
    // otherwise fill the bundle's few "recent errors" slots.
    const keys = session.tag ? [session.id, session.tag] : [session.id];
    const errors = keys.flatMap(sessionKey =>
      BUNDLE_ERROR_SEVERITIES.flatMap(severity =>
        opts.store.errorLogs.getEntries({
          sessionId: sessionKey,
          severity,
          limit: 3,
        })
      )
    );
    const bundle = composeEscalationBundle({
      version: opts.version,
      launcher: opts.getLauncherKind(),
      harness: session.metadata?.flavor ?? "claude",
      sessionId: session.id,
      messages: opts.store.messages.getMessages(session.id, 200),
      errors,
      secretLiterals: opts.getSecretLiterals(),
    });
    const text = serializeEscalationBundle(bundle);
    return { bundle, text, hash: escalationBundleHash(text) };
  }

  app.get(
    "/support/channel",
    cataloged(
      defineCapability({
        id: "harness-admin.support-channel",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Report where in-app support escalations are delivered (relay, agentmail, telegram, or none), the human-support hours text, and the support workspace path.",
        whenToUse:
          "When the Help page decides between a Send button and the open-an-issue link.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/support/channel",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c =>
      c.json({
        kind: opts.channel.kind,
        hoursText: opts.channel.hoursText,
        issueUrl: opts.channel.issueUrl,
        workspacePath: workspace,
      })
  );

  app.post(
    "/support/session",
    cataloged(
      defineCapability({
        id: "session-lifecycle.open-support-session",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Open the in-app support session — reuse the caller's active one, else spawn a simple session primed with the support persona and offline docs on this host's machine, in the default permission mode.",
        whenToUse: "When the user asks the in-app assistant for help.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/support/session",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"agent":"claude"}',
      })
    ),
    sessionLimiter,
    async c => {
      const engine = opts.getSyncEngine();
      if (!engine) return c.json({ error: "Not connected" }, 503);
      const namespace = c.get("namespace");

      const json = await c.req.json().catch(() => ({}));
      const parsed = openSessionBodySchema.safeParse(json ?? {});
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      materializeSupportWorkspace(opts.dataDir, opts.version);

      const existing = engine
        .getSessionsByNamespace(namespace)
        .find(s => s.active && isSupportSession(s, workspace));
      if (existing) {
        return c.json({ sessionId: existing.id, reused: true });
      }

      const host = getHostname();
      const machine = engine
        .getOnlineMachinesByNamespace(namespace)
        .find(m => m.metadata?.host === host);
      if (!machine) {
        return c.json(
          {
            error:
              "No machine on this server's host is online, so the support session cannot start here.",
            code: "no_local_machine",
          },
          409
        );
      }

      const result = await engine.spawnSession({
        machineId: machine.id,
        directory: workspace,
        agent: parsed.data.agent ?? "claude",
        // Explicit: an omitted yolo spawns in YOLO mode (R4).
        yolo: false,
        sessionType: "simple",
        name: SUPPORT_SESSION_NAME,
      });
      if (result.type === "error") {
        const status =
          result.code === "account_unrefreshable" ||
          result.code === "account_token_expired" ||
          result.code === "at_capacity"
            ? 409
            : 502;
        return c.json({ error: result.message, code: result.code }, status);
      }
      return c.json({ sessionId: result.sessionId, reused: false });
    }
  );

  app.post(
    "/support/escalation/preview",
    cataloged(
      defineCapability({
        id: "harness-admin.support-escalation-preview",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Compose the redacted Contact-a-human bundle for a support session (version, launcher, harness, recent errors, conversation text) and return it with its sha256, without sending anything.",
        whenToUse: "Before the user decides to contact a human.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/support/escalation/preview",
        },
        auth: "jwt",
        // Content-bearing (it returns the conversation), and a POST: never
        // `readonly`, so the generic invoker cannot launch it (#3746 R4).
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    escalationLimiter,
    async c => {
      const engine = opts.getSyncEngine();
      if (!engine) return c.json({ error: "Not connected" }, 503);
      const parsed = previewBodySchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
      const composed = compose(
        engine,
        parsed.data.sessionId,
        c.get("namespace")
      );
      if (!composed) {
        return c.json({ error: "Support session not found" }, 404);
      }
      return c.json({
        bundle: composed.text,
        hash: composed.hash,
        channel: opts.channel.kind,
      });
    }
  );

  app.post(
    "/support/escalation/send",
    cataloged(
      defineCapability({
        id: "harness-admin.support-escalation-send",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Send the previewed Contact-a-human bundle to the configured support channel; refuses (409) when the bundle changed since the preview or no channel is configured.",
        whenToUse: "When the user confirms sending the previewed bundle.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/support/escalation/send",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    escalationLimiter,
    async c => {
      const engine = opts.getSyncEngine();
      if (!engine) return c.json({ error: "Not connected" }, 503);
      const namespace = c.get("namespace");
      const parsed = sendBodySchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) return c.json({ error: "Invalid body" }, 400);

      if (opts.channel.kind === "none") {
        return c.json(
          { error: "No support channel is configured", code: "no_channel" },
          409
        );
      }

      const composed = compose(engine, parsed.data.sessionId, namespace);
      if (!composed) {
        return c.json({ error: "Support session not found" }, 404);
      }
      if (composed.hash !== parsed.data.hash) {
        return c.json(
          {
            error:
              "The conversation changed since the preview. Review the new preview before sending.",
            code: "bundle_changed",
          },
          409
        );
      }

      const description =
        `Support escalation from the in-app assistant (Hapimatic ${composed.bundle.hapimaticVersion}, ` +
        `${composed.bundle.harness}). The redacted bundle the user reviewed is attached as ` +
        `${ESCALATION_ATTACHMENT_NAME}.`;
      const attachment = {
        filename: ESCALATION_ATTACHMENT_NAME,
        mimeType: "application/json",
        data: Buffer.from(composed.text, "utf8").toString("base64"),
      };
      const metadata = {
        appVersion: composed.bundle.hapimaticVersion,
        session: {
          sessionId: composed.bundle.sessionId,
          flavor: composed.bundle.harness,
          launcherKind: composed.bundle.launcher,
        },
      };

      // One entry for every channel, so the Telegram and email rows cannot drift.
      const entry: PersistAndSendInput = {
        namespace,
        category: "support-escalation",
        description,
        submitterEmail: parsed.data.submitterEmail ?? null,
        metadata,
        attachments: [attachment],
      };

      if (opts.channel.kind === "telegram") {
        // Persist first (transport off), then post to the operator's chat.
        const { id } = await persistAndSendFeedback(
          opts.store,
          { ...opts.feedbackSender, transport: "off" },
          entry
        );
        const sent =
          opts.telegramBotToken && opts.channel.telegramChatId
            ? await sendTelegram({
                botToken: opts.telegramBotToken,
                chatId: opts.channel.telegramChatId,
                caption: description,
                filename: ESCALATION_ATTACHMENT_NAME,
                text: composed.text,
              })
            : ({ ok: false, error: "Telegram is not configured" } as const);
        opts.store.feedback.updateEmailStatus(
          id,
          sent.ok,
          sent.ok ? null : sent.error
        );
        return c.json({ id, delivered: sent.ok }, 201);
      }

      const result = await persistAndSendFeedback(
        opts.store,
        opts.feedbackSender,
        entry
      );
      return c.json(
        { id: result.id, delivered: result.delivery === "sent" },
        201
      );
    }
  );

  return app;
}
