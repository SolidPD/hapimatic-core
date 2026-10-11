// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import type { Terminal } from "@xterm/xterm";
import { useAppContext } from "@/lib/app-context";
import { useSession } from "@/hooks/queries/useSession";
import { useClaudePtySocket } from "@/hooks/useClaudePtySocket";
import { TerminalView } from "@/components/Terminal/TerminalView";
import { LoadingState } from "@/components/LoadingState";
import { BareButton } from "@/components/ui/BareButton";
import { ViewPicker } from "@/components/session/ViewPicker";
import { SessionOfflineBar } from "@/components/session/SessionOfflineBar";

const QUICK_INPUTS = [
  { label: "Esc", sequence: "", description: "Escape" },
  { label: "Tab", sequence: "\t", description: "Tab" },
  { label: "↑", sequence: "[A", description: "Up arrow" },
  { label: "↓", sequence: "[B", description: "Down arrow" },
  { label: "Ent", sequence: "\r", description: "Enter" },
];

export default function ClaudePtyPage() {
  const { sessionId } = useParams({
    from: "/sessions/$sessionId/claude-pty",
  });
  const { api, token } = useAppContext();
  const { session } = useSession(api, sessionId, true);
  const terminalRef = useRef<Terminal | null>(null);
  const inputDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const connectOnceRef = useRef(false);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [exited, setExited] = useState(false);

  const {
    state: ptyState,
    connect,
    write,
    resize,
    disconnect,
    onOutput,
  } = useClaudePtySocket({
    token,
    sessionId,
  });

  useEffect(() => {
    onOutput(data => {
      terminalRef.current?.write(data);
    });
  }, [onOutput]);

  const handleTerminalMount = useCallback(
    (terminal: Terminal) => {
      terminalRef.current = terminal;
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = terminal.onData(data => {
        write(data);
      });
    },
    [write]
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      lastSizeRef.current = { cols, rows };
      if (!session?.active) {
        return;
      }
      if (!connectOnceRef.current) {
        connectOnceRef.current = true;
        connect(cols, rows);
      } else {
        resize(cols, rows);
      }
    },
    [session?.active, connect, resize]
  );

  useEffect(() => {
    if (!session?.active) {
      return;
    }
    if (connectOnceRef.current) {
      return;
    }
    const size = lastSizeRef.current;
    if (!size) {
      return;
    }
    connectOnceRef.current = true;
    connect(size.cols, size.rows);
  }, [session?.active, connect]);

  useEffect(() => {
    connectOnceRef.current = false;
    setExited(false);
    disconnect();
  }, [sessionId, disconnect]);

  useEffect(() => {
    return () => {
      inputDisposableRef.current?.dispose();
      connectOnceRef.current = false;
      disconnect();
    };
  }, [disconnect]);

  useEffect(() => {
    if (session?.active === false) {
      disconnect();
      connectOnceRef.current = false;
      setExited(true);
    }
  }, [session?.active, disconnect]);

  useEffect(() => {
    if (ptyState.status === "error") {
      connectOnceRef.current = false;
    }
  }, [ptyState.status]);

  const quickInputDisabled =
    !session?.active || ptyState.status !== "connected";
  const handleQuickInput = useCallback(
    (sequence: string) => {
      if (quickInputDisabled) {
        return;
      }
      write(sequence);
      terminalRef.current?.focus();
    },
    [quickInputDisabled, write]
  );

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingState label="Loading session…" className="text-sm" />
      </div>
    );
  }

  const errorMessage = ptyState.status === "error" ? ptyState.error : null;

  return (
    <div className="flex h-full flex-col">
      {/* #3286 (D5(a)): claude-pty stays OUT of the tabs — the picker renders with
          no active tab (activeView={null}) on this secondary-affordance surface.
          Epic #3285 correction pass 1: the old Back / "PTY (Ink TUI)" / path
          header is gone — the tab row is the top of the view (Chat tab returns to
          the transcript). The connection dot that floated over the terminal's
          top-right is gone (2026-10-05, with the Terminal and Desktop views'):
          offline / error / exited each already render a banner above. */}
      <ViewPicker session={session} api={api} activeView={null} />

      {session.active ? null : (
        <SessionOfflineBar message="Session is offline. PTY is unavailable." />
      )}

      {errorMessage ? (
        <div className="mx-auto w-full max-w-content px-3 pt-3">
          <div className="rounded-md border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-3 text-xs text-[var(--app-badge-error-text)]">
            {errorMessage}
          </div>
        </div>
      ) : null}

      {exited ? (
        <div className="mx-auto w-full max-w-content px-3 pt-3">
          <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-xs text-[var(--app-hint)]">
            PTY exited.
          </div>
        </div>
      ) : null}

      <div className="relative flex-1 overflow-hidden bg-[var(--app-bg)]">
        <div className="mx-auto h-full w-full max-w-content p-3">
          <TerminalView
            onMount={handleTerminalMount}
            onResize={handleResize}
            convertEol={false}
            className="h-full w-full"
          />
        </div>
      </div>

      <div className="bg-[var(--app-bg)] border-t border-[var(--app-border)] pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto w-full max-w-content px-3">
          <div className="flex items-stretch overflow-hidden rounded-md bg-[var(--app-secondary-bg)]">
            {QUICK_INPUTS.map(input => (
              <BareButton
                key={input.label}
                type="button"
                onClick={() => handleQuickInput(input.sequence)}
                disabled={quickInputDisabled}
                className="flex-1 border-l border-[var(--app-border)] px-3 py-1.5 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent first:border-l-0"
                aria-label={input.description}
                title={input.description}
              >
                {input.label}
              </BareButton>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
