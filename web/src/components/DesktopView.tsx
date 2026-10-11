// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";

export type DesktopStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/**
 * Mounts the noVNC RFB client against the per-VM desktop proxy
 * (`/api/sessions/:id/desktop`, issue #2693). The JWT rides the
 * `hapi-desktop-auth.<token>` WebSocket subprotocol; the server verifies it
 * before the upgrade and echoes back the non-token `hapi-desktop-v1` protocol.
 * The socket is same-origin, so it inherits the VM's Caddy 443 → localhost:3008.
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
  const [status, setStatus] = useState<DesktopStatus>("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { sessionId, token } = props;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${wsProto}//${window.location.host}/api/sessions/${encodeURIComponent(
      sessionId
    )}/desktop`;

    let rfb: RFB | null = null;
    let disposed = false;
    const setBoth = (s: DesktopStatus) => {
      if (disposed) return;
      setStatus(s);
      onStatusRef.current?.(s);
    };

    setStatus("connecting");
    setErrorMsg(null);
    onStatusRef.current?.("connecting");

    try {
      rfb = new RFB(el, url, {
        wsProtocols: ["hapi-desktop-v1", `hapi-desktop-auth.${token}`],
      });
      rfb.scaleViewport = true; // fit the remote framebuffer to the container
      rfb.addEventListener("connect", () => setBoth("connected"));
      rfb.addEventListener("disconnect", (e: Event) => {
        const clean =
          (e as CustomEvent<{ clean?: boolean }>).detail?.clean ?? false;
        if (!clean && !disposed) {
          setErrorMsg(
            "Desktop connection closed. Web desktop mode requires a Pro-and-up cloud VM; on an eligible VM it starts on demand — try reconnecting."
          );
        }
        setBoth(clean ? "disconnected" : "error");
      });
      rfb.addEventListener("securityfailure", () => {
        if (!disposed) setErrorMsg("Desktop authentication failed.");
        setBoth("error");
      });
    } catch (err) {
      if (!disposed) {
        setErrorMsg(`Could not initialize the desktop viewer: ${String(err)}`);
      }
      setBoth("error");
    }

    return () => {
      disposed = true;
      try {
        rfb?.disconnect();
      } catch {
        /* already disconnected */
      }
    };
  }, [sessionId, token]);

  return (
    <div className={`relative h-full w-full ${props.className ?? ""}`}>
      {/* noVNC renders its <canvas> into this element. */}
      <div ref={containerRef} className="h-full w-full" />
      {status !== "connected" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-[var(--app-hint)]">
          <span className="max-w-content">
            {status === "connecting"
              ? "Connecting to the desktop…"
              : (errorMsg ?? "Desktop disconnected.")}
          </span>
        </div>
      ) : null}
    </div>
  );
}
