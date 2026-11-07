// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { DESKTOP_CLOSE_START_FAILED } from "@hapi/protocol";
import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/ui/StatePanel";

export type DesktopStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

const STARTING_TEXT = "Starting the desktop…";
const START_FAILED_TEXT = "The desktop could not start";
const CONNECTION_CLOSED_TEXT = "The desktop connection closed";
const AUTH_FAILED_TEXT = "Desktop authentication failed";
const DISCONNECTED_TEXT = "Desktop disconnected";

/**
 * Mounts the noVNC RFB client against the per-VM desktop proxy
 * (`/api/sessions/:id/desktop`, issue #2693). The JWT rides the
 * `hapi-desktop-auth.<token>` WebSocket subprotocol; the server verifies it
 * before the upgrade and echoes back the non-token `hapi-desktop-v1` protocol.
 * The socket is same-origin, so it inherits the VM's Caddy 443 → localhost:3008.
 *
 * The first open starts the desktop on demand, so the viewer shows "Starting the
 * desktop…" while the server waits for it, retries once on an early failure, and
 * reads the server's close code to tell a failed start apart (#6214).
 */
export function DesktopView(props: {
  sessionId: string;
  token: string;
  onStatusChange?: (status: DesktopStatus) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onStatusRef = useRef(props.onStatusChange);
  onStatusRef.current = props.onStatusChange;
  // Read when a connection opens, not an effect dependency: the server checks the
  // token only at the upgrade, and a JWT refresh (~every 14 min) must not tear
  // down a live desktop (#6214).
  const tokenRef = useRef(props.token);
  tokenRef.current = props.token;
  // One automatic retry per user-started connection (mount or Try again).
  const autoRetried = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<DesktopStatus>("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { sessionId } = props;

  useEffect(() => {
    autoRetried.current = false;
  }, [sessionId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${wsProto}//${window.location.host}/api/sessions/${encodeURIComponent(
      sessionId
    )}/desktop`;

    let socket: WebSocket | null = null;
    let rfb: RFB | null = null;
    let disposed = false;
    // noVNC has already disconnected; calling disconnect() again only logs an error.
    let rfbDone = false;
    let connected = false;
    let securityFailed = false;
    let lastCloseCode: number | null = null;
    const setBoth = (s: DesktopStatus) => {
      if (disposed) return;
      setStatus(s);
      onStatusRef.current?.(s);
    };

    setStatus("connecting");
    setErrorMsg(null);
    onStatusRef.current?.("connecting");

    try {
      socket = new WebSocket(url, [
        "hapi-desktop-v1",
        `hapi-desktop-auth.${tokenRef.current}`,
      ]);
      // Registered BEFORE `new RFB`: noVNC attaches through the socket's `onclose`
      // property inside its constructor, and listeners run in registration order,
      // so the server's close code is recorded before noVNC dispatches
      // `disconnect` (noVNC itself never reports the code).
      socket.addEventListener("close", (e: CloseEvent) => {
        lastCloseCode = e.code;
      });
      rfb = new RFB(el, socket);
      rfb.scaleViewport = true; // fit the remote framebuffer to the container
      rfb.addEventListener("connect", () => {
        connected = true;
        if (!disposed) setErrorMsg(null);
        setBoth("connected");
      });
      rfb.addEventListener("disconnect", (e: Event) => {
        rfbDone = true;
        if (disposed) return;
        const clean =
          (e as CustomEvent<{ clean?: boolean }>).detail?.clean ?? false;
        if (securityFailed) {
          setErrorMsg(AUTH_FAILED_TEXT);
          setBoth("error");
          return;
        }
        // An early failure that is not a server-reported start failure gets one
        // automatic retry, still showing the starting state.
        if (
          !clean &&
          !connected &&
          lastCloseCode !== DESKTOP_CLOSE_START_FAILED &&
          !autoRetried.current
        ) {
          autoRetried.current = true;
          setAttempt(a => a + 1);
          return;
        }
        if (clean) {
          setErrorMsg(null);
          setBoth("disconnected");
          return;
        }
        setErrorMsg(
          lastCloseCode === DESKTOP_CLOSE_START_FAILED
            ? START_FAILED_TEXT
            : CONNECTION_CLOSED_TEXT
        );
        setBoth("error");
      });
      rfb.addEventListener("securityfailure", () => {
        securityFailed = true;
        if (!disposed) setErrorMsg(AUTH_FAILED_TEXT);
        setBoth("error");
      });
    } catch (err) {
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      if (!disposed) {
        setErrorMsg(`Could not initialize the desktop viewer: ${String(err)}`);
      }
      setBoth("error");
    }

    return () => {
      disposed = true;
      if (rfb) {
        if (!rfbDone) {
          try {
            rfb.disconnect();
          } catch {
            /* already disconnected */
          }
        }
      } else {
        try {
          socket?.close();
        } catch {
          /* already closed */
        }
      }
    };
  }, [sessionId, attempt]);

  const tryAgain = () => {
    autoRetried.current = false;
    setAttempt(a => a + 1);
  };

  return (
    <div className={`relative h-full w-full ${props.className ?? ""}`}>
      {/* noVNC renders its <canvas> into this element. */}
      <div ref={containerRef} className="h-full w-full" />
      {status !== "connected" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {status === "connecting" ? (
            <StatePanel variant="loading" title={STARTING_TEXT} />
          ) : (
            <StatePanel
              variant={status === "error" ? "error" : "empty"}
              title={errorMsg ?? DISCONNECTED_TEXT}
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="pointer-events-auto"
                  onClick={tryAgain}
                >
                  Try again
                </Button>
              }
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
