// SPDX-License-Identifier: AGPL-3.0-only
import { type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SESSION_VIEWS, type SessionView } from "@hapi/protocol/schemas";
import type { Session } from "@hapi/protocol/types";
import type { ApiClient } from "@/api/client";
import { tokens } from "@/design/tokens";
import { useUpdateSessionView } from "@/hooks/mutations/useUpdateSessionView";
import { useVersion } from "@/hooks/useVersion";
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
  markOpenRedirectConsumed,
  sessionViewToPath,
  writeCachedSessionView,
} from "@/lib/session-view";
import { getStorageKey } from "@/lib/storage-keys";
import { THREAD_FULLSCREEN_STORAGE_BASE } from "@/lib/thread-fullscreen-context";

const VIEW_ICONS: Record<
  SessionView,
  (props: { className?: string }) => ReactNode
> = {
  chat: MessageSquareIcon,
  terminal: TerminalMonitorIcon,
  desktop: DesktopIcon,
  files: FilesIcon,
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
 */
export function ViewPicker(props: {
  session: Session;
  api: ApiClient;
  /** The view surface currently rendering this picker; null on claude-pty (D5(a)). */
  activeView: SessionView | null;
}) {
  const { session, api, activeView } = props;
  const navigate = useNavigate();
  const { updateView } = useUpdateSessionView(api, session.id);
  // Epic #3285 correction pass 1: the Desktop tab is greyed on an instance that
  // cannot serve a desktop (server-reported eligibility; see session-view.ts).
  const desktopEligible = useVersion().data?.desktopEligible;

  const handleSelect = (view: SessionView) => {
    if (view === activeView) return;
    // Synchronous no-flash cache write + disarm this open's auto-redirect (an
    // explicit tap is a deliberate choice), then navigate and persist. Persist is
    // fire-and-forget — the optimistic hook updates every cache and rolls back on
    // failure; the localStorage value self-corrects on the next server reconcile.
    writeCachedSessionView(session.id, view);
    markOpenRedirectConsumed(session.id);
    // #3638 (D2=(a)): switching to a non-chat view (Terminal/Desktop/Files) exits
    // full-screen DURABLY — clear the per-device flag so returning to Chat is not
    // a surprise re-maximize. Session→session switches keep it (mockup panel F).
    if (view !== "chat") {
      try {
        localStorage.setItem(
          getStorageKey(THREAD_FULLSCREEN_STORAGE_BASE),
          "0"
        );
      } catch {
        // localStorage unavailable/full — non-fatal; the visible exit still
        // happens via SessionChat's route unmount.
      }
    }
    navigate({ to: sessionViewToPath(view, session.id) });
    void updateView(view).catch(() => {});
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
        className="mx-auto flex w-full max-w-content items-end gap-1 pt-1.5"
        role="tablist"
        aria-label="Session view"
      >
        {SESSION_VIEWS.map(view => {
          const Icon = VIEW_ICONS[view];
          const isActive = view === activeView;
          const available = isSessionViewAvailable(view, session, {
            desktopEligible,
          });
          const accent = tokens.view[view];
          // Fixed folder-tab geometry (E6 mockup: 84px equal width sized to
          // "Terminal", 3px vertical padding) lives in the inline style — exact
          // component dimensions with no named scale, kept out of Tailwind
          // arbitrary [Npx] values. The active accent (color + color-mix bg/border
          // from the --view-accent-* token) rides the same object.
          const tabStyle: CSSProperties = {
            width: "84px",
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
          return (
            <BareButton
              key={view}
              type="button"
              role="tab"
              aria-selected={isActive}
              disabled={!available}
              title={SESSION_VIEW_LABELS[view]}
              onClick={() => handleSelect(view)}
              style={tabStyle}
              className={`-mb-px box-border inline-flex items-center justify-center gap-1 rounded-t-md border border-b-0 border-[var(--app-border)] text-[length:var(--text-caption)] font-semibold ${
                isActive ? "" : "text-[var(--app-hint)]"
              } ${available ? "" : "cursor-not-allowed opacity-30"}`}
            >
              <Icon className="h-3 w-3" />
              {SESSION_VIEW_LABELS[view]}
            </BareButton>
          );
        })}
      </div>
    </div>
  );
}
