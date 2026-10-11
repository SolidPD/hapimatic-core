// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session-detail slot context (issue #1285, Sub-Issue U of epic #1264).
 *
 * Supplies the session id that a session-detail slot contribution is being
 * rendered FOR. Slot specs render with no props (`ToolViewLike` narrows to a
 * zero-prop `ComponentType`), so a contribution cannot receive the session
 * through its own signature — it must read it from context.
 *
 * ## Why this exists — the split-view bug
 *
 * The obvious self-discovery route is `useParams({ from: "/sessions/$sessionId" })`,
 * and that is what `builtin.token-usage` originally did. It is wrong, because
 * `<SessionChat />` has TWO mount contexts:
 *
 *  1. `router.tsx` `SessionPage` — the `/sessions/$sessionId` route. URL session
 *     == rendered session, so `useParams` is correct here.
 *  2. `SplitPaneContentView` (`router.tsx:617` / `:665`) — a pane-level "router"
 *     that renders session views INLINE from pane state, with no TanStack Router
 *     navigation. `SplitPaneSessionView` takes `sessionId` as a PROP and
 *     documents that it deliberately omits page-level concerns including
 *     `useParams` (`SplitPaneSessionView.tsx:19-20`).
 *
 * In context 2 the URL is `/sessions` (the list route), so a STRICT
 * `useParams({ from: "/sessions/$sessionId" })` is not in the match tree and
 * throws — crashing the pane. Even where a `$sessionId` is in scope, pane B
 * showing a different session would render pane A's data.
 *
 * The fix is for the mount site — which always knows its own session — to
 * publish it, rather than each contribution guessing from the URL.
 *
 * ## Resolution order (augment, never replace — CLAUDE.md Fallback Preservation)
 *
 *  1. Context value, when a mount site provides one (always correct, incl. split view)
 *  2. `useParams({ strict: false })` — loose read, returns undefined instead of
 *     throwing when the route is not matched. Covers a slot mounted somewhere
 *     that has not adopted the provider yet but does sit on a session route.
 *  3. `null` — the contribution renders nothing rather than guessing.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";

const SessionDetailContext = createContext<string | null>(null);

/**
 * Publishes the session id that session-detail slot contributions inside
 * `children` are rendered for. Mount sites that know their session (i.e.
 * `SessionChat`, which receives it as a prop) should wrap their slot renderers
 * in this.
 */
export function SessionDetailProvider(props: {
  sessionId: string;
  children: ReactNode;
}) {
  return (
    <SessionDetailContext.Provider value={props.sessionId}>
      {props.children}
    </SessionDetailContext.Provider>
  );
}

/**
 * The session id the current slot contribution is rendered for, or `null` when
 * it cannot be determined. See the resolution order in the file docstring.
 *
 * Returns `null` rather than throwing so a contribution rendered outside any
 * session context degrades to rendering nothing.
 */
export function useSessionDetailSessionId(): string | null {
  const fromContext = useContext(SessionDetailContext);
  // Loose param read — `strict: false` returns the params of whatever route IS
  // matched (or undefined), instead of throwing when `/sessions/$sessionId` is
  // absent from the match tree. Hooks run unconditionally; the context value
  // still wins when present.
  const params = useParams({ strict: false });
  if (fromContext) return fromContext;
  const fromRoute = (params as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof fromRoute === "string" && fromRoute ? fromRoute : null;
}
