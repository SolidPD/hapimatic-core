// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from "../../sync/syncEngine";
import type { NotificationChannel } from "@hapi/protocol/ext";
import { getAgentName, getSessionName } from "../../notifications/sessionInfo";
import type { PushPayload, PushService } from "../../push/pushService";

/**
 * Extract the project directory name from the session's working path.
 * e.g. "/home/matt/projects/hapimatic-private-dev" → "hapimatic-private-dev"
 */
function getProjectName(session: Session): string | null {
  const path = session.metadata?.path;
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/**
 * Build a display prefix from session emoji (if set).
 * e.g. session.emoji = "🚀" → "🚀 "
 */
function getEmojiPrefix(session: Session): string {
  return session.emoji ? `${session.emoji} ` : "";
}

export class PushNotificationChannel implements NotificationChannel {
  constructor(
    private readonly pushService: PushService,
    _appUrl: string
  ) {}

  async sendPermissionRequest(session: Session): Promise<void> {
    if (!session.active) {
      return;
    }

    const name = getSessionName(session);
    const prefix = getEmojiPrefix(session);
    const project = getProjectName(session);
    const request = session.agentState?.requests
      ? Object.values(session.agentState.requests)[0]
      : null;
    const toolName = request?.tool ?? "Tool";

    const payload: PushPayload = {
      title: `${prefix}Permission: ${toolName}`,
      body: project ? `${name} · ${project}` : name,
      tag: `permission-${session.id}`,
      data: {
        type: "permission-request",
        sessionId: session.id,
        url: this.buildSessionPath(session.id),
      },
    };

    await this.pushService.sendToNamespace(session.namespace, payload);
  }

  async sendReady(session: Session): Promise<void> {
    if (!session.active) {
      return;
    }

    const agentName = getAgentName(session);
    const name = getSessionName(session);
    const prefix = getEmojiPrefix(session);
    const project = getProjectName(session);

    const payload: PushPayload = {
      title: `${prefix}${agentName} Ready`,
      body: project ? `${name} · ${project}` : name,
      tag: `ready-${session.id}`,
      data: {
        type: "ready",
        sessionId: session.id,
        url: this.buildSessionPath(session.id),
      },
    };

    await this.pushService.sendToNamespace(session.namespace, payload);
  }

  async sendQuestion(session: Session, questionSummary: string): Promise<void> {
    if (!session.active) {
      return;
    }

    const name = getSessionName(session);
    const prefix = getEmojiPrefix(session);
    const project = getProjectName(session);
    const contextSuffix = project ? ` · ${project}` : "";

    const payload: PushPayload = {
      title: `${prefix}Question`,
      body: questionSummary
        ? `${questionSummary}${contextSuffix}`
        : `Claude has a question in ${name}${contextSuffix}`,
      tag: `question-${session.id}`,
      data: {
        type: "question",
        sessionId: session.id,
        url: this.buildSessionPath(session.id),
      },
    };

    await this.pushService.sendToNamespace(session.namespace, payload);
  }

  async sendError(session: Session, errorMessage: string): Promise<void> {
    if (!session.active) {
      return;
    }

    const name = getSessionName(session);
    const prefix = getEmojiPrefix(session);
    const project = getProjectName(session);
    const contextSuffix = project ? ` · ${project}` : "";

    const payload: PushPayload = {
      title: `${prefix}Error`,
      body: errorMessage
        ? `${errorMessage}${contextSuffix}`
        : `Error in ${name}${contextSuffix}`,
      tag: `error-${session.id}`,
      data: {
        type: "error",
        sessionId: session.id,
        url: this.buildSessionPath(session.id),
      },
    };

    await this.pushService.sendToNamespace(session.namespace, payload);
  }

  private buildSessionPath(sessionId: string): string {
    return `/sessions/${sessionId}`;
  }
}
