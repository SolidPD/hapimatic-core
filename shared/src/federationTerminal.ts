// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// ─── Federation Terminal Proxy Protocol ─────────────────────
//
// JSON messages sent over raw WebSocket between hub and node
// for proxying terminal I/O to remote sessions.

// Hub → Node messages
export const FedTermCreateSchema = z.object({
  type: z.literal("create"),
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  // #4517: opt-in persistence, additive. An old node strips the unknown field
  // and keeps legacy (close-on-WS-close) behaviour, and its ready carries no
  // persistence ack, so the hub treats the terminal as legacy too. Do NOT add
  // new message types: an old hub parses node→hub messages with
  // FedTermNodeMessageSchema.safeParse and silently drops unknown types, and an
  // old node answers an unknown hub→node type with an "Invalid message schema"
  // error.
  persistent: z.boolean().optional(),
  // #4517: the browser socket's namespace, asserted by the hub. The node
  // refuses a create whose namespace does not match the session's, and one
  // that carries none (fail closed, like the #1097 session-mutation routes),
  // so a socket in one namespace cannot open or take over another's shell.
  namespace: z.string().min(1).optional(),
  // #4517: the user tapped "Start new shell". Only discards an exited
  // persistent shell's record so a new one spawns; never kills a live shell.
  fresh: z.boolean().optional(),
});

export const FedTermWriteSchema = z.object({
  type: z.literal("write"),
  terminalId: z.string().min(1),
  data: z.string(),
});

export const FedTermResizeSchema = z.object({
  type: z.literal("resize"),
  terminalId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const FedTermCloseSchema = z.object({
  type: z.literal("close"),
  terminalId: z.string().min(1),
});

export const FedTermHubMessageSchema = z.discriminatedUnion("type", [
  FedTermCreateSchema,
  FedTermWriteSchema,
  FedTermResizeSchema,
  FedTermCloseSchema,
]);

export type FedTermHubMessage = z.infer<typeof FedTermHubMessageSchema>;

// Node → Hub messages
export const FedTermReadySchema = z.object({
  type: z.literal("ready"),
  terminalId: z.string().min(1),
  // #4517: true only when the node's CLI confirmed a persistent shell. An
  // older node omits the field; a newer node whose CLI is older sends false.
  // Anything but true means the shell is ephemeral, so the hub treats the
  // terminal as legacy and the browser keeps its screen (no snapshot follows).
  persistent: z.boolean().optional(),
});

export const FedTermOutputSchema = z.object({
  type: z.literal("output"),
  terminalId: z.string().min(1),
  data: z.string(),
});

export const FedTermExitSchema = z.object({
  type: z.literal("exit"),
  terminalId: z.string().min(1),
  code: z.number().nullable(),
  signal: z.string().nullable(),
});

export const FedTermErrorSchema = z.object({
  type: z.literal("error"),
  terminalId: z.string().min(1),
  message: z.string(),
});

export const FedTermNodeMessageSchema = z.discriminatedUnion("type", [
  FedTermReadySchema,
  FedTermOutputSchema,
  FedTermExitSchema,
  FedTermErrorSchema,
]);

export type FedTermNodeMessage = z.infer<typeof FedTermNodeMessageSchema>;
