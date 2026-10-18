// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Outlet,
  useLocation,
  useMatchRoute,
  useNavigate,
} from "@tanstack/react-router";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { MessagesResponse } from "@/types/api";
import { getTelegramWebApp, isTelegramApp } from "@/hooks/useTelegram";
import { initializeTheme } from "@/hooks/useTheme";
import { useAuth } from "@/hooks/useAuth";
import { useAuthSource } from "@/hooks/useAuthSource";
import { useServerUrl } from "@/hooks/useServerUrl";
import { useVersion } from "@/hooks/useVersion";
import { useSSE } from "@/hooks/useSSE";
import { usePwaRecovery } from "@/hooks/usePwaRecovery";
import { useSyncingState } from "@/hooks/useSyncingState";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import {
  readGlobalOptOut,
  syncPreferencesToCache,
} from "@/lib/notificationPreferences";
import { reconcilePushOnLoad } from "@/lib/pushAutoSubscribe";
import { queryKeys } from "@/lib/query-keys";
import { AppContextProvider } from "@/lib/app-context";
import { ExtensionHostProvider } from "@/ext/host";
import { useAppGoBack } from "@/hooks/useAppGoBack";
import { LoginPrompt } from "@/components/LoginPrompt";
import { InstallPrompt } from "@/components/InstallPrompt";
import { OfflineBanner } from "@/components/OfflineBanner";
import { AuthErrorBanner } from "@/components/AuthErrorBanner";
import { SyncingBanner } from "@/components/SyncingBanner";
import { LoadingState } from "@/components/LoadingState";
import { BrandedFrame } from "@/components/BrandedFrame";
import { ThreadFullscreenProvider } from "@/lib/thread-fullscreen-context";
import { ToastProvider, useToast } from "@/components/Toast";
import { ApiErrorToastListener } from "@/components/ApiErrorToastListener";
import { SettingsDrawer } from "@/components/SettingsDrawer";
import { OnboardingHost } from "@/components/onboarding/OnboardingHost";
import { useSplitViewContext } from "@/lib/split-view-context";
import useDensity from "@/hooks/useDensity";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { errorReporter } from "@/lib/error-reporter";
import {
  createToastCoalescer,
  type ToastCoalescer,
} from "@/lib/toast-coalescer";
import { runScheduledCleanup } from "@/lib/localStorageCleanup";
import { migrateLegacyQueue } from "@/lib/migrateLegacyQueue";
import { useFocusRestoration } from "@/hooks/useFocusRestoration";
import { getLastSeenSeq, clearSeqTracker } from "@/lib/seq-tracker";
import { upsertMessagesInCache } from "@/lib/messages";
import { ACCOUNT_UNREFRESHABLE_TOAST_MESSAGE } from "@/lib/reconnectError";
import {
  buildReloginSearch,
  buildReloginToast,
  RELOGIN_EVENT,
  type ReloginRequest,
} from "@/lib/reloginLink";
import { signOut } from "@/lib/signOut";

export function App() {
  const { serverUrl, baseUrl, setServerUrl, clearServerUrl } = useServerUrl();
  // #2312: runtime Google SSO gate — the server reports `ssoEnabled` on /api/version
  // (derived from HAPI_GOOGLE_HANDOFF_SECRET). Supplied to LoginPrompt so the same
  // binary shows the Google button on cloud VMs and hides it on home instances.
  const { data: versionInfo } = useVersion();
  const ssoEnabled = versionInfo?.ssoEnabled === true;
  const {
    authSource,
    isLoading: isAuthSourceLoading,
    setAccessToken,
    clearAuth,
    isTelegram,
  } = useAuthSource(baseUrl);
  const {
    token,
    api,
    user,
    isLoading: isAuthLoading,
    error: authError,
    needsBinding,
    bind,
    refreshAuth,
  } = useAuth(authSource, baseUrl);
  const goBack = useAppGoBack();
  useFocusRestoration();
  const navigate = useNavigate();
  const pathname = useLocation({ select: location => location.pathname });
  const matchRoute = useMatchRoute();
  const [sseAuthError, setSseAuthError] = useState(false);

  // Initialize error reporter with base URL and live token getter
  const baseUrlRef2 = useRef(baseUrl);
  const tokenRef = useRef(token);
  baseUrlRef2.current = baseUrl;
  tokenRef.current = token;
  useEffect(() => {
    errorReporter.initialize({
      getBaseUrl: () => baseUrlRef2.current,
      getToken: () => tokenRef.current,
    });
  }, []);

  // Shared split-view state (#1043): the top-bar SplitScreen toggle in
  // BrandedFrame and the session-list panes (router.tsx) drive this one instance.
  const {
    isSplit,
    toggleSplit,
    canSplit,
    paneBView,
    setPaneView,
    resetSplitView,
    collapseToPaneB,
  } = useSplitViewContext();

  // Density preference (#1040): sets the global --row-padding-y CSS var app-wide,
  // before the user opens the Preferences section. Backed by the same module-level
  // store as the Preferences page, so a change there re-renders this instance too.
  useDensity();

  // #3280 (Split-view v2) — the route-aware split-toggle handler wired to the
  // BrandedFrame SplitScreen button. It is the SINGLE collapse/entry path now that
  // SessionsPage's collapse-to-last-active effect is deleted (Task 3):
  //   - toggle OFF on the pane host (`/sessions`): collapse-to-rightmost — route the
  //     surviving single view to pane B's content (Task 6, R7);
  //   - toggle OFF off the pane host (e.g. `/settings/*`): state-only collapse, no
  //     navigation (don't yank the user out of the page they're on);
  //   - toggle ON from a session-instance view (`/sessions/$sessionId`): seed pane A
  //     with that session, pane B with the list, then route to the pane host so the
  //     two panes render (Task 4, R8 — instance-level entry: seed-and-route);
  //   - toggle ON elsewhere: enter split normally.
  const handleSplitToggle = useCallback(() => {
    if (isSplit) {
      // Capture pane B's surviving view BEFORE the state mutation resets the panes.
      const surviving = paneBView;
      const onPaneHost = pathname === "/sessions";
      collapseToPaneB();
      if (onPaneHost) {
        if (surviving.type === "session") {
          navigate({
            to: "/sessions/$sessionId",
            params: { sessionId: surviving.sessionId },
          });
        } else if (surviving.type === "new-session") {
          navigate({ to: "/sessions/new" });
        }
        // type === "list" → stay on /sessions
      }
      return;
    }

    // Entering split. From a session-instance view, seed pane A with that session
    // and route to the pane host (instance-level entry, seed-and-route).
    const instanceMatch = pathname.match(/^\/sessions\/([^/]+)$/);
    const instanceSessionId =
      instanceMatch && instanceMatch[1] !== "new" ? instanceMatch[1] : null;
    if (instanceSessionId) {
      setPaneView("A", { type: "session", sessionId: instanceSessionId });
      setPaneView("B", { type: "list" });
      toggleSplit();
      navigate({ to: "/sessions" });
    } else {
      toggleSplit();
    }
  }, [
    isSplit,
    pathname,
    paneBView,
    collapseToPaneB,
    setPaneView,
    toggleSplit,
    navigate,
  ]);

  const handleSseAuthError = useCallback(async () => {
    const refreshed = await refreshAuth({ force: true });
    if (!refreshed) {
      setSseAuthError(true);
    }
    // If refreshed succeeds, the token change will re-trigger useSSE effect
  }, [refreshAuth]);

  // #4897: on a gateway-onboarded (SSO) instance, Sign Out also ends the hapimatic.com
  // session (gateway GET /logout → its sign-in entry); elsewhere it is the plain clearAuth.
  const handleSignOut = useCallback(() => {
    signOut({ ssoEnabled, clearAuth });
  }, [ssoEnabled, clearAuth]);

  const getSseToken = useCallback(() => token ?? "", [token]);

  // Clear SSE auth error when a valid token arrives
  useEffect(() => {
    if (token) {
      setSseAuthError(false);
    }
  }, [token]);

  useEffect(() => {
    const tg = getTelegramWebApp();
    tg?.ready();
    tg?.expand();
    initializeTheme();
  }, []);

  // Clean up stale localStorage entries on mount and when tab becomes visible
  useEffect(() => {
    runScheduledCleanup();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        runScheduledCleanup();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Issue #1325 / Task 18: one-shot legacy queue migration.
  // Migrates any in-flight `sessionStorage`-resident queues to the server.
  // Runs once when `api` first becomes available (post-auth). Partial failures
  // leave the legacy keys intact for retry on the next mount. The directive
  // listed `main.tsx` as the invocation site but main.tsx has no `api` until
  // `useAuth` resolves inside App.tsx — invoking here is the natural spot.
  const legacyQueueMigratedRef = useRef(false);
  useEffect(() => {
    if (!api || legacyQueueMigratedRef.current) return;
    legacyQueueMigratedRef.current = true;
    void migrateLegacyQueue(api)
      .then(result => {
        if (result.migrated > 0 || result.failed > 0) {
          console.info(
            `[migrateLegacyQueue] sessions=${result.sessionsProcessed} migrated=${result.migrated} failed=${result.failed}`
          );
        }
      })
      .catch(err => {
        console.warn("[migrateLegacyQueue] top-level failure:", err);
      });
  }, [api]);

  // Clear app badge when user returns to the app (iOS PWA home screen badge)
  useEffect(() => {
    if (!("clearAppBadge" in navigator)) return;

    const clearBadge = () => {
      if (document.visibilityState === "visible") {
        navigator.clearAppBadge().catch(() => {});
      }
    };

    // Clear badge immediately if app is already visible
    clearBadge();

    document.addEventListener("visibilitychange", clearBadge);
    return () => document.removeEventListener("visibilitychange", clearBadge);
  }, []);

  useEffect(() => {
    const preventDefault = (event: Event) => {
      event.preventDefault();
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      if (
        event.key === "+" ||
        event.key === "-" ||
        event.key === "=" ||
        event.key === "0"
      ) {
        event.preventDefault();
      }
    };

    document.addEventListener("gesturestart", preventDefault as EventListener, {
      passive: false,
    });
    document.addEventListener(
      "gesturechange",
      preventDefault as EventListener,
      { passive: false }
    );
    document.addEventListener("gestureend", preventDefault as EventListener, {
      passive: false,
    });

    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener(
        "gesturestart",
        preventDefault as EventListener
      );
      document.removeEventListener(
        "gesturechange",
        preventDefault as EventListener
      );
      document.removeEventListener(
        "gestureend",
        preventDefault as EventListener
      );

      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const tg = getTelegramWebApp();
    const backButton = tg?.BackButton;
    if (!backButton) return;

    if (pathname === "/" || pathname === "/sessions") {
      backButton.offClick(goBack);
      backButton.hide();
      return;
    }

    backButton.show();
    backButton.onClick(goBack);
    return () => {
      backButton.offClick(goBack);
      backButton.hide();
    };
  }, [goBack, pathname]);
  const queryClient = useQueryClient();
  const sessionMatch = matchRoute({ to: "/sessions/$sessionId" });
  const selectedSessionId = sessionMatch ? sessionMatch.sessionId : null;

  // Determine if back button should be shown in title bar
  // Show on any "detail" view - not the session list
  const isSessionView = Boolean(sessionMatch);
  const isNewSessionView = Boolean(matchRoute({ to: "/sessions/new" }));
  const isFilesView = Boolean(matchRoute({ to: "/sessions/$sessionId/files" }));
  const isFileView = Boolean(matchRoute({ to: "/sessions/$sessionId/file" }));
  const isTerminalView = Boolean(
    matchRoute({ to: "/sessions/$sessionId/terminal" })
  );
  const showBackButton =
    !isTelegram &&
    (isSessionView ||
      isNewSessionView ||
      isFilesView ||
      isFileView ||
      isTerminalView);

  const { isSyncing, startSync, endSync } = useSyncingState();
  const syncTokenRef = useRef(0);
  const isFirstConnectRef = useRef(true);
  const baseUrlRef = useRef(baseUrl);
  const pushPromptedRef = useRef(false);
  const {
    isSupported: isPushSupported,
    permission: pushPermission,
    requestPermission,
    subscribe,
    unsubscribe,
    refreshSubscription: refreshPushSubscription,
  } = usePushNotifications(api);

  // Issue #4836: mirror the notification preferences into the Cache Storage
  // entry the service worker reads on every app load. Before this only opening
  // Settings → Notifications (or toggling a preference) wrote it, so the SW's
  // opt-out check protected a device only after the user happened to open
  // Settings, and an evicted or pre-#4836 cache entry was never refreshed.
  useEffect(() => {
    void syncPreferencesToCache();
  }, []);

  useEffect(() => {
    if (baseUrlRef.current === baseUrl) {
      return;
    }
    baseUrlRef.current = baseUrl;
    isFirstConnectRef.current = true;
    syncTokenRef.current = 0;
    clearSeqTracker();
    queryClient.clear();
  }, [baseUrl, queryClient]);

  useEffect(() => {
    if (!api || !token) {
      pushPromptedRef.current = false;
      return;
    }
    if (isTelegramApp() || !isPushSupported) {
      return;
    }
    if (pushPromptedRef.current) {
      return;
    }
    pushPromptedRef.current = true;

    // Issue #4836: the browser permission stays `granted` after Settings →
    // Disable, so subscribing whenever it is granted re-subscribed on every
    // load and notifications resumed. reconcilePushOnLoad honors the per-origin
    // opt-out instead (never subscribe or prompt while set; drop a live
    // subscription). It reads the opt-out at run time, so a logout and re-login
    // in the same page (which resets pushPromptedRef) is covered too.
    void reconcilePushOnLoad({
      permission: pushPermission,
      readOptOut: readGlobalOptOut,
      requestPermission,
      subscribe,
      unsubscribe,
    });
  }, [
    api,
    isPushSupported,
    pushPermission,
    requestPermission,
    subscribe,
    token,
    unsubscribe,
  ]);

  const handleSseConnect = useCallback(() => {
    // Increment token to track this specific connection
    const token = ++syncTokenRef.current;

    // R2 (issue #1612): signal every SSE (re)connect so ToolErrorToastListener
    // opens a coalescing window — a reconnect-delivered tool-error backlog must
    // not flood the renderer with individual toasts (which tripped React #185).
    // handleSseConnect already fires on every initial connect + reconnect, so
    // this is the lowest-blast-radius hook point; useSSE.ts (which runs on every
    // federation node) is intentionally left untouched.
    window.dispatchEvent(new CustomEvent("hapi:sseConnected"));

    // Only force show banner on first connect (page load)
    // Subsequent connects (session switches) use non-forced mode
    // which only shows banner when returning from background
    if (isFirstConnectRef.current) {
      isFirstConnectRef.current = false;
      startSync({ force: true });
    } else {
      startSync();
    }

    // Backfill missed messages for the active session using seq tracking.
    // This recovers messages lost during SSE gaps (reconnect, subscription
    // transition, or network interruption).
    const backfillPromise =
      selectedSessionId && api
        ? (async () => {
            const lastSeq = getLastSeenSeq(selectedSessionId);
            if (lastSeq === null) return;
            try {
              const { messages } = await api.getMessagesAfter(
                selectedSessionId,
                lastSeq
              );
              if (messages.length > 0) {
                console.debug(
                  `[backfill] Recovered ${messages.length} message(s) for session ${selectedSessionId} after seq=${lastSeq}`
                );
                queryClient.setQueryData<InfiniteData<MessagesResponse>>(
                  queryKeys.messages(selectedSessionId),
                  data => upsertMessagesInCache(data, messages)
                );
              }
            } catch {
              // Backfill failed — fall through to invalidation below
            }
          })()
        : Promise.resolve();

    const invalidations = [
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
      ...(selectedSessionId
        ? [
            queryClient.invalidateQueries({
              queryKey: queryKeys.session(selectedSessionId),
            }),
            // Still invalidate messages to pick up any cache staleness,
            // but backfill above handles gap recovery specifically.
            queryClient.invalidateQueries({
              queryKey: queryKeys.messages(selectedSessionId),
              refetchType: "none",
            }),
            queryClient.invalidateQueries({
              queryKey: queryKeys.slashCommands(selectedSessionId),
            }),
          ]
        : []),
    ];
    Promise.all([backfillPromise, ...invalidations])
      .catch(error => {
        console.error("Failed to sync on SSE connect:", error);
      })
      .finally(() => {
        // Only end sync if this is still the latest connection
        if (syncTokenRef.current === token) {
          endSync();
        }
      });
  }, [queryClient, selectedSessionId, startSync, endSync, api]);

  const handleSseEvent = useCallback(() => {}, []);

  // Always subscribe to all events to eliminate the SSE reconnection gap
  // that occurs when switching between session list and session detail views.
  // The server's shouldSend() filter + client-side handleSyncEvent routing
  // ensure messages reach the correct per-session cache.
  const eventSubscription = useMemo(() => ({ all: true }), []);

  useSSE({
    enabled: Boolean(api && token),
    token: token ?? "",
    baseUrl,
    subscription: eventSubscription,
    onConnect: handleSseConnect,
    onEvent: handleSseEvent,
    onAuthError: handleSseAuthError,
    getToken: getSseToken,
  });

  // Issue #2854: bounded full-reload fallback when the SSE stays wedged after
  // an offline→online transition (the primary state-preserving reconnect lives
  // in useSSE). No UI — observes the same online/SSE lifecycle as the banners.
  usePwaRecovery();

  // Loading auth source
  if (isAuthSourceLoading) {
    return (
      <BrandedFrame>
        <div className="h-full flex items-center justify-center p-4">
          <LoadingState label="Loading…" className="text-sm" />
        </div>
      </BrandedFrame>
    );
  }

  // No auth source (browser environment, not logged in)
  if (!authSource) {
    return (
      <BrandedFrame>
        <LoginPrompt
          onLogin={setAccessToken}
          baseUrl={baseUrl}
          serverUrl={serverUrl}
          setServerUrl={setServerUrl}
          clearServerUrl={clearServerUrl}
          ssoEnabled={ssoEnabled}
        />
      </BrandedFrame>
    );
  }

  if (needsBinding) {
    return (
      <BrandedFrame>
        <LoginPrompt
          mode="bind"
          onBind={bind}
          baseUrl={baseUrl}
          serverUrl={serverUrl}
          setServerUrl={setServerUrl}
          clearServerUrl={clearServerUrl}
          error={authError ?? undefined}
          ssoEnabled={ssoEnabled}
        />
      </BrandedFrame>
    );
  }

  // Authenticating (also covers the gap before useAuth effect starts)
  if (isAuthLoading || (authSource && !token && !authError)) {
    return (
      <BrandedFrame>
        <div className="h-full flex items-center justify-center p-4">
          <LoadingState label="Authorizing…" className="text-sm" />
        </div>
      </BrandedFrame>
    );
  }

  // Auth error
  if (authError || !token || !api) {
    // If using access token and auth failed, show login again
    if (authSource.type === "accessToken") {
      return (
        <BrandedFrame>
          <LoginPrompt
            onLogin={setAccessToken}
            baseUrl={baseUrl}
            serverUrl={serverUrl}
            setServerUrl={setServerUrl}
            clearServerUrl={clearServerUrl}
            error={authError ?? "Authentication failed"}
            ssoEnabled={ssoEnabled}
          />
        </BrandedFrame>
      );
    }

    // Telegram auth failed
    return (
      <BrandedFrame>
        <div className="p-4 space-y-3">
          <div className="text-base font-semibold">Hapimatic</div>
          <div className="text-sm text-red-600">
            {authError ?? "Not authorized"}
          </div>
          <div className="text-xs text-[var(--app-hint)]">
            Open this page from Telegram using the bot's "Open App" button (not
            "Open in browser").
          </div>
        </div>
      </BrandedFrame>
    );
  }

  return (
    <ToastProvider>
      <ToolErrorToastListener />
      <ApiErrorToastListener />
      <PromptBlockToastListener />
      <ErrorOutboxDropToastListener />
      <AccountUnrefreshableToastListener />
      <ReloginLinkListener />
      <SessionRestartFailedToastListener />
      <LoopsResumingToastListener />
      <WaitingForSlotToastListener />
      <AppContextProvider
        value={{
          api,
          token,
          onLogout: isTelegram ? undefined : handleSignOut,
          refreshPushSubscription,
          user,
        }}
      >
        <ExtensionHostProvider>
          {/* #3638: lifts SessionChat's full-screen flag up to BrandedFrame so
              the app bar can hide in single-view page mode. */}
          <ThreadFullscreenProvider>
            <BrandedFrame
              showBackButton={showBackButton}
              onBack={goBack}
              onSplitToggle={handleSplitToggle}
              isSplitActive={isSplit}
              canSplit={canSplit}
              onWordmarkReset={resetSplitView}
            >
              <SyncingBanner isSyncing={isSyncing} />
              <OfflineBanner />
              {/* #4897: re-authentication to THIS instance, not sign-out — stays
                  clearAuth (the sign-in page keeps the Google ?return= hint); never
                  the gateway /logout. */}
              <AuthErrorBanner visible={sseAuthError} onLogin={clearAuth} />
              <ErrorBoundary>
                <div className="h-full flex flex-col">
                  <Outlet />
                </div>
              </ErrorBoundary>
            </BrandedFrame>
          </ThreadFullscreenProvider>
          <InstallPrompt />
          <SettingsDrawer />
          {/* #3865: the in-app first-run tour — one app-level host (auto-present
              over /sessions while the node-local state is pending; Settings
              re-entry via the hapi:onboarding-open window event). */}
          <OnboardingHost />
        </ExtensionHostProvider>
      </AppContextProvider>
    </ToastProvider>
  );
}

// Tool-error toast coalescing constants (issue #1612). Starting values —
// tunable; the failure mode is a cosmetically over/under-suppressed
// informational toast (no data/security impact).
const TOOL_ERROR_COALESCE_THRESHOLD = 3; // mirrors error-reporter DROP_TOAST_THRESHOLD
const TOOL_ERROR_COALESCE_WINDOW_MS = 1000; // the AC's "<1s" burst definition
const TOOL_ERROR_SUMMARY_DEDUP_MS = 2000; // mirrors Toast DEDUP_WINDOW_MS
const TOOL_ERROR_RECONNECT_SUPPRESS_MS = 2500; // covers the observed ~1.1s burst + margin

/**
 * Bridges `hapi:toolError` CustomEvents (dispatched by useSSE for tool-error
 * SyncEvents) to the Toast system. Lives inside ToastProvider so useToast()
 * resolves to a real provider.
 *
 * Issue #1612: a burst of tool-error events (e.g. a backlog delivered on SSE
 * reconnect from a chatty session) is coalesced into a single "N tool errors"
 * summary toast instead of one toast per event, known-benign classes are
 * filtered out, and a short post-reconnect window suppresses individual toasts
 * — so the volume can no longer crash the web app with React #185.
 */
function ToolErrorToastListener() {
  const { showToast } = useToast();
  const coalescerRef = useRef<ToastCoalescer | null>(null);
  const coalescer =
    coalescerRef.current ??
    (coalescerRef.current = createToastCoalescer({
      threshold: TOOL_ERROR_COALESCE_THRESHOLD,
      windowMs: TOOL_ERROR_COALESCE_WINDOW_MS,
      summaryDedupMs: TOOL_ERROR_SUMMARY_DEDUP_MS,
    }));
  const suppressUntilRef = useRef(0);

  // R2: on every SSE (re)connect, open a coalescing window and suppress
  // individual tool-error toasts for a short window so a reconnect-delivered
  // backlog can never flood the renderer.
  useEffect(() => {
    const onConnect = () => {
      const now = Date.now();
      suppressUntilRef.current = now + TOOL_ERROR_RECONNECT_SUPPRESS_MS;
      coalescer.forceSummaryWindow(now);
    };
    window.addEventListener("hapi:sseConnected", onConnect);
    return () => window.removeEventListener("hapi:sseConnected", onConnect);
  }, [coalescer]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          toolName?: string;
          errorContent?: string;
        }>
      ).detail;
      if (!detail?.toolName || typeof detail.errorContent !== "string") return;

      const content = detail.errorContent;
      // R5: drop known-benign tool-error classes before counting/toasting.
      // Keep this set minimal + commented — over-filtering hides real errors.
      if (
        // Hook guard working as designed (e.g. a blocked Bash command).
        content.includes("Permission denied for Bash") ||
        // Read/Bash routing mistakes — not a real tool failure.
        content.includes("No such tool available")
      ) {
        return;
      }

      const now = Date.now();
      const decision = coalescer.record(now);

      // R2: during the post-reconnect window, never emit an individual toast.
      if (decision.action === "individual" && now < suppressUntilRef.current) {
        return;
      }
      if (decision.action === "silent") return;

      if (decision.action === "summary") {
        const n = decision.count;
        showToast(`${n} tool error${n === 1 ? "" : "s"}`, {
          type: "warning",
          duration: 5000,
        });
        return;
      }

      // Individual toast (R4: unchanged behavior below the burst threshold).
      const MAX = 120;
      const truncated =
        content.length > MAX ? content.slice(0, MAX) + "…" : content;
      showToast(`${detail.toolName}: ${truncated}`, {
        type: "warning",
        duration: 5000,
      });
    };
    window.addEventListener("hapi:toolError", handler);
    return () => window.removeEventListener("hapi:toolError", handler);
  }, [showToast, coalescer]);
  return null;
}

/**
 * Bridges `hapi:promptBlocked` CustomEvents (dispatched by useSSE for
 * prompt-blocked SyncEvents) to the Toast system. Sibling of
 * ToolErrorToastListener. Issue #1348.
 */
function PromptBlockToastListener() {
  const { showToast } = useToast();
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          hookEvent?: string;
          blockedReason?: string;
          originalPrompt?: string;
          title?: string;
        }>
      ).detail;
      if (!detail?.hookEvent || typeof detail.blockedReason !== "string") {
        return;
      }
      const MAX = 160;
      const truncated =
        detail.blockedReason.length > MAX
          ? detail.blockedReason.slice(0, MAX) + "…"
          : detail.blockedReason;
      // #3579: prefer the catalogue title (no gate jargon, R7); the second,
      // catalogue-less producer (routes/cli.ts) omits it and degrades to today's
      // text.
      showToast(
        detail.title ?? `${detail.hookEvent} hook blocked: ${truncated}`,
        {
          type: "warning",
          duration: 5000,
        }
      );
    };
    window.addEventListener("hapi:promptBlocked", handler);
    return () => window.removeEventListener("hapi:promptBlocked", handler);
  }, [showToast]);
  return null;
}

/**
 * Bridges `hapi:errorOutboxDropped` CustomEvents (dispatched by error-reporter
 * when its outbox drop counter crosses the threshold during a sustained
 * partition) to the Toast system. Issue #1225.
 */
function ErrorOutboxDropToastListener() {
  const { showToast } = useToast();
  useEffect(() => {
    const handler = () => {
      showToast(
        "Some diagnostic reports could not be sent — they're queued for retry.",
        { type: "warning", duration: 5000 }
      );
    };
    window.addEventListener("hapi:errorOutboxDropped", handler);
    return () => window.removeEventListener("hapi:errorOutboxDropped", handler);
  }, [showToast]);
  return null;
}

/**
 * Bridges `hapi:accountUnrefreshable` CustomEvents (dispatched by useSSE for
 * account-unrefreshable SyncEvents) to the Toast system. Sibling of
 * ToolErrorToastListener / PromptBlockToastListener. Issue #1531.
 *
 * "Actionable" is delivered as guidance text — the Toast component is text-only,
 * so the toast directs the user to the existing re-login surface (the account
 * menu in the session header) rather than rendering a button. The affected
 * accountUuid is carried in the CustomEvent detail for future enhancement.
 */
function AccountUnrefreshableToastListener() {
  const { showToast } = useToast();
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeId?: string; nodeLabel?: string }>)
        .detail;
      // Issue #4461 (R8): a server-stamped event names its node — build the toast
      // with the SAME builder (and no account name) the HTTP reconnect 409 uses,
      // so the SSE+HTTP pair stays byte-identical, ToastProvider dedups it into
      // ONE toast, and that toast carries the "Log in" action whichever side
      // fired first. An unstamped event (a pre-#4461 node) keeps the shared
      // #1835 message, matching the HTTP side for a node-less 409.
      if (detail?.nodeId && detail.nodeLabel) {
        const { message, action } = buildReloginToast({
          nodeId: detail.nodeId,
          nodeLabel: detail.nodeLabel,
        });
        showToast(message, { type: "warning", duration: 5000, action });
        return;
      }
      showToast(ACCOUNT_UNREFRESHABLE_TOAST_MESSAGE, {
        type: "warning",
        duration: 5000,
      });
    };
    window.addEventListener("hapi:accountUnrefreshable", handler);
    return () =>
      window.removeEventListener("hapi:accountUnrefreshable", handler);
  }, [showToast]);
  return null;
}

/**
 * Issue #4461 (R9): turns a `hapi:relogin` request (the "Log in" action on an
 * account_unrefreshable toast, and #4466's red-ring tap) into a navigation to
 * the Accounts page's deep link, `/settings/account-usage?relogin=<provider>
 * &node=<nodeId>`. The page decides what this UI can do for that node (D-A1 = A).
 */
function ReloginLinkListener() {
  const navigate = useNavigate();
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ReloginRequest>).detail;
      if (!detail?.nodeId) return;
      void navigate({
        to: "/settings/account-usage",
        search: buildReloginSearch(detail),
      });
    };
    window.addEventListener(RELOGIN_EVENT, handler);
    return () => window.removeEventListener(RELOGIN_EVENT, handler);
  }, [navigate]);
  return null;
}

/**
 * Bridges `hapi:sessionRestartFailed` CustomEvents (dispatched by useSSE for
 * session-restart-failed SyncEvents) to the Toast system. Sibling of
 * AccountUnrefreshableToastListener. Issue #1532.
 *
 * Distinct from account-unrefreshable (#1531, "re-login required"): here the
 * account is healthy and the session is RECONNECTABLE — so the toast directs
 * the user to reconnect from the session list rather than to re-login.
 */
function SessionRestartFailedToastListener() {
  const { showToast } = useToast();
  useEffect(() => {
    const handler = () => {
      showToast(
        "A session disconnected after a token refresh and couldn't restart " +
          "automatically. Reconnect it from the session list to resume.",
        { type: "warning", duration: 5000 }
      );
    };
    window.addEventListener("hapi:sessionRestartFailed", handler);
    return () =>
      window.removeEventListener("hapi:sessionRestartFailed", handler);
  }, [showToast]);
  return null;
}

/**
 * Bridges `hapi:loopsResuming` CustomEvents (dispatched by useSSE for
 * loops-resuming SyncEvents) to the Toast system (issue #2453, Task 14 / R6).
 * Shown when a reconnect auto-resumes the loop-cron loops that were auto-paused
 * on disconnect. Sibling of SessionRestartFailedToastListener.
 *
 * Placement (D4): the app's standard bottom-center toast stack. The mockup's
 * badge-anchored placement is an accepted deviation — the Toast primitive has no
 * per-caller position channel.
 */
function LoopsResumingToastListener() {
  const { showToast } = useToast();
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ count: number; pausedAtMs: number }>)
        .detail;
      if (!detail || detail.count <= 0) return;
      const when = new Date(detail.pausedAtMs).toLocaleTimeString();
      const n = detail.count;
      showToast(
        `${n} scheduled ${n === 1 ? "job" : "jobs"} resuming — paused on disconnect ${when}`,
        { type: "info", duration: 5000 }
      );
    };
    window.addEventListener("hapi:loopsResuming", handler);
    return () => window.removeEventListener("hapi:loopsResuming", handler);
  }, [showToast]);
  return null;
}

/**
 * Bridges `hapi:waitingForSlot` CustomEvents (dispatched by useSSE for
 * waiting-for-slot SyncEvents) to the Toast system (issue #2301, Task 5 / R4).
 * Shown when a reconnect or account-switch spawn hits the concurrency cap and is
 * polling for a free slot. Advisory — reassures the user the operation is
 * in-progress (retrying automatically) rather than a silent stall. Sibling of
 * LoopsResumingToastListener.
 *
 * Copy coordinated with #2300 (GAP-2, shared copy not shared transport): #2300's
 * terminal capacity ERROR ("instance at capacity") rides the HTTP error path; this
 * in-progress status is the SSE toast — the two read as one coherent capacity
 * indicator.
 */
function WaitingForSlotToastListener() {
  const { showToast } = useToast();
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          context?: "account-switch" | "reconnect";
          elapsedMs?: number;
          deadlineMs?: number;
        }>
      ).detail;
      const verb =
        detail?.context === "account-switch" ? "Account switch" : "Reconnect";
      showToast(
        `${verb} is waiting for a free session slot… (instance at capacity — retrying automatically)`,
        { type: "info", duration: 6000 }
      );
    };
    window.addEventListener("hapi:waitingForSlot", handler);
    return () => window.removeEventListener("hapi:waitingForSlot", handler);
  }, [showToast]);
  return null;
}
