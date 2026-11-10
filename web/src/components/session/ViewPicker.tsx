// SPDX-License-Identifier: AGPL-3.0-only
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Pin } from "lucide-react";
import { SESSION_VIEWS, type SessionView } from "@hapi/protocol/schemas";
import type { Session } from "@hapi/protocol/types";
import type { ApiClient } from "@/api/client";
import { tokens } from "@/design/tokens";
import { useSessionOpenPinCount } from "@/hooks/queries/useSession";
import { useSessionViewOptions } from "@/hooks/useSessionViewOptions";
import { useSelectSessionView } from "@/hooks/useSelectSessionView";
import {
  DesktopIcon,
  FilesIcon,
  MessageSquareIcon,
  TerminalMonitorIcon,
} from "@/components/icons";
import { BareButton } from "@/components/ui/BareButton";
import {
  SESSION_VIEW_LABELS,
  isSessionViewAvailable,
  isSessionViewVisible,
} from "@/lib/session-view";
import { applyTabRowFade, computeThreadFade } from "@/lib/threadFade";
import { preloadSessionViewPages } from "@/routes/lazyPages";

const VIEW_ICONS: Record<
  SessionView,
  (props: { className?: string }) => ReactNode
> = {
  chat: MessageSquareIcon,
  pins: Pin,
  terminal: TerminalMonitorIcon,
  desktop: DesktopIcon,
  files: FilesIcon,
};

// #6449: exact component dimensions from mockup v6 (:76-79), kept in inline
// styles like the tab width, out of Tailwind arbitrary [Npx] values.
const PINS_ROW_ICON: CSSProperties = { width: "11px", height: "11px" };
const PINS_BADGE: CSSProperties = {
  minWidth: "13px",
  height: "13px",
  padding: "0 3px",
  fontSize: "9px",
  lineHeight: "13px",
};

/**
 * The View Picker (issue #3286 · S1) — a shared folder-tab row mounted at the top
 * of EVERY session view surface (chat, terminal, desktop, files) and on the
 * claude-pty surface with no active tab (D5(a)). Tabs are equal fixed width
 * (sized to "Terminal"), three-sided (open bottom seated on the divider so they
 * "stick up"), and the active tab is background-highlighted in its per-view accent
 * (from the `--view-accent-*` tokens — never a hardcoded color). Geometry follows
 * the operator-approved E6 mockup (`claudedocs/design-mockups/e6/`).
 *
 * Horizontal inset (operator ruling 2026-09-07, round 10): the tab cluster is
 * left-justified with NO horizontal padding, so the Chat tab's LEFT edge sits
 * on the Session Basic Info Bar's BOX edge — the card's `border-l-2` line —
 * not on the card's inner content edge. Both live in the same column
 * (SessionChat's `max-w-content` box), so with zero inset here the two edges
 * coincide at every width. Measured on the deployed 1.0.1128-AE build before
 * the change: card box at x=4 / tab at x=16 (402px) and 128 / 140 (1280px) —
 * the `px-3` that round 3 added to meet the content edge was exactly the 12px
 * the operator flagged as a regression.
 *
 * #6449 (Pins): the Pins tab sits between Chat and Terminal and renders only
 * while the pins gate is open and the session's open-pin count is known, or
 * while it is the active view (`isSessionViewVisible`). While it renders, the
 * whole row switches to the
 * mockup-v6 geometry: 72px tabs, 11px icons, and a sideways scroller with
 * scroll-linked edge fades. While it does not, the row is exactly the pre-#6449
 * row (84px tabs, 12px icons, no scroller) — the PM ruling for Matt,
 * 2026-11-07 — so nothing changes until Pins is turned on.
 */
export function ViewPicker(props: {
  session: Session;
  api: ApiClient;
  /** The view surface currently rendering this picker; null on claude-pty (D5(a)). */
  activeView: SessionView | null;
}) {
  const { session, api, activeView } = props;
  const selectView = useSelectSessionView(api, session.id);
  // Epic #3285 correction pass 1: the Desktop tab is greyed on an instance that
  // cannot serve a desktop (server-reported eligibility; see session-view.ts).
  // #6449: the same options decide whether the Pins tab renders at all.
  const viewOptions = useSessionViewOptions(session.id);
  const { openPinCount } = useSessionOpenPinCount(session.id);
  const visibleViews = SESSION_VIEWS.filter(view =>
    isSessionViewVisible(view, viewOptions, activeView)
  );
  const pinsRow = visibleViews.includes("pins");
  const tabListRef = useRef<HTMLDivElement>(null);

  // #6449: scroll-linked edge fades on the 72px row (the `.thread-fade` math
  // turned sideways, written as CSS variables — no re-render per scroll frame;
  // the View Picker mounts on every session view). Attached only while the
  // Pins row renders, and re-measured when the tab set changes.
  const tabSetKey = visibleViews.join(",");
  useLayoutEffect(() => {
    const row = tabListRef.current;
    if (!pinsRow || !row) return;
    const update = () =>
      applyTabRowFade(
        row,
        computeThreadFade({
          scrollTop: row.scrollLeft,
          scrollHeight: row.scrollWidth,
          clientHeight: row.clientWidth,
        })
      );
    update();
    row.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [pinsRow, tabSetKey]);

  // #6449 (R2): keep the active tab in view inside the sideways scroller.
  useLayoutEffect(() => {
    const row = tabListRef.current;
    if (!pinsRow || !row || !activeView) return;
    const tab = row.querySelector<HTMLElement>('[aria-selected="true"]');
    if (typeof tab?.scrollIntoView === "function") {
      tab.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [pinsRow, activeView, tabSetKey]);

  // #3098: the views behind these tabs load on demand. Load them while the
  // current view is idle, so the first tab switch renders at once instead of
  // waiting for the view's code.
  useEffect(() => preloadSessionViewPages(), []);

  const handleSelect = (view: SessionView) => {
    if (view === activeView) return;
    selectView(view);
  };

  return (
    <div className="border-b border-[var(--app-divider)] bg-[var(--app-bg)]">
      <div
        // pt-1.5 (6px). The content panel around every session view is
        // `overflow-hidden rounded-lg` (8px corners — AppShell), and with the
        // Chat tab on the panel's left edge (round 10) the tab's own 6.4px
        // top-left arc must sit INSIDE the panel's arc or the panel clips it
        // (operator round 11, 2026-09-07: "edge clipped by a dark color").
        // Clip-free top gap ≈ panel radius − 2px: round 11 paid 14px under the
        // old 16px panel radius; round 12 ("reclaim that vertical space",
        // 2026-09-07) took the panel to the 8px `--radius-lg` token — the
        // closest token to the E9 frame's 10px — so 6px keeps the tab arc
        // ≥1.9px inside the panel arc at every point. Computed, then measured.
        //
        // #6449: the Pins row scrolls sideways. `overflow-x: auto` forces
        // `overflow-y: auto`, which would clip each tab's `-mb-px` seat on the
        // divider (fixture P3); `pb-px -mb-px` gives the seat back.
        ref={tabListRef}
        className={`mx-auto flex w-full max-w-content items-end gap-1 pt-1.5${
          pinsRow
            ? " tab-row-fade -mb-px overflow-x-auto scrollbar-none pb-px"
            : ""
        }`}
        role="tablist"
        aria-label="Session view"
      >
        {visibleViews.map(view => {
          const Icon = VIEW_ICONS[view];
          const isActive = view === activeView;
          const available = isSessionViewAvailable(view, session, viewOptions);
          const accent = tokens.view[view];
          // Fixed folder-tab geometry (E6 mockup: 84px equal width sized to
          // "Terminal", 3px vertical padding) lives in the inline style — exact
          // component dimensions with no named scale, kept out of Tailwind
          // arbitrary [Npx] values. The active accent (color + color-mix bg/border
          // from the --view-accent-* token) rides the same object.
          const tabStyle: CSSProperties = {
            // #6449: 72px (mockup v6) only while the Pins tab renders.
            width: pinsRow ? "72px" : "84px",
            paddingTop: "3px",
            paddingBottom: "3px",
            ...(isActive
              ? {
                  color: accent,
                  backgroundColor: `color-mix(in srgb, ${accent} 17%, transparent)`,
                  borderColor: `color-mix(in srgb, ${accent} 55%, transparent)`,
                }
              : {}),
          };
          // #6449 (R3): the open-pin count, up to 999, inside the Pins tab.
          const badge =
            view === "pins" && openPinCount !== undefined && openPinCount > 0
              ? Math.min(openPinCount, 999)
              : null;
          return (
            <BareButton
              key={view}
              type="button"
              role="tab"
              aria-selected={isActive}
              disabled={!available}
              title={
                badge === null
                  ? SESSION_VIEW_LABELS[view]
                  : `${SESSION_VIEW_LABELS[view]} · ${badge} need you`
              }
              onClick={() => handleSelect(view)}
              style={tabStyle}
              className={`-mb-px box-border inline-flex items-center justify-center gap-1 rounded-t-md border border-b-0 border-[var(--app-border)] text-[length:var(--text-caption)] font-semibold ${
                isActive ? "" : "text-[var(--app-hint)]"
              } ${available ? "" : "cursor-not-allowed opacity-30"}${
                pinsRow ? " flex-none whitespace-nowrap" : ""
              }`}
            >
              {pinsRow ? (
                <span className="inline-flex shrink-0" style={PINS_ROW_ICON}>
                  <Icon className="h-full w-full" />
                </span>
              ) : (
                <Icon className="h-3 w-3" />
              )}
              {SESSION_VIEW_LABELS[view]}
              {badge === null ? null : (
                <span
                  aria-label={`${badge} open pins`}
                  style={PINS_BADGE}
                  className="rounded-full bg-[var(--view-accent-pins)] text-center font-bold tabular-nums text-[var(--app-bg)]"
                >
                  {badge}
                </span>
              )}
            </BareButton>
          );
        })}
      </div>
    </div>
  );
}
