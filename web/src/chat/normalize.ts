// SPDX-License-Identifier: AGPL-3.0-only
import { unwrapRoleWrappedRecordEnvelope } from "@hapi/protocol/messages";
import type { DecryptedMessage } from "@/types/api";
import type { NormalizedMessage } from "@/chat/types";
import { safeStringify } from "@/chat/normalizeUtils";
import {
  isCodexContent,
  isOutputContent,
  isSkippableAgentContent,
  normalizeAgentRecord,
} from "@/chat/normalizeAgent";
import { normalizeUserRecord } from "@/chat/normalizeUser";

export function normalizeDecryptedMessage(
  message: DecryptedMessage
): NormalizedMessage | null {
  const record = unwrapRoleWrappedRecordEnvelope(message.content);
  if (!record) {
    return {
      id: message.id,
      localId: message.localId,
      createdAt: message.createdAt,
      role: "agent",
      isSidechain: false,
      content: [
        {
          type: "text",
          text: safeStringify(message.content),
          uuid: message.id,
          parentUUID: null,
        },
      ],
      status: message.status,
      originalText: message.originalText,
      denial: message.denial,
    };
  }

  if (record.role === "user") {
    const normalized = normalizeUserRecord(
      message.id,
      message.localId,
      message.createdAt,
      record.content,
      record.meta
    );
    return normalized
      ? {
          ...normalized,
          status: message.status,
          originalText: message.originalText,
          denial: message.denial,
        }
      : {
          id: message.id,
          localId: message.localId,
          createdAt: message.createdAt,
          role: "user",
          isSidechain: false,
          content: { type: "text", text: safeStringify(record.content) },
          meta: record.meta,
          status: message.status,
          originalText: message.originalText,
          denial: message.denial,
        };
  }
  if (record.role === "agent") {
    if (isSkippableAgentContent(record.content)) {
      return null;
    }
    const normalized = normalizeAgentRecord(
      message.id,
      message.localId,
      message.createdAt,
      record.content,
      record.meta
    );
    if (!normalized && isCodexContent(record.content)) {
      return null;
    }
    if (!normalized && isOutputContent(record.content)) {
      return null;
    }
    return normalized
      ? {
          ...normalized,
          status: message.status,
          originalText: message.originalText,
          denial: message.denial,
        }
      : {
          id: message.id,
          localId: message.localId,
          createdAt: message.createdAt,
          role: "agent",
          isSidechain: false,
          content: [
            {
              type: "text",
              text: safeStringify(record.content),
              uuid: message.id,
              parentUUID: null,
            },
          ],
          meta: record.meta,
          status: message.status,
          originalText: message.originalText,
          denial: message.denial,
        };
  }

  return {
    id: message.id,
    localId: message.localId,
    createdAt: message.createdAt,
    role: "agent",
    isSidechain: false,
    content: [
      {
        type: "text",
        text: safeStringify(record.content),
        uuid: message.id,
        parentUUID: null,
      },
    ],
    meta: record.meta,
    status: message.status,
    originalText: message.originalText,
    denial: message.denial,
  };
}
