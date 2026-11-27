// SPDX-License-Identifier: AGPL-3.0-only
import type { DefaultEventsMap, Server, Socket } from "socket.io";

export type SocketData = {
  namespace?: string;
  userId?: number;
  /** Issue #6647: the handshake's session id (set while identity is not off). */
  sessionId?: string;
  /** Issue #6647: the runner key derived from the handshake's runner id. */
  runnerKey?: string;
  /** Issue #6647 (PR2): the identity layer cut this socket off. */
  evicted?: boolean;
  /**
   * #6559 (binding 3): the session this CLI socket declared at its handshake,
   * set only when that session resolved in the socket's namespace. The
   * context-reset events are accepted only for it.
   */
  cliSessionId?: string;
};

export type SocketServer = Server<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;
export type SocketWithData = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;
