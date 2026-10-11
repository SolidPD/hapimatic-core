// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

// ── Types ──────────────────────────────────────────────────────────────

type ToastType = "success" | "error" | "warning" | "info";

interface ToastOptions {
  type?: ToastType;
  duration?: number;
  // Issue #3516: an optional inline action button (e.g. a back-link to the
  // session a failed delete rolled back). Clicking it runs onClick then dismisses.
  action?: { label: string; onClick: () => void };
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
  exiting: boolean;
  swipeY: number;
  swiping: boolean;
  action?: { label: string; onClick: () => void };
}

interface ToastContextValue {
  showToast: (message: string, options?: ToastOptions) => void;
}

// ── Constants ──────────────────────────────────────────────────────────

const MAX_VISIBLE = 3;
const DEDUP_WINDOW_MS = 2000;
const SWIPE_DISMISS_THRESHOLD = 50;
const EXIT_ANIMATION_MS = 250;

const DEFAULT_DURATIONS: Record<ToastType, number> = {
  success: 3000,
  error: 5000,
  warning: 4000,
  info: 4000,
};

const TYPE_ICONS: Record<ToastType, string> = {
  success: "✓",
  error: "✕",
  warning: "!",
  info: "i",
};

// ── Context ────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return { showToast: () => {} };
  }
  return ctx;
}

// ── Single Toast Component ─────────────────────────────────────────────

interface SingleToastProps {
  toast: ToastItem;
  index: number;
  onDismiss: (id: number) => void;
}

function SingleToast({ toast, index, onDismiss }: SingleToastProps) {
  const touchStartY = useRef(0);
  const swipeRef = useRef({ y: 0, swiping: false });
  const elRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    swipeRef.current.swiping = true;
    if (elRef.current) {
      elRef.current.style.transition = "none";
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!swipeRef.current.swiping) return;
    const deltaY = e.touches[0].clientY - touchStartY.current;
    // Only track downward swipes (positive delta) for bottom-positioned toasts
    if (deltaY > 0) {
      swipeRef.current.y = deltaY;
      if (elRef.current) {
        elRef.current.style.transform = `translateY(${deltaY}px)`;
        elRef.current.style.opacity = String(Math.max(0, 1 - deltaY / 100));
      }
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    swipeRef.current.swiping = false;
    if (swipeRef.current.y > SWIPE_DISMISS_THRESHOLD) {
      onDismiss(toast.id);
    } else if (elRef.current) {
      // Snap back with spring animation
      elRef.current.style.transition =
        "transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease";
      elRef.current.style.transform = "";
      elRef.current.style.opacity = "";
    }
    swipeRef.current.y = 0;
  }, [onDismiss, toast.id]);

  const borderColor = {
    success: "border-l-[var(--brand-accent)]",
    error: "border-l-[var(--toast-error)]",
    warning: "border-l-[var(--toast-warning)]",
    info: "border-l-[var(--app-hint)]",
  }[toast.type];

  const iconBg = {
    success: "bg-[var(--brand-accent)] text-[var(--app-bg)]",
    error: "bg-[var(--toast-error)] text-white",
    warning: "bg-[var(--toast-warning)] text-[var(--app-bg)]",
    info: "bg-[var(--app-hint)] text-white",
  }[toast.type];

  return (
    <div
      ref={elRef}
      role="alert"
      className={`toast-item ${toast.exiting ? "toast-exit" : "toast-enter"}`}
      style={{
        marginBottom: index > 0 ? "8px" : undefined,
        touchAction: "none",
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div
        className={
          /* design-tokens-allow: 3px status-accent left border, no border-width token (L8 #3410) */ `flex items-start gap-3 rounded-xl border-l-[3px] ${borderColor} bg-[var(--app-secondary-bg)] px-3 py-3 shadow-2xl`
        }
      >
        {/* Type icon */}
        <div
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${iconBg}`}
        >
          {TYPE_ICONS[toast.type]}
        </div>

        {/* Message + optional inline action (issue #3516) */}
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm text-[var(--app-fg)]">
            {toast.message}
          </p>
          {toast.action && (
            <Button
              variant="ghostStatic"
              onClick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
              className="mt-1 h-auto p-0 text-sm font-medium text-[var(--app-link)] underline underline-offset-2 hover:opacity-80 active:opacity-60"
            >
              {toast.action.label}
            </Button>
          )}
        </div>

        {/* Dismiss button */}
        <Button
          variant="ghostStatic"
          onClick={() => onDismiss(toast.id)}
          className="h-auto shrink-0 p-0.5 text-[var(--app-hint)] hover:text-[var(--app-fg)] active:text-[var(--app-fg)]"
          aria-label="Dismiss"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </Button>
      </div>
    </div>
  );
}

// ── Toast Provider ─────────────────────────────────────────────────────

interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const lastMessage = useRef<{ text: string; time: number }>({
    text: "",
    time: 0,
  });
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  // Synchronous mirror of `toasts` so showToast/dismissToast can compute the
  // next array (and clear dropped toasts' timers) OUTSIDE the setState updater,
  // keeping the updater pure. Updated alongside every setToasts call below
  // (issue #1612).
  const toastsRef = useRef<ToastItem[]>([]);

  const dismissToast = useCallback((id: number) => {
    // Start exit animation. Compute from the synchronous mirror so the
    // setToasts updater stays pure (issue #1612).
    const marked = toastsRef.current.map(t =>
      t.id === id ? { ...t, exiting: true } : t
    );
    toastsRef.current = marked;
    setToasts(marked);
    // Remove after the exit animation completes.
    setTimeout(() => {
      const filtered = toastsRef.current.filter(t => t.id !== id);
      toastsRef.current = filtered;
      setToasts(filtered);
    }, EXIT_ANIMATION_MS);
    // Clear auto-dismiss timer
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message: string, options?: ToastOptions) => {
      const type = options?.type ?? "info";
      const duration = options?.duration ?? DEFAULT_DURATIONS[type];

      // Deduplication: suppress same message within window
      const now = Date.now();
      if (
        lastMessage.current.text === message &&
        now - lastMessage.current.time < DEDUP_WINDOW_MS
      ) {
        return;
      }
      lastMessage.current = { text: message, time: now };

      const id = nextId.current++;
      const newToast: ToastItem = {
        id,
        message,
        type,
        duration,
        exiting: false,
        swipeY: 0,
        swiping: false,
        action: options?.action,
      };

      // Compute the next visible set synchronously from the ref mirror (NOT
      // inside the setToasts updater). Overflow beyond MAX_VISIBLE is dropped
      // synchronously and its auto-dismiss timer cleared here — this replaces
      // the old setTimeout(dismissToast) scheduled FROM INSIDE the updater,
      // whose eviction + timer cascade produced the setState storm that tripped
      // React #185 on a burst (issue #1612). Dropped toasts forgo the exit
      // animation — acceptable for a rapid-supersession burst.
      const appended = [...toastsRef.current, newToast];
      const dropped =
        appended.length > MAX_VISIBLE
          ? appended.slice(0, appended.length - MAX_VISIBLE)
          : [];
      const next = appended.slice(-MAX_VISIBLE);

      for (const d of dropped) {
        const droppedTimer = timersRef.current.get(d.id);
        if (droppedTimer) {
          clearTimeout(droppedTimer);
          timersRef.current.delete(d.id);
        }
      }

      toastsRef.current = next;
      setToasts(next);

      // Auto-dismiss timer
      const timer = setTimeout(() => dismissToast(id), duration);
      timersRef.current.set(id, timer);
    },
    [dismissToast]
  );

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach(timer => clearTimeout(timer));
    };
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toasts.length > 0 &&
        createPortal(
          <div
            className="fixed bottom-0 left-0 right-0 z-[9999] flex flex-col-reverse items-center pointer-events-none"
            style={{
              paddingBottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
            }}
          >
            <div className="w-full max-w-sm px-4 pointer-events-auto">
              {toasts.map((toast, i) => (
                <SingleToast
                  key={toast.id}
                  toast={toast}
                  index={i}
                  onDismiss={dismissToast}
                />
              ))}
            </div>
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
}
