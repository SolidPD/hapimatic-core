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
import { NotificationListener } from "@/components/NotificationListener";
import { RemoteSpawnFailedToastListener } from "@/components/RemoteSpawnFailedToastListener";
import { ReloginLinkListener } from "@/components/ReloginLinkListener";
import { SettingsDrawer } from "@/components/SettingsDrawer";
import { OnboardingHost } from "@/components/onboarding/OnboardingHost";
import { BackupFirstRunPrompt } from "@/components/backup/BackupFirstRunPrompt";
import { useSplitViewContext } from "@/lib/split-view-context";
import useDensity from "@/hooks/useDensity";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { errorReporter } from "@/lib/error-reporter";
import { runScheduledCleanup } from "@/lib/localStorageCleanup";
import { migrateLegacyQueue } from "@/lib/migrateLegacyQueue";
import { useFocusRestoration } from "@/hooks/useFocusRestoration";
import { getLastSeenSeq, clearSeqTracker } from "@/lib/seq-tracker";
import { upsertMessagesInCache } from "@/lib/messages";
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

    // R2 (issue #1612): signal every SSE (re)connect so NotificationListener
    // opens its suppression window — a reconnect-delivered notification backlog
    // must not flood the renderer with toasts (which tripped React #185) — and
    // usePwaRecovery sees the stream recover.
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
      {/* #4915: the one Lane 2 listener — inbox cache, unread count, and the
          rate-limited pop-up for every `notification` SyncEvent. */}
      <NotificationListener api={api} />
      <ErrorOutboxDropToastListener />
      <ReloginLinkListener />
      {/* #2150: a remote spawn that fails or times out after the node accepted it */}
      <RemoteSpawnFailedToastListener />
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
          {/* #4791: the first-run "save your backup key" step — one app-level
              host, presented over /sessions after launch; it waits for the tour
              above (contract LC6: hapi:onboarding-open / hapi:backup-prompt-*). */}
          <BackupFirstRunPrompt />
        </ExtensionHostProvider>
      </AppContextProvider>
    </ToastProvider>
  );
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
