// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";

/**
 * Back-interceptor registry (#3638). A back-interceptor gets first refusal on
 * every in-app Back press routed through `useAppGoBack` — the Telegram
 * BackButton, the app-bar back arrow, and the edge-swipe (all call the callback
 * this hook returns). An interceptor returns `true` when it HANDLED the press
 * (e.g. the chat thread exited full-screen page mode) — the callback then returns
 * WITHOUT navigating, so Back stays in the session instead of leaving it.
 *
 * This is a NAVIGATION-layer intercept, not a history-stack one: nothing is
 * pushed, so there is no entry to consume and no double-Back hole. The router's
 * own browser/PWA OS Back listener bypasses this callback entirely; that path is
 * covered separately by TanStack `useBlocker` at the consumer.
 *
 * Registry is module-level (shared across every `useAppGoBack` call site, which
 * each returns its own callback bound to the same registry). Interceptors are
 * consulted in registration order; the FIRST to return `true` wins.
 */
type BackInterceptor = () => boolean;

const backInterceptors = new Set<BackInterceptor>();

export function registerBackInterceptor(fn: BackInterceptor): () => void {
  backInterceptors.add(fn);
  return () => {
    backInterceptors.delete(fn);
  };
}

/** Consult the registry; true iff some interceptor handled the Back press. */
function runBackInterceptors(): boolean {
  for (const fn of backInterceptors) {
    if (fn()) return true;
  }
  return false;
}

export function useAppGoBack(): () => void {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: location => location.pathname });

  return useCallback(() => {
    // #3638: interceptors get first refusal — an interceptor that exits a modal
    // page-mode (e.g. the full-screen chat thread) handles the press without any
    // navigation, keeping Back inside the session.
    if (runBackInterceptors()) {
      return;
    }

    // Use explicit path navigation for consistent behavior across all environments
    if (pathname === "/sessions/new") {
      navigate({ to: "/sessions" });
      return;
    }

    // For single file view, go back to files list
    if (pathname.match(/^\/sessions\/[^/]+\/file$/)) {
      const filesPath = pathname.replace(/\/file$/, "/files");
      navigate({ to: filesPath });
      return;
    }

    // For session routes, navigate to parent path
    if (pathname.startsWith("/sessions/")) {
      const parentPath = pathname.replace(/\/[^/]+$/, "") || "/sessions";
      navigate({ to: parentPath });
      return;
    }

    // Fallback to history.back() for other cases
    router.history.back();
  }, [navigate, pathname, router]);
}
