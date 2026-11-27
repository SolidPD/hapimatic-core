// SPDX-License-Identifier: AGPL-3.0-only
import { CONTEXT_RESET_EVENTS } from "@hapi/protocol";

import type { GatedReportKind } from "../../../sync/runnerIdentity";

/**
 * Where a listener is put on a `/cli` socket: `cli` is `registerCliHandlers`
 * (`cli/index.ts`), run once per connection; `federated-terminal` is
 * `FederationTerminalNodeHandler.instrumentCliSocket`
 * (`federation/federationTerminalNode.ts`), run when a federated terminal
 * opens for the socket's session.
 */
export type SocketEventSite = "cli" | "federated-terminal";

/**
 * What protects a listener against a socket that is not the session's
 * runner (#6974 R1): the runner identity backstop with its kind, or a
 * reason it needs none. An exempt reason names its owner check by file, or,
 * where none exists, the issue that owns the question.
 */
export type SocketEventClass =
  | { class: "gated"; kind: GatedReportKind }
  | { class: "exempt"; reason: string }
  | { class: "not-session-scoped"; reason: string };

const CLI_TERMINAL_REASON =
  "Acts only on a terminal the hub bound to this socket: terminalHandlers.ts " +
  "tests entry.cliSocketId === socket.id and the session. The hub picked the " +
  "socket, and a takeover's cut removes it (cleanupTerminalHandlers). " +
  "markActivity runs before that test (D-T2 of #6974).";

const FEDERATED_TERMINAL_REASON =
  "Acts only on a federated terminal bound to this socket: " +
  "federationTerminalNode.ts tests fed.cliSocketId === cliSocketId before " +
  "any send, flag change or deletion (#6974 O11).";

/**
 * Every listener a runner's `/cli` socket carries, keyed by site and event
 * (#6974 R1, R3). `socketEventClasses.test.ts` compares this table with the
 * real listeners both ways, so a listener added without an entry fails it.
 */
export const CLI_SOCKET_EVENT_CLASSES: Readonly<
  Record<SocketEventSite, Readonly<Record<string, SocketEventClass>>>
> = {
  cli: {
    "session-alive": { class: "gated", kind: "session-alive" },
    "session-end": { class: "gated", kind: "session-end" },
    "update-metadata": { class: "gated", kind: "update-metadata" },
    "update-state": { class: "gated", kind: "update-state" },
    message: { class: "gated", kind: "message" },
    "turn:open": { class: "gated", kind: "turn:open" },
    "turn:finalize": { class: "gated", kind: "turn:finalize" },
    "provider-usage-snapshot": {
      class: "gated",
      kind: "provider-usage-snapshot",
    },
    [CONTEXT_RESET_EVENTS.arm]: { class: "gated", kind: "context-reset:arm" },
    [CONTEXT_RESET_EVENTS.disarm]: {
      class: "gated",
      kind: "context-reset:disarm",
    },
    [CONTEXT_RESET_EVENTS.result]: {
      class: "gated",
      kind: "context-reset:result",
    },
    "claude:pty-output": { class: "gated", kind: "claude:pty-output" },
    "rpc-register": {
      class: "exempt",
      reason:
        "No owner check exists (rpcHandlers.ts; rpcRegistry.ts only warns on " +
        "an overwrite). In enforce a listed key is cut at the takeover, its " +
        "registrations go with unregisterAll on its disconnect, and its " +
        "reconnect is refused. An unknown key, or a socket with no session " +
        "id, can still take a session's methods in every mode. Who may take " +
        "them is #5825 R3's question.",
    },
    "rpc-unregister": {
      class: "exempt",
      reason:
        "Removes only the sender's own registration (RpcRegistry.unregister, " +
        "rpcRegistry.ts).",
    },
    "terminal:ready": { class: "exempt", reason: CLI_TERMINAL_REASON },
    "terminal:output": { class: "exempt", reason: CLI_TERMINAL_REASON },
    "terminal:exit": {
      class: "exempt",
      reason:
        "Removes only a terminal the hub bound to this socket and session " +
        "(terminalHandlers.ts tests entry.cliSocketId === socket.id).",
    },
    "terminal:error": { class: "exempt", reason: CLI_TERMINAL_REASON },
    "machine-alive": {
      class: "not-session-scoped",
      reason: "The daemon's machine liveness (machineHandlers.ts).",
    },
    "machine-update-metadata": {
      class: "not-session-scoped",
      reason: "The daemon's machine metadata (machineHandlers.ts).",
    },
    "machine-update-state": {
      class: "not-session-scoped",
      reason: "The daemon's machine state (machineHandlers.ts).",
    },
    ping: {
      class: "not-session-scoped",
      reason: "A liveness ack that writes nothing (cli/index.ts).",
    },
    disconnect: {
      class: "not-session-scoped",
      reason:
        "socket.io's own lifecycle event, not a report: it arms only its " +
        "own session's archive timer (cli/index.ts).",
    },
  },
  "federated-terminal": {
    "terminal:ready": { class: "exempt", reason: FEDERATED_TERMINAL_REASON },
    "terminal:output": { class: "exempt", reason: FEDERATED_TERMINAL_REASON },
    "terminal:exit": { class: "exempt", reason: FEDERATED_TERMINAL_REASON },
    "terminal:error": { class: "exempt", reason: FEDERATED_TERMINAL_REASON },
    disconnect: {
      class: "not-session-scoped",
      reason:
        "socket.io's own lifecycle event: it ends only the federated " +
        "terminals bound to this socket (federationTerminalNode.ts).",
    },
  },
};
