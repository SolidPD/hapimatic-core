// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

type TerminalConnectionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "connected" }
  // #4517: another tab or device took over this persistent shell. No auto-retry — the
  // user taps "Reattach here" to take it back.
  | { status: "detached"; reason: string }
  | { status: "error"; error: string };

type UseTerminalSocketOptions = {
  token: string;
  sessionId: string;
  terminalId: string;
  // #4517: opt-in persistence. The Terminal tab passes `true`; everything else
  // omits it and keeps today's ephemeral close-on-disconnect behaviour.
  persistent?: boolean;
};

type TerminalDetachedPayload = {
  terminalId: string;
  reason: string;
};

/** #4517: auto-re-attach backoff after a CLI disconnect (R10). */
const REATTACH_MAX_DELAY_MS = 10_000;

type TerminalReadyPayload = {
  terminalId: string;
  // #4517: true when the server confirmed a persistent shell, so a snapshot
  // follows. False for an older CLI or node, whose shell is ephemeral.
  persistent?: boolean;
};

type TerminalOutputPayload = {
  terminalId: string;
  data: string;
};

type TerminalExitPayload = {
  terminalId: string;
  code: number | null;
  signal: string | null;
};

type TerminalErrorPayload = {
  terminalId: string;
  message: string;
};

type ConnectOptions = {
  // #4517: "Start new shell" — ask for a new shell even though the previous
  // one exited (the CLI otherwise replays the exit on every open).
  fresh?: boolean;
};

export function useTerminalSocket(options: UseTerminalSocketOptions): {
  state: TerminalConnectionState;
  connect: (
    cols: number,
    rows: number,
    connectOptions?: ConnectOptions
  ) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  disconnect: () => void;
  reattach: () => void;
  onReady: (handler: (persistent: boolean) => void) => void;
  onOutput: (handler: (data: string) => void) => void;
  onExit: (
    handler: (code: number | null, signal: string | null) => void
  ) => void;
} {
  const [state, setState] = useState<TerminalConnectionState>({
    status: "idle",
  });
  const socketRef = useRef<Socket | null>(null);
  const readyHandlerRef = useRef<(persistent: boolean) => void>(() => {});
  const outputHandlerRef = useRef<(data: string) => void>(() => {});
  const exitHandlerRef = useRef<
    (code: number | null, signal: string | null) => void
  >(() => {});
  const sessionIdRef = useRef(options.sessionId);
  const terminalIdRef = useRef(options.terminalId);
  const tokenRef = useRef(options.token);
  const persistentRef = useRef(options.persistent === true);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // #4517: auto-re-attach timer + attempt counter (cli-disconnected backoff).
  const reattachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reattachAttemptRef = useRef(0);
  // #4517 (R9, D-4517-1 = A): set when another device took the shell over.
  // While set, no create goes out — not on a socket reconnect, not on a
  // connect() — so two devices never take the shell back and forth on their
  // own. reattach() ("Reattach here") clears it; so do a terminal:ready (the
  // server attached this socket after all) and a change of session, terminal
  // or persistence option.
  const detachedReasonRef = useRef<string | null>(null);
  // #4517: a "Start new shell" request not yet answered by terminal:ready.
  const freshRef = useRef(false);

  useEffect(() => {
    sessionIdRef.current = options.sessionId;
    terminalIdRef.current = options.terminalId;
    persistentRef.current = options.persistent === true;
    detachedReasonRef.current = null;
    freshRef.current = false;
  }, [options.sessionId, options.terminalId, options.persistent]);

  useEffect(() => {
    tokenRef.current = options.token;
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    if (!options.token) {
      if (socket.connected) {
        socket.disconnect();
      }
      return;
    }
    socket.auth = { token: options.token };
    if (socket.connected) {
      socket.disconnect();
      socket.connect();
    }
  }, [options.token]);

  const isCurrentTerminal = useCallback(
    (terminalId: string) => terminalId === terminalIdRef.current,
    []
  );

  // Every terminal:create goes through here, so this is where a device that
  // lost the shell to another device stays detached (see detachedReasonRef).
  const emitCreate = useCallback(
    (socket: Socket, size: { cols: number; rows: number }) => {
      const detachedReason = detachedReasonRef.current;
      if (detachedReason) {
        setState({ status: "detached", reason: detachedReason });
        return;
      }
      socket.emit("terminal:create", {
        sessionId: sessionIdRef.current,
        terminalId: terminalIdRef.current,
        cols: size.cols,
        rows: size.rows,
        persistent: persistentRef.current,
        ...(freshRef.current ? { fresh: true } : {}),
      });
    },
    []
  );

  const setErrorState = useCallback((message: string) => {
    setState({ status: "error", error: message });
  }, []);

  const clearReattachTimer = useCallback(() => {
    if (reattachTimerRef.current) {
      clearTimeout(reattachTimerRef.current);
      reattachTimerRef.current = null;
    }
    reattachAttemptRef.current = 0;
  }, []);

  // #4517 (R10): after a CLI disconnect, re-emit terminal:create with 1→2→4→8→
  // 10s-capped backoff while the browser socket stays connected, until a
  // terminal:ready confirms the re-attach (which clears the timer).
  const scheduleReattach = useCallback(() => {
    if (reattachTimerRef.current) {
      clearTimeout(reattachTimerRef.current);
    }
    const attempt = reattachAttemptRef.current;
    const delay = Math.min(1000 * 2 ** attempt, REATTACH_MAX_DELAY_MS);
    reattachAttemptRef.current = attempt + 1;
    reattachTimerRef.current = setTimeout(() => {
      reattachTimerRef.current = null;
      const socket = socketRef.current;
      const size = lastSizeRef.current;
      if (!socket || !socket.connected || !size) {
        return;
      }
      emitCreate(socket, size);
      // Schedule the next attempt; a successful terminal:ready clears it.
      scheduleReattach();
    }, delay);
  }, [emitCreate]);

  const connect = useCallback(
    (cols: number, rows: number, connectOptions?: ConnectOptions) => {
      lastSizeRef.current = { cols, rows };
      const token = tokenRef.current;
      const sessionId = sessionIdRef.current;
      const terminalId = terminalIdRef.current;

      if (!token || !sessionId || !terminalId) {
        setErrorState("Missing terminal credentials.");
        return;
      }

      if (connectOptions?.fresh) {
        freshRef.current = true;
      }

      if (socketRef.current) {
        const socket = socketRef.current;
        socket.auth = { token };
        setState({ status: "connecting" });
        if (socket.connected) {
          emitCreate(socket, { cols, rows });
        } else {
          socket.connect();
        }
        return;
      }

      const socket = io("/terminal", {
        auth: { token },
        path: "/socket.io/",
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        transports: ["polling", "websocket"],
        autoConnect: false,
      });

      socketRef.current = socket;
      setState({ status: "connecting" });

      socket.on("connect", () => {
        const size = lastSizeRef.current ?? { cols, rows };
        setState({ status: "connecting" });
        emitCreate(socket, size);
      });

      socket.on("terminal:ready", (payload: TerminalReadyPayload) => {
        if (!isCurrentTerminal(payload.terminalId)) {
          return;
        }
        // A successful (re-)attach cancels any pending auto-re-attach backoff,
        // and the server has acted on any "Start new shell" request.
        clearReattachTimer();
        detachedReasonRef.current = null;
        freshRef.current = false;
        // #4517 (R4): reset-on-ready MUST run before any output is written so a
        // snapshot never stacks on stale content — fire the handler FIRST, then
        // flip to connected.
        readyHandlerRef.current(payload.persistent === true);
        setState({ status: "connected" });
      });

      socket.on("terminal:output", (payload: TerminalOutputPayload) => {
        if (!isCurrentTerminal(payload.terminalId)) {
          return;
        }
        outputHandlerRef.current(payload.data);
      });

      socket.on("terminal:exit", (payload: TerminalExitPayload) => {
        if (!isCurrentTerminal(payload.terminalId)) {
          return;
        }
        exitHandlerRef.current(payload.code, payload.signal);
        setErrorState("Terminal exited.");
      });

      socket.on("terminal:error", (payload: TerminalErrorPayload) => {
        if (!isCurrentTerminal(payload.terminalId)) {
          return;
        }
        clearReattachTimer();
        setErrorState(payload.message);
      });

      socket.on("terminal:detached", (payload: TerminalDetachedPayload) => {
        if (!isCurrentTerminal(payload.terminalId)) {
          return;
        }
        if (payload.reason === "cli-disconnected") {
          // The shell survives on the node; auto-re-attach with backoff (R10).
          // While the CLI is still away, the server answers each retry with
          // another cli-disconnected notice. The retry timer has already
          // scheduled the next attempt by then, so only start the loop when
          // none is pending — otherwise the backoff would advance twice a cycle.
          setState({ status: "connecting" });
          if (!reattachTimerRef.current) {
            scheduleReattach();
          }
        } else {
          // attached-elsewhere: one owner at a time. Stop and show "Reattach
          // here" — never auto-retry, so two devices don't ping-pong (R9).
          clearReattachTimer();
          detachedReasonRef.current = payload.reason;
          setState({ status: "detached", reason: payload.reason });
        }
      });

      socket.on("connect_error", error => {
        const message =
          error instanceof Error ? error.message : "Connection error";
        setErrorState(message);
      });

      socket.on("disconnect", reason => {
        if (reason === "io client disconnect") {
          setState({ status: "idle" });
          return;
        }
        setErrorState(`Disconnected: ${reason}`);
      });

      socket.connect();
    },
    [
      emitCreate,
      setErrorState,
      isCurrentTerminal,
      clearReattachTimer,
      scheduleReattach,
    ]
  );

  const write = useCallback((data: string) => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      return;
    }
    socket.emit("terminal:write", { terminalId: terminalIdRef.current, data });
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    lastSizeRef.current = { cols, rows };
    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      return;
    }
    socket.emit("terminal:resize", {
      terminalId: terminalIdRef.current,
      cols,
      rows,
    });
  }, []);

  const disconnect = useCallback(() => {
    clearReattachTimer();
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    socket.removeAllListeners();
    socket.disconnect();
    socketRef.current = null;
    setState({ status: "idle" });
  }, [clearReattachTimer]);

  // #4517 (R9): the "Reattach here" control — the user's explicit request to
  // take the shell back. Re-emit terminal:create once with the last known size.
  const reattach = useCallback(() => {
    const socket = socketRef.current;
    const size = lastSizeRef.current;
    if (!socket || !socket.connected || !size) {
      return;
    }
    clearReattachTimer();
    detachedReasonRef.current = null;
    setState({ status: "connecting" });
    emitCreate(socket, size);
  }, [clearReattachTimer, emitCreate]);

  const onReady = useCallback((handler: (persistent: boolean) => void) => {
    readyHandlerRef.current = handler;
  }, []);

  const onOutput = useCallback((handler: (data: string) => void) => {
    outputHandlerRef.current = handler;
  }, []);

  const onExit = useCallback(
    (handler: (code: number | null, signal: string | null) => void) => {
      exitHandlerRef.current = handler;
    },
    []
  );

  return {
    state,
    connect,
    write,
    resize,
    disconnect,
    reattach,
    onReady,
    onOutput,
    onExit,
  };
}
