// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useCallback, useRef, useEffect } from "react";
import { formatDuration, parseTimeInput } from "@/utils/duration";
import {
  anyLiveSegment,
  elapsedWithLiveSegment,
  sumDisplayElapsedMs,
  type ElapsedSessionLike,
} from "@/utils/sessionElapsed";
import { useAppContext } from "@/lib/app-context";
import { useTimelogControls } from "@/hooks/mutations/useTimelogControls";
import { useToast } from "@/components/Toast";
import type { ApiClient } from "@/api/client";
import type { TimelogAdjustmentRequest } from "@/types/api";
import { Button } from "@/components/ui/button";

interface TimelogControlMenuProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  api: ApiClient | null;
  anchorRef: React.RefObject<HTMLElement | null>;
}

/**
 * Issue #1670 (Sub H1, PR-2): the six clock controls (Adjust / Set / Reset /
 * Disable / Enable / Undo) wired to the append-only timelog_adjustments ledger.
 * Scoped to the user's namespace (server-derived) + the current local day.
 * Issue #1892 (Sub H2): this is now the sole per-session timer menu — the legacy
 * TimerMenu (Clear/Restore/Edit of the free-running client timer) was deleted.
 */
function TimelogControlMenu({
  isOpen,
  onClose,
  sessionId,
  api,
  anchorRef,
}: TimelogControlMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"menu" | "adjust" | "set">("menu");
  const [inputValue, setInputValue] = useState("");
  const [inputError, setInputError] = useState(false);
  const { submit, isPending } = useTimelogControls(api);
  const { showToast } = useToast();

  useEffect(() => {
    if (!isOpen) {
      setMode("menu");
      setInputValue("");
      setInputError(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (mode !== "menu" && inputRef.current) {
      inputRef.current.focus();
    }
  }, [mode]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const timeoutId = setTimeout(() => {
      document.addEventListener("click", handleClick);
    }, 0);
    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("click", handleClick);
    };
  }, [isOpen, onClose, anchorRef]);

  const run = useCallback(
    async (req: TimelogAdjustmentRequest) => {
      try {
        await submit(req);
      } catch (err) {
        showToast("Failed to apply clock adjustment", { type: "error" });
        console.error("[SessionTimer] timelog adjustment failed", err);
      } finally {
        onClose();
      }
    },
    [submit, onClose, showToast]
  );

  const currentDayBounds = useCallback(() => {
    const now = new Date();
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();
    return { fromMs: start, toMs: start + 86_400_000 - 1 };
  }, []);

  const handleInputSubmit = useCallback(() => {
    const parsedMs = parseTimeInput(inputValue.replace(/^\+/, ""));
    if (parsedMs === null) {
      setInputError(true);
      setTimeout(() => setInputError(false), 1000);
      return;
    }
    if (mode === "adjust") {
      void run({ type: "adjust", hapiSessionId: sessionId, deltaMs: parsedMs });
    } else {
      void run({ type: "set", hapiSessionId: sessionId, toMs: parsedMs });
    }
  }, [inputValue, mode, run, sessionId]);

  const handleUndo = useCallback(async () => {
    if (!api) {
      onClose();
      return;
    }
    try {
      const { adjustments } = await api.getTimelogAdjustments();
      const target = [...adjustments].reverse().find(a => a.type !== "undo");
      if (target) {
        void run({
          type: "undo",
          hapiSessionId: sessionId,
          targetAdjustmentId: target.id,
        });
      } else {
        onClose();
      }
    } catch (err) {
      showToast("Failed to undo clock adjustment", { type: "error" });
      console.error("[SessionTimer] timelog undo read failed", err);
      onClose();
    }
  }, [api, run, sessionId, onClose, showToast]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleInputSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setMode("menu");
        setInputValue("");
        setInputError(false);
      }
    },
    [handleInputSubmit]
  );

  if (!isOpen) return null;

  const itemClass =
    "w-full h-auto justify-start rounded-none px-3 py-1.5 text-left text-xs font-normal text-[var(--app-fg)] hover:bg-[var(--app-hover)] disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div
      ref={menuRef}
      className="absolute top-full left-0 mt-1 z-50 bg-[var(--app-bg)] border border-[var(--app-divider)] rounded-md shadow-lg py-1 min-w-[140px]" /* design-tokens-allow: 140px menu min-width; no exact spacing token (--space tops at 32px) - L2 exception (#3404) */
    >
      {mode !== "menu" ? (
        <div
          className="px-2 py-1"
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          <input
            autoCapitalize="none"
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={e => {
              setInputValue(e.target.value);
              setInputError(false);
            }}
            onKeyDown={e => {
              e.stopPropagation();
              handleKeyDown(e);
            }}
            placeholder={mode === "adjust" ? "+/- H:MM:SS" : "H:MM:SS"}
            className={
              "w-full px-2 py-1 text-xs rounded bg-[var(--app-bg)] border " +
              (inputError
                ? "border-red-500 text-red-500"
                : "border-[var(--app-border)] text-[var(--app-fg)]") +
              " focus:outline-none focus:border-[var(--app-accent)]"
            }
          />
          <div className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)] mt-1">
            Enter, Esc to cancel
          </div>
        </div>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            disabled={isPending}
            onClick={e => {
              e.stopPropagation();
              setMode("adjust");
            }}
            className={itemClass}
          >
            Adjust
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={isPending}
            onClick={e => {
              e.stopPropagation();
              setMode("set");
            }}
            className={itemClass}
          >
            Set
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={isPending}
            onClick={() =>
              void run({ type: "reset", hapiSessionId: sessionId })
            }
            className={itemClass}
          >
            Reset
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={isPending}
            onClick={() => {
              const b = currentDayBounds();
              void run({
                type: "disable",
                hapiSessionId: sessionId,
                fromMs: b.fromMs,
                toMs: b.toMs,
              });
            }}
            className={itemClass}
          >
            Disable (today)
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={isPending}
            onClick={() => {
              const b = currentDayBounds();
              void run({
                type: "enable",
                hapiSessionId: sessionId,
                fromMs: b.fromMs,
                toMs: b.toMs,
              });
            }}
            className={itemClass}
          >
            Enable (today)
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={isPending}
            onClick={() => void handleUndo()}
            className={itemClass}
          >
            Undo
          </Button>
        </>
      )}
    </div>
  );
}

export function ClockIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={
        props.className ??
        "h-[11px] w-[11px]" /* design-tokens-allow: 11px clock glyph; no exact icon token (icon-2xs=8/icon-xs=12) - L2 exception (#3404) */
      }
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

/**
 * Wall-clock that ticks ~1/s while `active` and freezes otherwise. The
 * interval lives in the leaf timer component that calls this hook, so a
 * per-second tick re-renders only that timer — never the surrounding session
 * list (#2505 R7). `resyncKey` forces an immediate resync when a new thinking
 * segment begins.
 */
function useLiveNow(active: boolean, resyncKey?: unknown): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Resync immediately on activation, then tick ~1/s.
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, resyncKey]);
  return nowMs;
}

interface SessionTimerProps {
  sessionId: string;
  thinking: boolean;
  /** Server-tracked accumulated thinking time in ms */
  serverAccumulatedMs?: number;
  /** Server-tracked timestamp when current thinking segment started */
  serverThinkingStartedAt?: number;
  /** Compact mode for session list items */
  compact?: boolean;
}

/**
 * Session timer display component.
 *
 * Issue #1892 (Sub H2): the sole per-session display is H1's breathing in-flight
 * stepper — the last-known finalized total (`serverAccumulatedMs`, stepped once
 * per finalized turn by the server) with a gentle breathing animation while
 * thinking and NO live client tick. The legacy free-running `useSessionTimer`
 * machinery, its Play/Pause button, and the legacy Clear/Restore menu were deleted
 * with the client timer surface; the turns-derived read path is now the sole time
 * source. Clicking opens the six-control ledger menu (`TimelogControlMenu`).
 */
export function SessionTimer({
  sessionId,
  thinking,
  serverAccumulatedMs,
  serverThinkingStartedAt,
  compact = false,
}: SessionTimerProps) {
  const { api } = useAppContext();

  const [menuOpen, setMenuOpen] = useState(false);
  const timerRef = useRef<HTMLDivElement>(null);

  // Issue #2505: while Claude is thinking, tick the DISPLAY up live from the last
  // server-finalized total. This is display-only theater — the value is never
  // written back to serverAccumulatedMs, the #1892 turn ledger, or CSV exports
  // (R3). Gated on a live segment timestamp so a session with no in-flight
  // segment (and the no-timestamp test path) shows the frozen server total
  // unchanged.
  const isTicking = thinking && serverThinkingStartedAt != null;
  const nowMs = useLiveNow(isTicking, serverThinkingStartedAt);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(prev => !prev);
  }, []);

  // Displayed total. While thinking with a live segment timestamp, add the
  // elapsed segment (the ≥0 clock-skew clamp lives in elapsedWithLiveSegment —
  // R5). Otherwise show the authoritative server total; when a turn finalizes
  // (thinking → false) the display snaps back to it (R4 — a small backward
  // correction is expected, not a bug).
  const displayTotal = formatDuration(
    elapsedWithLiveSegment(
      serverAccumulatedMs,
      isTicking,
      serverThinkingStartedAt,
      nowMs
    )
  );

  // Compact mode (session list): time only, no icon.
  if (compact) {
    return (
      <div
        className="relative inline-flex"
        ref={timerRef as React.RefObject<HTMLDivElement>}
      >
        <span
          onClick={handleClick}
          className={`text-[length:var(--text-caption)] tabular-nums text-[var(--app-hint)] cursor-pointer hover:text-[var(--app-fg)] ${
            thinking ? "animate-pulse" : ""
          }`}
          title="Processing time (click for options)"
        >
          {displayTotal}
        </span>
        <TimelogControlMenu
          isOpen={menuOpen}
          onClose={() => setMenuOpen(false)}
          sessionId={sessionId}
          api={api}
          anchorRef={timerRef}
        />
      </div>
    );
  }

  // Full mode for StatusBar.
  return (
    <div className="relative" ref={timerRef as React.RefObject<HTMLDivElement>}>
      <div className="flex items-center gap-1.5 text-xs tabular-nums text-[var(--app-hint)]">
        {/* Clickable clock + time area (opens the ledger menu) */}
        <div
          onClick={handleClick}
          className="flex items-center gap-1 cursor-pointer hover:text-[var(--app-fg)]"
          title="Processing time (click for options)"
        >
          <ClockIcon className={`h-3 w-3 ${thinking ? "animate-pulse" : ""}`} />
          <span>{displayTotal}</span>
        </div>
      </div>
      <TimelogControlMenu
        isOpen={menuOpen}
        onClose={() => setMenuOpen(false)}
        sessionId={sessionId}
        api={api}
        anchorRef={timerRef}
      />
    </div>
  );
}

/**
 * Read-only aggregate timer for the sessions-toolbar total. Sums each
 * session's display total (finalized serverAccumulatedMs + live in-flight
 * segment) and ticks ~1/s while any session has a live segment, so the
 * aggregate rolls up the same live theater the per-row SessionTimer shows.
 * Display-only — when a turn finalizes the server total arrives via props and
 * the sum snaps to the authoritative value.
 */
interface CumulativeTimerProps {
  sessions: readonly ElapsedSessionLike[];
}

/**
 * Read-only aggregate timer for a project group header. Same live roll-up
 * semantics as CumulativeTimer, scoped to the group's sessions.
 */
interface ProjectTimerProps {
  sessions: readonly ElapsedSessionLike[];
}

export function ProjectTimer({ sessions }: ProjectTimerProps) {
  const nowMs = useLiveNow(anyLiveSegment(sessions));
  return (
    <span
      className="text-[length:var(--text-caption)] text-white/70 tabular-nums"
      title="Total processing time for this project"
    >
      {formatDuration(sumDisplayElapsedMs(sessions, nowMs))}
    </span>
  );
}

export function CumulativeTimer({ sessions }: CumulativeTimerProps) {
  // Issue #1892 (Sub H2): read-only — the legacy Clear/Restore-all menu operated
  // on the deleted free-running client timers and was removed with them.
  const nowMs = useLiveNow(anyLiveSegment(sessions));
  return (
    <span
      className="text-[length:var(--text-caption)] text-[var(--app-hint)] tabular-nums"
      title="Total processing time across all sessions"
    >
      {formatDuration(sumDisplayElapsedMs(sessions, nowMs))}
    </span>
  );
}
