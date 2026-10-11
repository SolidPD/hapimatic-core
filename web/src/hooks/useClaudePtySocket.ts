// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

type ClaudePtyConnectionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "connected" }
  | { status: "error"; error: string };

type UseClaudePtySocketOptions = {
  token: string;
  sessionId: string;
};

type ClaudePtyReadyPayload = {
  sessionId: string;
};

type ClaudePtyOutputPayload = {
  sessionId: string;
  data: string;
};

type ClaudePtyErrorPayload = {
  sessionId: string;
  message: string;
};

type ClaudePtyDisconnectedPayload = {
  sessionId: string;
};

const RESIZE_DEBOUNCE_MS = 250;

export function useClaudePtySocket(options: UseClaudePtySocketOptions): {
  state: ClaudePtyConnectionState;
  connect: (cols: number, rows: number) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  disconnect: () => void;
  onOutput: (handler: (data: string) => void) => void;
} {
  const [state, setState] = useState<ClaudePtyConnectionState>({
    status: "idle",
  });
  const socketRef = useRef<Socket | null>(null);
  const outputHandlerRef = useRef<(data: string) => void>(() => {});
  const sessionIdRef = useRef(options.sessionId);
  const tokenRef = useRef(options.token);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);

  useEffect(() => {
    sessionIdRef.current = options.sessionId;
  }, [options.sessionId]);

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

  const isCurrentSession = useCallback(
    (sessionId: string) => sessionId === sessionIdRef.current,
    []
  );

  const emitSubscribe = useCallback(
    (socket: Socket, size: { cols: number; rows: number }) => {
      socket.emit("claude:pty-subscribe", {
        sessionId: sessionIdRef.current,
      });
      socket.emit("claude:pty-resize", {
        sessionId: sessionIdRef.current,
        cols: size.cols,
        rows: size.rows,
      });
    },
    []
  );

  const setErrorState = useCallback((message: string) => {
    setState({ status: "error", error: message });
  }, []);

  const connect = useCallback(
    (cols: number, rows: number) => {
      lastSizeRef.current = { cols, rows };
      const token = tokenRef.current;
      const sessionId = sessionIdRef.current;

      if (!token || !sessionId) {
        setErrorState("Missing PTY credentials.");
        return;
      }

      if (socketRef.current) {
        const socket = socketRef.current;
        socket.auth = { token };
        if (socket.connected) {
          emitSubscribe(socket, { cols, rows });
        } else {
          socket.connect();
        }
        setState({ status: "connecting" });
        return;
      }

      const socket = io("/claude-pty", {
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
        emitSubscribe(socket, size);
      });

      socket.on("claude:pty-ready", (payload: ClaudePtyReadyPayload) => {
        if (!isCurrentSession(payload.sessionId)) {
          return;
        }
        setState({ status: "connected" });
      });

      socket.on("claude:pty-output", (payload: ClaudePtyOutputPayload) => {
        if (!isCurrentSession(payload.sessionId)) {
          return;
        }
        outputHandlerRef.current(payload.data);
      });

      socket.on("claude:pty-error", (payload: ClaudePtyErrorPayload) => {
        if (!isCurrentSession(payload.sessionId)) {
          return;
        }
        setErrorState(payload.message);
      });

      socket.on(
        "claude:pty-cli-disconnected",
        (payload: ClaudePtyDisconnectedPayload) => {
          if (!isCurrentSession(payload.sessionId)) {
            return;
          }
          setErrorState("CLI disconnected.");
        }
      );

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
    [emitSubscribe, setErrorState, isCurrentSession]
  );

  const write = useCallback((data: string) => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      return;
    }
    socket.emit("claude:pty-write", {
      sessionId: sessionIdRef.current,
      data,
    });
  }, []);

  const flushResize = useCallback(() => {
    resizeDebounceRef.current = null;
    const pending = pendingResizeRef.current;
    pendingResizeRef.current = null;
    const socket = socketRef.current;
    if (!socket || !socket.connected || !pending) {
      return;
    }
    socket.emit("claude:pty-resize", {
      sessionId: sessionIdRef.current,
      cols: pending.cols,
      rows: pending.rows,
    });
  }, []);

  const resize = useCallback(
    (cols: number, rows: number) => {
      lastSizeRef.current = { cols, rows };
      pendingResizeRef.current = { cols, rows };
      if (resizeDebounceRef.current) {
        clearTimeout(resizeDebounceRef.current);
      }
      resizeDebounceRef.current = setTimeout(flushResize, RESIZE_DEBOUNCE_MS);
    },
    [flushResize]
  );

  const disconnect = useCallback(() => {
    if (resizeDebounceRef.current) {
      clearTimeout(resizeDebounceRef.current);
      resizeDebounceRef.current = null;
    }
    pendingResizeRef.current = null;
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    socket.emit("claude:pty-unsubscribe", {
      sessionId: sessionIdRef.current,
    });
    socket.removeAllListeners();
    socket.disconnect();
    socketRef.current = null;
    setState({ status: "idle" });
  }, []);

  useEffect(() => {
    return () => {
      if (resizeDebounceRef.current) {
        clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }
      pendingResizeRef.current = null;
    };
  }, []);

  const onOutput = useCallback((handler: (data: string) => void) => {
    outputHandlerRef.current = handler;
  }, []);

  return {
    state,
    connect,
    write,
    resize,
    disconnect,
    onOutput,
  };
}
