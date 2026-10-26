// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from "../../sync/syncEngine";
import type { NotificationChannel } from "@hapi/protocol/ext";
import { getAgentName } from "../../notifications/sessionInfo";
import type { PushService } from "../../push/pushService";
import { buildSessionPushPayloadFromSession } from "../../push/sessionPushPayload";

// Issue #4921: every push from this channel is titled by its session (emoji +
// name) with the event as the body, tagged `<kind>:<sessionId>`, and opens the
// session when tapped. The `data.type` strings stay the service worker's
// per-type toggle vocabulary.
export class PushNotificationChannel implements NotificationChannel {
  constructor(
    private readonly pushService: PushService,
    _appUrl: string
  ) {}

  async sendPermissionRequest(session: Session): Promise<void> {
    if (!session.active) {
      return;
    }

    const request = session.agentState?.requests
      ? Object.values(session.agentState.requests)[0]
      : null;
    const toolName = request?.tool ?? "Tool";

    await this.pushService.sendToNamespace(
      session.namespace,
      buildSessionPushPayloadFromSession(
        session,
        "permission",
        "permission-request",
        `Permission: ${toolName}`
      )
    );
  }

  async sendReady(session: Session): Promise<void> {
    if (!session.active) {
      return;
    }

    await this.pushService.sendToNamespace(
      session.namespace,
      buildSessionPushPayloadFromSession(
        session,
        "ready",
        "ready",
        `${getAgentName(session)} ready`
      )
    );
  }

  async sendQuestion(session: Session, questionSummary: string): Promise<void> {
    if (!session.active) {
      return;
    }

    await this.pushService.sendToNamespace(
      session.namespace,
      buildSessionPushPayloadFromSession(
        session,
        "question",
        "question",
        questionSummary || `${getAgentName(session)} has a question`
      )
    );
  }

  async sendError(session: Session, errorMessage: string): Promise<void> {
    if (!session.active) {
      return;
    }

    await this.pushService.sendToNamespace(
      session.namespace,
      buildSessionPushPayloadFromSession(
        session,
        "error",
        "error",
        errorMessage || "Error"
      )
    );
  }
}
