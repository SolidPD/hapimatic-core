// SPDX-License-Identifier: MIT
import {
  AgentStateSchema,
  MetadataSchema,
  ModelModeSchema,
  PermissionModeSchema,
  TodosSchema,
} from "@hapi/protocol/schemas";
import type { ModelMode, PermissionMode } from "@hapi/protocol/types";
import type {
  BackgroundAgentsSnapshot,
  ProviderUsageSnapshotMessage,
} from "@hapi/protocol/schemas";
import { z } from "zod";
import { UsageSchema } from "@/claude/types";
import type {
  TerminalClosePayload,
  TerminalExitPayload,
  TerminalOpenPayload,
  TerminalOutputPayload,
  TerminalReadyPayload,
  TerminalResizePayload,
  TerminalWritePayload,
  TerminalErrorPayload,
} from "@/terminal/types";
import type {
  TurnOpenPayload,
  TurnFinalizePayload,
} from "@/claude/utils/turnReporter";
import type {
  ClaudePtyOutputPayload,
  ClaudePtyResizePayload,
  ClaudePtyWritePayload,
} from "@/claude/claudePtyTypes";

export type Usage = z.infer<typeof UsageSchema>;

export type {
  AgentState,
  ClaudePermissionMode,
  CodexPermissionMode,
  Metadata,
  RepoIdentity,
  Session,
  SessionRole,
} from "@hapi/protocol/types";
export type SessionPermissionMode = PermissionMode;
export type SessionModelMode = ModelMode;

export { AgentStateSchema, MetadataSchema };

export const MachineMetadataSchema = z
  .object({
    host: z.string(),
    platform: z.string(),
    happyCliVersion: z.string(),
    homeDir: z.string(),
    happyHomeDir: z.string(),
    happyLibDir: z.string(),
    // Issue #1081/#3458: node capabilities. Agent CLIs installed on this host are
    // `agent:<name>` (e.g., `agent:claude`, `agent:codex`); hardware toolchains on
    // PATH are `tool:<name>` (e.g., `tool:kicad-cli`, #3458). Optional for backward
    // compatibility with machine records written before #1081 — the web UI treats
    // an absent capabilities array as "show all agents" (optimistic), and an absent
    // `tool:*` tag as *unknown*, never "toolchain absent".
    capabilities: z.array(z.string()).optional(),
    // Issue #3806 (epic #3345): PRESENCE-ONLY names of provider-secret env vars
    // set in the DAEMON's own environment at (re)connect — NEVER the values
    // (D11 = C). Lets the server derive Gemini-key presence from the machine
    // record (`keySource:"daemon-env"`) without the server process ever seeing
    // the var: the drop-in exists only on the `-daemon` systemd units, and the
    // daemon builds every child env as `{...process.env, ...extraEnv}`. From the
    // fixed allowlist `["OPENAI_API_KEY","GEMINI_API_KEY","GOOGLE_API_KEY"]`.
    // Additive-optional under `.passthrough()` — older records / older daemons
    // keep parsing (an absent field is "unknown", never "no key"). [ER 2026-09-19: D11]
    providerEnv: z.array(z.string()).optional(),
  })
  .passthrough();

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>;

export const DaemonStateSchema = z
  .object({
    status: z.union([z.enum(["running", "shutting-down"]), z.string()]),
    pid: z.number().optional(),
    httpPort: z.number().optional(),
    startedAt: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z
      .union([
        z.enum(["mobile-app", "cli", "os-signal", "unknown"]),
        z.string(),
      ])
      .optional(),
  })
  .passthrough();

export type DaemonState = z.infer<typeof DaemonStateSchema>;

export type Machine = {
  id: string;
  seq: number;
  createdAt: number;
  updatedAt: number;
  active: boolean;
  activeAt: number;
  metadata: MachineMetadata | null;
  metadataVersion: number;
  daemonState: DaemonState | null;
  daemonStateVersion: number;
};

export const UpdateNewMessageBodySchema = z.object({
  t: z.literal("new-message"),
  sid: z.string(),
  message: z.object({
    id: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    localId: z.string().nullable().optional(),
    content: z.unknown(),
  }),
});

export type UpdateNewMessageBody = z.infer<typeof UpdateNewMessageBodySchema>;

export const UpdateSessionBodySchema = z.object({
  t: z.literal("update-session"),
  sid: z.string(),
  metadata: z
    .object({
      version: z.number(),
      value: z.unknown(),
    })
    .nullable(),
  agentState: z
    .object({
      version: z.number(),
      value: z.unknown().nullable(),
    })
    .nullable(),
});

export type UpdateSessionBody = z.infer<typeof UpdateSessionBodySchema>;

export const UpdateMachineBodySchema = z.object({
  t: z.literal("update-machine"),
  machineId: z.string(),
  metadata: z
    .object({
      version: z.number(),
      value: z.unknown(),
    })
    .nullable(),
  daemonState: z
    .object({
      version: z.number(),
      value: z.unknown().nullable(),
    })
    .nullable(),
});

export type UpdateMachineBody = z.infer<typeof UpdateMachineBodySchema>;

export const UpdateSchema = z.object({
  id: z.string(),
  seq: z.number(),
  body: z.union([
    UpdateNewMessageBodySchema,
    UpdateSessionBodySchema,
    UpdateMachineBodySchema,
  ]),
  createdAt: z.number(),
});

export type Update = z.infer<typeof UpdateSchema>;

export const CliMessagesResponseSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      createdAt: z.number(),
      localId: z.string().nullable().optional(),
      content: z.unknown(),
    })
  ),
});

export type CliMessagesResponse = z.infer<typeof CliMessagesResponseSchema>;

export const CreateSessionResponseSchema = z.object({
  session: z.object({
    id: z.string(),
    namespace: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    metadata: z.unknown().nullable(),
    metadataVersion: z.number(),
    agentState: z.unknown().nullable(),
    agentStateVersion: z.number(),
    thinking: z.boolean(),
    thinkingAt: z.number(),
    todos: TodosSchema.optional(),
    permissionMode: PermissionModeSchema.optional(),
    modelMode: ModelModeSchema.optional(),
  }),
});

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const CreateMachineResponseSchema = z.object({
  machine: z.object({
    id: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    metadata: z.unknown().nullable(),
    metadataVersion: z.number(),
    daemonState: z.unknown().nullable(),
    daemonStateVersion: z.number(),
  }),
});

export type CreateMachineResponse = z.infer<typeof CreateMachineResponseSchema>;

export const MessageMetaSchema = z
  .object({
    sentFrom: z.string().optional(),
    fallbackModel: z.string().nullable().optional(),
    customSystemPrompt: z.string().nullable().optional(),
    appendSystemPrompt: z.string().nullable().optional(),
    allowedTools: z.array(z.string()).nullable().optional(),
    disallowedTools: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

export type MessageMeta = z.infer<typeof MessageMetaSchema>;

export const UserMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.object({
      type: z.literal("text"),
      text: z.string(),
    }),
    localKey: z.string().optional(),
    meta: MessageMetaSchema.optional(),
  })
  .passthrough();

export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AgentMessageSchema = z
  .object({
    role: z.literal("agent"),
    content: z.object({
      type: z.literal("output"),
      data: z.unknown(),
    }),
    meta: MessageMetaSchema.optional(),
  })
  .passthrough();

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const MessageContentSchema = z.union([
  UserMessageSchema,
  AgentMessageSchema,
]);

export type MessageContent = z.infer<typeof MessageContentSchema>;

export type SocketErrorReason =
  | "namespace-missing"
  | "access-denied"
  | "not-found";

export interface ServerToClientEvents {
  update: (data: Update) => void;
  "rpc-request": (
    data: { method: string; params: string },
    callback: (response: string) => void
  ) => void;
  "terminal:open": (data: TerminalOpenPayload) => void;
  "terminal:write": (data: TerminalWritePayload) => void;
  "terminal:resize": (data: TerminalResizePayload) => void;
  "terminal:close": (data: TerminalClosePayload) => void;
  "claude:pty-write": (data: ClaudePtyWritePayload) => void;
  "claude:pty-resize": (data: ClaudePtyResizePayload) => void;
  error: (data: {
    message: string;
    code?: SocketErrorReason;
    scope?: "session" | "machine";
    id?: string;
  }) => void;
}

export interface ClientToServerEvents {
  message: (data: { sid: string; message: unknown; localId?: string }) => void;
  "session-alive": (data: {
    sid: string;
    time: number;
    thinking: boolean;
    mode?: "local" | "remote";
    permissionMode?: SessionPermissionMode;
    modelMode?: SessionModelMode;
    effort?: string;
    // Composer-chip pin integrity: pinned raw model id; `null` = pin cleared.
    rawModel?: string | null;
    resolvedModel?: string;
    contextWindowTokens?: number;
    contextUsedTokens?: number;
    contextPercentage?: number;
    // Issue #4383: background-agents snapshot (K11 — T | null on the wire; the
    // server normalises null to absent). The event type already omits
    // blockedOnTuiPrompt/rateLimited (they flow untyped); backgroundAgents is
    // typed here honestly so the wire field is documented.
    backgroundAgents?: BackgroundAgentsSnapshot | null;
  }) => void;
  "session-end": (data: { sid: string; time: number }) => void;
  // Issue #1664 (epic #1662, Sub B): per-turn telemetry boundaries. The event
  // name discriminates open vs finalize; a client `turnLocalId` lets the server
  // dedup replays (R7). The server allocates the persisted `seq`.
  "turn:open": (data: { sid: string } & TurnOpenPayload) => void;
  "turn:finalize": (data: { sid: string } & TurnFinalizePayload) => void;
  // Issue #3809: OpenAI/codex pacing snapshot carrier (a distinct event on the
  // SAME /cli socket the turn reporter uses — not a parallel channel). The server
  // attributes it to the session's bound account.
  "provider-usage-snapshot": (data: ProviderUsageSnapshotMessage) => void;
  "update-metadata": (
    data: { sid: string; expectedVersion: number; metadata: unknown },
    cb: (
      answer:
        | {
            result: "error";
            reason?: SocketErrorReason;
          }
        | {
            result: "version-mismatch";
            version: number;
            metadata: unknown | null;
          }
        | {
            result: "success";
            version: number;
            metadata: unknown | null;
          }
    ) => void
  ) => void;
  "update-state": (
    data: { sid: string; expectedVersion: number; agentState: unknown | null },
    cb: (
      answer:
        | {
            result: "error";
            reason?: SocketErrorReason;
          }
        | {
            result: "version-mismatch";
            version: number;
            agentState: unknown | null;
          }
        | {
            result: "success";
            version: number;
            agentState: unknown | null;
          }
    ) => void
  ) => void;
  "machine-alive": (
    data: { machineId: string; time: number },
    cb?: (ack: { ok: boolean }) => void
  ) => void;
  "machine-update-metadata": (
    data: { machineId: string; expectedVersion: number; metadata: unknown },
    cb: (
      answer:
        | {
            result: "error";
            reason?: SocketErrorReason;
          }
        | {
            result: "version-mismatch";
            version: number;
            metadata: unknown | null;
          }
        | {
            result: "success";
            version: number;
            metadata: unknown | null;
          }
    ) => void
  ) => void;
  "machine-update-state": (
    data: {
      machineId: string;
      expectedVersion: number;
      daemonState: unknown | null;
    },
    cb: (
      answer:
        | {
            result: "error";
            reason?: SocketErrorReason;
          }
        | {
            result: "version-mismatch";
            version: number;
            daemonState: unknown | null;
          }
        | {
            result: "success";
            version: number;
            daemonState: unknown | null;
          }
    ) => void
  ) => void;
  "rpc-register": (data: { method: string }) => void;
  "rpc-unregister": (data: { method: string }) => void;
  "terminal:ready": (data: TerminalReadyPayload) => void;
  "terminal:output": (data: TerminalOutputPayload) => void;
  "terminal:exit": (data: TerminalExitPayload) => void;
  "terminal:error": (data: TerminalErrorPayload) => void;
  "claude:pty-output": (data: ClaudePtyOutputPayload) => void;
  ping: (callback: () => void) => void;
  "usage-report": (data: unknown) => void;
}
