// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useLocation } from "@tanstack/react-router";
import { Settings as SettingsIcon, Mail as MailIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { useVersion } from "@/hooks/useVersion";
import { formatEasternDateTime } from "@/utils/easternTime";
import {
  IPAD_WINDOW_CONTROLS_INSET_X,
  useIPadMultitasking,
} from "@/hooks/useIPadMultitasking";
import { useIsDevInstance } from "@/hooks/useIsDevInstance";
import { SplitScreenIcon } from "@/components/icons";
import { SPLIT_MIN_WIDTH } from "@/lib/layout-thresholds";
import { UpdateAvailableBadge } from "@/components/UpdateAvailableBadge";
import { useOptionalAppContext } from "@/lib/app-context";
import { FeedbackModal } from "@/components/FeedbackModal";
import { AppShell } from "@/components/layouts/AppShell";
import { HapimaticWordmark } from "@/components/brand/HapimaticWordmark";
import { useThreadFullscreen } from "@/lib/thread-fullscreen-context";

function RefreshIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function ChevronLeftIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

interface BrandedFrameProps {
  children: ReactNode;
  /** Whether to show the back button in the title bar */
  showBackButton?: boolean;
  /** Callback when back button is clicked */
  onBack?: () => void;
  /** Split-view toggle handler — if provided, shows the SplitScreen icon in the header */
  onSplitToggle?: () => void;
  /** Whether split-view is currently active (controls SplitScreen icon active color) */
  isSplitActive?: boolean;
  /** Whether the viewport is wide enough to split (controls SplitScreen disabled state) */
  canSplit?: boolean;
  /**
   * #3280 (R6): reset split state on wordmark click. The wordmark stays a working
   * `<Link to="/">` (escape hatch); this runs first to drop split + reset panes so
   * the home navigation lands on the session list in a known single-column state.
   */
  onWordmarkReset?: () => void;
}

/**
 * BrandedFrame wraps the app content with Hapimatic branding:
 * - Near-midnight (#1e0a3e) header bar with the HapimaticWordmark (#4776): the
 *   W11 outline wordmark that plays the transmission "bridge" once per page
 *   load and on each tap, then holds the T2 frame (T2 at once with reduced motion)
 * - Spring-green (--brand-accent #4ade80) border on left, right, and bottom edges
 * - Handles iOS safe-area-inset-top for the header
 * - Shows red "DEV" badge on dev instance (port 3009)
 *
 * The reusable app-shell layout — the `.app-shell` structure, the four
 * class-name-keyed regions, the keyboard/safe-area/rubber-band handling, and the
 * `standalone-touch` registration — lives in the `AppShell` layout template
 * (`@/components/layouts/AppShell`, Interface Design System Sub-Issue E). BrandedFrame
 * is its sole consumer: it supplies the branded header, the version/feedback footer,
 * and the FeedbackModal as slots. This is a pure extraction — the rendered DOM is
 * unchanged.
 */
export function BrandedFrame({
  children,
  showBackButton,
  onBack,
  onSplitToggle,
  isSplitActive,
  canSplit,
  onWordmarkReset,
}: BrandedFrameProps) {
  const navigate = useNavigate();
  const { data: versionInfo } = useVersion();
  const [copied, setCopied] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // #4776: bumped on each wordmark tap so the wordmark replays its bridge.
  const [wordmarkReplay, setWordmarkReplay] = useState(0);
  const appCtx = useOptionalAppContext();
  const pathname = useLocation({ select: location => location.pathname });
  const feedbackSessionSeg = pathname.startsWith("/sessions/")
    ? pathname.slice("/sessions/".length).split("/")[0]
    : "";
  const feedbackSessionId =
    feedbackSessionSeg && feedbackSessionSeg !== "new"
      ? feedbackSessionSeg
      : null;
  const isDev = useIsDevInstance();
  const isIPadMultitasking = useIPadMultitasking();
  // #3638: when the chat thread is in single-view full-screen page mode, drop the
  // app-bar content (back arrow · wordmark · icons) but keep AppShell's safe-area
  // band (operator ruling D1=(a)). SessionChat sets this flag only in single view.
  const { threadFullscreen } = useThreadFullscreen();

  // Version timestamp is stored as UTC; render it in Eastern Time so the
  // footer reads in Eastern regardless of the viewing device's timezone.
  const { date, time } = versionInfo?.timestamp
    ? formatEasternDateTime(versionInfo.timestamp)
    : { date: "", time: "" };

  const handleCopyVersion = async () => {
    if (!versionInfo) return;
    try {
      await navigator.clipboard.writeText(`v${versionInfo.version}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable or permission denied — fail silently
    }
  };

  return (
    <AppShell
      // #3280 Task 4/5: the split content-clamp is dropped ONLY on the pane host
      // (`/sessions`). `isSplitActive` can be true on a non-pane route (a persisted
      // split flag on an instance-view deep link, or a `/settings/*` page with split
      // still armed in context) where no panes render — there the content MUST stay
      // clamped/single-column (never full-bleed), so gate on the route too.
      fullWidthContent={!!isSplitActive && pathname === "/sessions"}
      header={
        // #3638: single-view full-screen drops the app-bar CONTENT; AppShell
        // still renders its `header != null` safe-area band (an empty fragment is
        // != null), so the brand band stays and the thread never sits under the
        // notch — while the back arrow / wordmark / icons are gone.
        threadFullscreen ? (
          <></>
        ) : (
          <div className="px-1 py-1 border-b-2 border-[var(--brand-accent)]/40">
            {/* Inner container constrained to content width for icon alignment */}
            <div className="mx-auto w-full max-w-content flex items-center justify-center relative">
              {/* Left side - Back button (conditionally rendered) */}
              {showBackButton && onBack && (
                <div
                  className="absolute top-1/2 -translate-y-1/2 z-10"
                  style={{
                    left: isIPadMultitasking
                      ? IPAD_WINDOW_CONTROLS_INSET_X
                      : "0",
                  }}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={onBack}
                    className="h-auto rounded-full p-2.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                    title="Go back"
                    aria-label="Go back to previous page"
                  >
                    <ChevronLeftIcon className="h-5 w-5" />
                  </Button>
                </div>
              )}

              {/* Epic #3285 round 15: the wordmark is centered on the BAR, full stop.
                The former `marginRight: var(--icon-slot)` (#304) pre-dated the
                three-icon bar and shifted the centered wordmark 17px left of the
                viewport center (measured: glyph center 179.5 vs 196.5 at 393px).
                The action icons are absolutely positioned, so they take no flex
                space and need no compensation. */}
              <div className="relative inline-flex items-center scale-[0.8] origin-center">
                {/* In-app home button (#1257): a TanStack <Link to="/"> (which
                  redirects to /sessions) so the wordmark is always a working
                  escape hatch — including from the not-found view. The external
                  GitHub link is dropped here; it returns at /settings/about (#1041). */}
                <Link
                  to="/"
                  onClick={() => {
                    // #3280 R6 reset first, then (#4776) replay the bridge.
                    onWordmarkReset?.();
                    setWordmarkReplay(n => n + 1);
                  }}
                  className="cursor-pointer hover:opacity-80 transition-opacity motion-reduce:transition-none"
                  title="Home"
                >
                  {/* The Link's only child, so its box is the mark's box —
                    #4468 measures the Link to place the title-bar node chip. */}
                  <HapimaticWordmark
                    replayToken={wordmarkReplay}
                    className="h-7"
                  />
                </Link>
                {/* DEV badge - positioned at lower-right corner overlaid on title.
                  #4776: the W11 mark is framed tight (its last glyph ends ~2px
                  from the box edge), so -right-5 keeps the badge where it sat on
                  screen beside the old, loosely framed wordmark. */}
                {isDev && (
                  <span
                    className={
                      /* design-tokens-allow: 9px sub-floor DEV badge label, below the 10px --text-caption-xs ladder floor (#3336) (L8 #3410) */ "absolute -bottom-1 -right-5 px-1 py-0.5 text-[9px] font-bold text-white rounded shadow-sm"
                    }
                    style={{ backgroundColor: "var(--destructive)" }}
                  >
                    DEV
                  </span>
                )}
              </div>
              {/* App-level actions — icon-col system for vertical alignment with Row 2 */}
              {/* Order (slot col-3 → col-1, visual left → right): */}
              {/*   SplitScreen (col-3) · Refresh (col-2) · Hamburger (col-1) */}
              {/* E8/E9 (epic #3285, approved 2026-09-05): the System Health icon LEFT the
                app bar — the bar is exactly these three, and the Control Bar's
                Revert slot / Select / Create seat directly under them (router.tsx). */}
              {/* Outer div: absolute positioning (right-2 aligns with Row 2's pr-2 max-w-content) */}
              {/* Inner div: icon-row (position:relative from CSS, so it can't also be absolute) */}
              <div className="absolute right-2 top-1/2 -translate-y-1/2">
                <div
                  className="icon-row"
                  style={{
                    width: "calc(var(--icon-slot) * 2 + var(--icon-btn-size))",
                  }}
                >
                  {/* col-3 (leftmost) — SplitScreen (promoted from the SessionList toolbar).
                    Renders disabled (not hidden) on narrow viewports so the 3-slot row
                    stays stable across all sizes (#1043, Key Decision #7). Disabled, it
                    is a ghost of its neighbours: the Refresh/Settings color at 30%
                    opacity, no hover fill. BareButton pins `tooltipOnDisabled`, so the
                    disabled `title` becomes a hover tip on desktop and a tap-to-reveal
                    tip on touch (#3462). */}
                  {onSplitToggle && (
                    <div className="icon-col-3">
                      <BareButton
                        type="button"
                        onClick={onSplitToggle}
                        disabled={!canSplit}
                        className={`p-1.5 rounded-full transition-colors ${
                          !canSplit
                            ? "text-white/60 disabled:opacity-30 cursor-not-allowed"
                            : isSplitActive
                              ? "text-[var(--app-accent)] hover:bg-white/10"
                              : "text-white/60 hover:bg-white/10 hover:text-white"
                        }`}
                        title={
                          !canSplit
                            ? `Split-Screen view not available for screens less than ${SPLIT_MIN_WIDTH}px wide.`
                            : isSplitActive
                              ? "Exit split view"
                              : "Split view"
                        }
                        aria-label="Toggle split view"
                      >
                        <SplitScreenIcon className="h-5 w-5" />
                      </BareButton>
                    </div>
                  )}
                  {/* col-2 — Refresh (unchanged) */}
                  <div className="icon-col-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => window.location.reload()}
                      className="h-auto rounded-full p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                      title="Refresh app"
                      aria-label="Refresh app"
                    >
                      <RefreshIcon className="h-5 w-5" />
                    </Button>
                  </div>
                  {/* col-1 (rightmost / thumb-zone) — Hamburger → opens the Admin drawer
                    (?drawer=settings, history push so the back gesture closes it). */}
                  <div className="icon-col-1">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        navigate({
                          to: ".",
                          search: prev => ({
                            ...(prev as Record<string, unknown>),
                            drawer: "settings",
                          }),
                        })
                      }
                      data-testid="settings-menu-button"
                      title="Settings"
                      aria-label="Settings"
                      className="h-auto rounded-full p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      <SettingsIcon className="h-5 w-5" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      }
      belowHeader={
        /* Issue #3057: the SINGLE mint-green update bar — full-width row below the
           title bar (mobile-safe; avoids the title-row icon cluster). It owns BOTH
           the VM binary-update pipeline (#1006/#2589) AND the service-worker asset
           refresh (#1793) — the old separate green "New version — Reload" band
           (UpdateAvailableBanner) was folded in here and removed. Renders null
           unless an update is available/staged or a fresh SW is waiting. */
        <UpdateAvailableBadge />
      }
      footer={
        versionInfo ? (
          // One centered inline line: version/timestamp, then the Feedback entry
          // in the slot the launcher ("SDK") text used to occupy. The launcher
          // indicator is gone from the footer (it still lives at /settings/about
          // and in each session's own header). The Feedback entry truncates to
          // just the envelope below `sm` and shows the "Feedback" word at `sm`+.
          <div className="mx-auto flex w-full max-w-content items-center justify-center">
            <span
              className={`text-xs cursor-pointer transition-colors duration-150 ${
                copied ? "text-green-300" : "text-white/50"
              }`}
              onClick={handleCopyVersion}
              role="button"
              tabIndex={0}
              aria-label="Copy version to clipboard"
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") handleCopyVersion();
              }}
            >
              {copied ? (
                "Copied!"
              ) : (
                <>
                  v{versionInfo.version}
                  {date ? ` • ${date}` : ""}
                  {time ? ` • ${time}` : ""}
                </>
              )}
            </span>
            {appCtx?.api ? (
              <>
                {/* Bullet separator — keeps the footer's separated rhythm so the
                    Feedback entry sits exactly where " • SDK" used to. */}
                <span aria-hidden="true" className="mx-1 text-xs text-white/50">
                  •
                </span>
                <Button
                  type="button"
                  variant="ghostStatic"
                  onClick={() => setFeedbackOpen(true)}
                  aria-label="Send feedback"
                  title="Send feedback"
                  data-testid="feedback-button"
                  className="inline-flex h-auto items-center gap-1 p-0 text-xs font-normal text-white/50 transition-colors hover:text-white active:text-white"
                >
                  <MailIcon size={16} />
                  <span className="hidden sm:inline">Feedback</span>
                </Button>
              </>
            ) : null}
          </div>
        ) : null
      }
      overlays={
        appCtx?.api ? (
          <FeedbackModal
            open={feedbackOpen}
            onClose={() => setFeedbackOpen(false)}
            api={appCtx.api}
            route={pathname}
            sessionId={feedbackSessionId}
            appVersion={versionInfo?.version}
            loginUsername={appCtx.user?.username ?? null}
          />
        ) : null
      }
    >
      {children}
    </AppShell>
  );
}
