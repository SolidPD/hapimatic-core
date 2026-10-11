// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import type { Terminal } from "@xterm/xterm";
import { useAppContext } from "@/lib/app-context";
import { useSession } from "@/hooks/queries/useSession";
import { useTerminalSocket } from "@/hooks/useTerminalSocket";
import { useKeyboardVisible } from "@/hooks/useKeyboardVisible";
import { TerminalView } from "@/components/Terminal/TerminalView";
import { TerminalKeyBar } from "@/components/Terminal/TerminalKeyBar";
import { TerminalComposeLine } from "@/components/Terminal/TerminalComposeLine";
import { TerminalSelectionMenu } from "@/components/Terminal/TerminalSelectionMenu";
import { useTerminalTouchSelection } from "@/components/Terminal/useTerminalTouchSelection";
import { useStickyModifiers } from "@/components/Terminal/useStickyModifiers";
import {
  applyModifiers,
  STICKY_EXEMPT_IDS,
  keySequence,
  type KeyId,
} from "@/components/Terminal/terminalKeys";
import { usePlatform } from "@/hooks/usePlatform";
import { useAdminPreferences } from "@/hooks/useAdminPreferences";
import { useTerminalDockExpanded } from "@/hooks/useTerminalDockExpanded";
import { safeCopyToClipboard } from "@/lib/clipboard";
import { useToast } from "@/components/Toast";
import { BareButton } from "@/components/ui/BareButton";
import { LoadingState } from "@/components/LoadingState";
import { ViewPicker } from "@/components/session/ViewPicker";
import { SessionOfflineBar } from "@/components/session/SessionOfflineBar";

export default function TerminalPage() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId/terminal" });
  const { api, token } = useAppContext();
  const { session } = useSession(api, sessionId, true); // Active session polling
  // #4517 (R1): ONE stable id per session — never a fresh UUID per mount — so
  // every tab, reload and device for this session addresses the same shell.
  const terminalId = useMemo(() => `${sessionId}:shell`, [sessionId]);
  const terminalRef = useRef<Terminal | null>(null);
  const inputDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const connectOnceRef = useRef(false);
  // #4517 (R10): a shell exit is final until the user taps "Start new shell".
  // The exit banner itself shrinks the view, so without this guard the next
  // FitAddon resize would silently connect a fresh shell, and reset-on-ready
  // would wipe the exited shell's output along with the banner.
  const exitedRef = useRef(false);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [exitInfo, setExitInfo] = useState<{
    code: number | null;
    signal: string | null;
  } | null>(null);

  // #4516 input-dock state.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const composeInputRef = useRef<HTMLTextAreaElement | null>(null);
  // True only while a programmatic paste() is in flight, so the onData handler
  // never treats the paste's single-char payload as a modifier target (F1 proved
  // paste() fires onData synchronously, so this flag is set and cleared around it).
  const pastingRef = useRef(false);
  const sticky = useStickyModifiers();
  const keyboardVisible = useKeyboardVisible();
  const { showToast } = useToast();
  // R14 (#3790 touch-only gate, carried into #4516): the whole input dock
  // renders only on a coarse-pointer (touch) device — a desktop keyboard user
  // has no need for an on-screen key bar/compose line. `isTouch` is memoized at
  // mount from `(pointer: coarse)`.
  const { isTouch } = usePlatform();
  // #4550: the compose-line Send/Enter choice (R2-2 default OFF). Per-device,
  // read live so a Preferences-page toggle (or another tab) reaches the open
  // Terminal without a reload (R4).
  const { prefs } = useAdminPreferences();
  // R2-3: collapsible dock; expanded by default. #4548: the collapse state is now
  // the federation-global key `terminalKeyboardExpanded` — #4516's per-node cache
  // is the first-paint fallback, and a toggle broadcasts to peers. Touch only
  // (`enabled: isTouch`): a desktop session keeps the pure-local behavior and
  // issues no federation GET/PUT.
  const { expanded: keyboardExpanded, setExpanded: setKeyboardExpanded } =
    useTerminalDockExpanded(api, { enabled: isTouch });
  const toggleKeyboard = useCallback(() => {
    setKeyboardExpanded(!keyboardExpanded);
  }, [setKeyboardExpanded, keyboardExpanded]);
  // A sticky Ctrl/Alt must not outlive the key bar that shows it: with the bar
  // collapsed (or absent), a locked Ctrl would silently turn typed letters into
  // control bytes (e.g. `s` → Ctrl-S, which freezes terminal output).
  const { reset: resetSticky } = sticky;
  useEffect(() => {
    if (!isTouch || !keyboardExpanded) resetSticky();
  }, [isTouch, keyboardExpanded, resetSticky]);

  const {
    state: terminalState,
    connect,
    write,
    resize,
    disconnect,
    reattach,
    onReady,
    onOutput,
    onExit,
  } = useTerminalSocket({
    token,
    sessionId,
    terminalId,
    persistent: true,
  });

  useEffect(() => {
    onOutput(data => {
      terminalRef.current?.write(data);
    });
  }, [onOutput]);

  useEffect(() => {
    onExit((code, signal) => {
      exitedRef.current = true;
      setExitInfo({ code, signal });
      terminalRef.current?.write(
        `\r\n[process exited${code !== null ? ` with code ${code}` : ""}]`
      );
      connectOnceRef.current = false;
    });
  }, [onExit]);

  const handleTerminalMount = useCallback(
    (terminal: Terminal) => {
      terminalRef.current = terminal;
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = terminal.onData(data => {
        // A single typed character with an armed/locked sticky modifier is
        // rewritten through applyModifiers; everything else (paste, IME commit,
        // xterm DA/DSR replies) passes through untouched (R3). The snapshot ref
        // is read live, so this closure never re-subscribes.
        const snap = sticky.snapshotRef.current;
        if (
          !pastingRef.current &&
          data.length === 1 &&
          (snap.ctrl !== "off" || snap.alt !== "off")
        ) {
          write(applyModifiers(data, sticky.consume()));
          return;
        }
        write(data);
      });
    },
    [write, sticky]
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      lastSizeRef.current = { cols, rows };
      if (!session?.active || exitedRef.current) {
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
    if (connectOnceRef.current || exitedRef.current) {
      return;
    }
    const size = lastSizeRef.current;
    if (!size) {
      return;
    }
    connectOnceRef.current = true;
    connect(size.cols, size.rows);
  }, [session?.active, connect]);

  // #4517: the CLI keeps an exited shell's final screen and replays the exit
  // on every open, so a new shell needs an explicit `fresh` request.
  const handleStartNewShell = useCallback(() => {
    const size = lastSizeRef.current;
    if (!size) {
      return;
    }
    exitedRef.current = false;
    setExitInfo(null);
    connectOnceRef.current = true;
    connect(size.cols, size.rows, { fresh: true });
  }, [connect]);

  useEffect(() => {
    connectOnceRef.current = false;
    exitedRef.current = false;
    setExitInfo(null);
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
    }
  }, [session?.active, disconnect]);

  useEffect(() => {
    if (terminalState.status === "error") {
      connectOnceRef.current = false;
      return;
    }
    if (
      terminalState.status === "connecting" ||
      terminalState.status === "connected"
    ) {
      setExitInfo(null);
    }
  }, [terminalState.status]);

  // Single disabled signal for every input control (renamed from
  // quickInputDisabled). #4517 adds a "detached" status; this negative predicate
  // already disables controls in that state, so it needs no change.
  const inputDisabled =
    !session?.active || terminalState.status !== "connected";

  // The live connection state for callbacks that resume after an await (the
  // Paste key waits on the iOS Paste callout, during which the socket can drop).
  const inputDisabledRef = useRef(inputDisabled);
  useEffect(() => {
    inputDisabledRef.current = inputDisabled;
  }, [inputDisabled]);

  // Paste one text blob through xterm's paste path (R6). F1 proved paste() fires
  // onData synchronously, so the existing onData→write wiring sends exactly one
  // terminal:write, bracketed iff the shell enabled DEC 2004. Refuses while
  // disconnected (read live, not from the render that made this callback) so a
  // reconnecting socket never swallows text; callers report the refusal.
  const pasteText = useCallback((text: string): boolean => {
    const terminal = terminalRef.current;
    if (inputDisabledRef.current || !terminal) return false;
    try {
      pastingRef.current = true;
      terminal.paste(text);
    } finally {
      pastingRef.current = false;
    }
    return true;
  }, []);

  // Paste key (R6/R7): prefer the async clipboard read in a secure context (on
  // iOS this shows the system Paste callout); on undefined/rejection fall back to
  // focusing the compose field with a one-line hint — never fail silently. The
  // connection can drop while the iOS callout is up, so a refused paste says so.
  const handlePasteKey = useCallback(async () => {
    if (window.isSecureContext && navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (!pasteText(text)) {
          showToast("Terminal not connected — nothing was pasted", {
            type: "error",
          });
        }
        return;
      } catch {
        // fall through to the compose-field fallback
      }
    }
    composeInputRef.current?.focus();
    showToast(
      "Clipboard unavailable here — long-press the field and choose Paste",
      {
        type: "info",
      }
    );
  }, [pasteText, showToast]);

  const selection = useTerminalTouchSelection({
    terminalRef,
    containerRef,
    enabled: !!session,
  });

  // #4517 (R4): reset xterm on every persistent ready so a re-attach snapshot
  // never stacks on stale content (fresh mount, reconnect, or another
  // device). A ready that does not confirm persistence (an older CLI or
  // node) brings no snapshot, so the screen is kept.
  // #4516 (T4): a reset also wipes xterm's selection, so the same branch first
  // closes any open long-press menu and drag handles through dismiss() — the
  // single entry point that clears all three. Registered here, after
  // useTerminalTouchSelection, because the handler reads the selection API
  // (registering it next to onOutput would use `selection` before it is
  // declared — TS2448).
  const { dismiss: dismissSelection } = selection;
  useEffect(() => {
    onReady(persistent => {
      if (persistent) {
        dismissSelection();
        terminalRef.current?.reset();
      }
    });
  }, [onReady, dismissSelection]);

  // Copy key (R10): copy the current selection from any source via
  // safeCopyToClipboard, then close the menu as the menu's own Copy does; with
  // no selection, select all and open the menu. The key carries `data-selkeep`
  // so pressing it does not dismiss (and clear) the selection before release.
  const handleCopyKey = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (terminal.hasSelection()) {
      void safeCopyToClipboard(terminal.getSelection());
      showToast("Copied", { type: "success" });
      selection.dismiss();
    } else {
      terminal.selectAll();
      selection.openAtSelection();
    }
  }, [showToast, selection]);

  // Bar key (R2): emit the xterm byte sequence, honouring application-cursor
  // mode. The fixed-sequence keys in STICKY_EXEMPT_IDS (the ^X one-tap
  // shortcuts, ⌥., Ins and Del) emit their fixed bytes and do NOT consume the
  // sticky modifiers; every other key consumes them.
  const handleBarKey = useCallback(
    (id: KeyId) => {
      const terminal = terminalRef.current;
      if (inputDisabled) return;
      const appCursor = terminal?.modes.applicationCursorKeysMode ?? false;
      if (STICKY_EXEMPT_IDS.has(id)) {
        write(keySequence(id, { ctrl: false, alt: false }, appCursor));
        return;
      }
      write(keySequence(id, sticky.consume(), appCursor));
    },
    [inputDisabled, write, sticky]
  );

  // Compose send (R6/R8, R2-2): deliver the text through the paste path. Default
  // is NOT to press Enter — the text lands on the prompt unexecuted so it can be
  // edited before it runs. The Send/Enter choice comes from ONE page-level
  // expression (`enterAfterSend`), now the persisted Preferences value (#4550,
  // default OFF per R2-2). The compose line never decides or stores the flag
  // (contract K-4550-1 / T2). Focus the terminal so the user's next Return runs
  // it. Returns true (clearing the field) only on a real send.
  const enterAfterSend = prefs.terminalComposeEnterAfterSend;
  const handleSend = useCallback(
    (text: string): boolean => {
      if (inputDisabled || text.length === 0) return false;
      if (!pasteText(text)) return false;
      if (enterAfterSend) write("\r");
      terminalRef.current?.focus();
      return true;
    },
    [inputDisabled, pasteText, enterAfterSend, write]
  );

  // ⏎ key beside Send (T11; operator ruling 2026-10-03, placement V1): press
  // Enter in the terminal — the same CR byte xterm sends for Return. It never
  // reads or clears the compose text (Send owns the text) and, like the bar's
  // fixed-sequence keys, never consumes the sticky modifiers.
  const handleEnterKey = useCallback(() => {
    if (inputDisabled) return;
    write("\r");
  }, [inputDisabled, write]);

  const handleMenuCopy = useCallback(() => {
    const terminal = terminalRef.current;
    if (terminal?.hasSelection()) {
      void safeCopyToClipboard(terminal.getSelection());
      showToast("Copied", { type: "success" });
    }
    selection.dismiss();
  }, [showToast, selection]);

  const handleMenuSelectAll = useCallback(() => {
    terminalRef.current?.selectAll();
    selection.openAtSelection();
  }, [selection]);

  const handleMenuPaste = useCallback(() => {
    void handlePasteKey();
    selection.dismiss();
  }, [handlePasteKey, selection]);

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingState label="Loading session…" className="text-sm" />
      </div>
    );
  }

  const errorMessage =
    terminalState.status === "error" ? terminalState.error : null;
  const isDetached = terminalState.status === "detached";

  return (
    <div className="flex h-full flex-col">
      {/* #3286 (View Picker) + epic #3285 correction pass 1: the tab row IS the top
          of this view — the old Back / "Terminal" / path header is gone (the Chat
          tab returns to the transcript). The connection dot that used to float
          over the terminal's top-right corner is gone (2026-10-05): every
          non-connected state it encoded — offline, error, detached, exited —
          already renders its own banner below, so the dot only duplicated
          them. */}
      <ViewPicker session={session} api={api} activeView="terminal" />

      {session.active ? null : (
        <SessionOfflineBar message="Session is offline. Terminal is unavailable." />
      )}

      {errorMessage ? (
        <div className="mx-auto w-full max-w-content px-3 pt-3">
          <div className="rounded-md border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-3 text-xs text-[var(--app-badge-error-text)]">
            {errorMessage}
          </div>
        </div>
      ) : null}

      {isDetached ? (
        <div className="mx-auto w-full max-w-content px-3 pt-3">
          <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-xs text-[var(--app-hint)]">
            <span>This terminal is open on another device.</span>
            <BareButton
              type="button"
              onClick={reattach}
              className="shrink-0 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset"
            >
              Reattach here
            </BareButton>
          </div>
        </div>
      ) : null}

      {exitInfo ? (
        <div className="mx-auto w-full max-w-content px-3 pt-3">
          <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-xs text-[var(--app-hint)]">
            <span>
              Terminal exited
              {exitInfo.code !== null ? ` with code ${exitInfo.code}` : ""}
              {exitInfo.signal ? ` (${exitInfo.signal})` : ""}.
            </span>
            {session.active ? (
              <BareButton
                type="button"
                onClick={handleStartNewShell}
                className="shrink-0 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset"
              >
                Start new shell
              </BareButton>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="relative flex-1 overflow-hidden bg-[var(--app-bg)]">
        <div
          ref={containerRef}
          className="relative mx-auto h-full w-full max-w-content p-3"
        >
          <TerminalView
            onMount={handleTerminalMount}
            onResize={handleResize}
            className="h-full w-full"
          />
          {selection.handles ? (
            <>
              <span
                data-selhandle="start"
                aria-hidden="true"
                className="absolute z-20 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-[var(--app-bg)] bg-[var(--app-button)] shadow"
                style={{
                  left: `${selection.handles.start.x}px`,
                  top: `${selection.handles.start.y}px`,
                }}
              />
              <span
                data-selhandle="end"
                aria-hidden="true"
                className="absolute z-20 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-[var(--app-bg)] bg-[var(--app-button)] shadow"
                style={{
                  left: `${selection.handles.end.x}px`,
                  top: `${selection.handles.end.y}px`,
                }}
              />
            </>
          ) : null}
          {selection.menu ? (
            <TerminalSelectionMenu
              x={selection.menu.x}
              y={selection.menu.y}
              onCopy={handleMenuCopy}
              onSelectAll={handleMenuSelectAll}
              onPaste={handleMenuPaste}
              onDismiss={selection.dismiss}
              pasteDisabled={inputDisabled}
            />
          ) : null}
        </div>
      </div>

      {/* #4516 input dock (R2-3: collapsible). The "Keys" handle toggles the
          compose line + key bar; the collapsed state reclaims terminal space.
          Expanded by default (first visit), state persisted per node. While the
          iOS keyboard is open the safe-area inset is dropped (R11). R14: the
          whole dock renders on touch devices only. The selection menu + drag
          handles live in the terminal container above, outside this gate: they
          appear only after a touch selection, because the selection hook acts
          on touch/pen pointers alone (Task 7). */}
      {isTouch ? (
        <div
          className="border-t border-[var(--app-border)] bg-[var(--app-bg)]"
          style={{
            paddingBottom: keyboardVisible ? 0 : "env(safe-area-inset-bottom)",
          }}
        >
          <BareButton
            type="button"
            onClick={toggleKeyboard}
            aria-label={
              keyboardExpanded ? "Collapse keyboard" : "Expand keyboard"
            }
            aria-expanded={keyboardExpanded}
            className="flex w-full touch-manipulation items-center justify-center gap-2 py-1.5 text-xs font-medium text-[var(--app-hint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset"
          >
            <span className="text-[var(--app-button)]">
              {keyboardExpanded ? "⌄" : "⌃"}
            </span>
            <span className="h-1 w-8 rounded-full bg-[var(--app-border)]" />
            <span>Keys</span>
          </BareButton>
          {keyboardExpanded ? (
            <div className="mx-auto w-full max-w-content">
              <TerminalComposeLine
                disabled={inputDisabled}
                onSend={handleSend}
                onEnter={handleEnterKey}
                inputRef={composeInputRef}
              />
              <TerminalKeyBar
                disabled={inputDisabled}
                modifiers={{ ctrl: sticky.ctrl, alt: sticky.alt }}
                onKey={handleBarKey}
                onModifierTap={mod => sticky.tap(mod)}
                onModifierDoubleTap={mod => sticky.doubleTap(mod)}
                onPaste={() => {
                  void handlePasteKey();
                }}
                onCopy={handleCopyKey}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
