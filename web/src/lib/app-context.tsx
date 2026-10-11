// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "@/api/client";
import type { AuthResponse } from "@/types/api";

type AppContextValue = {
  api: ApiClient;
  token: string;
  onLogout?: () => void;
  /**
   * Refresh the app-level push-subscription state (App.tsx's own
   * `usePushNotifications` instance). Exposed so the settings drawer
   * `?section=notifications` view can refresh the top-bar bell on unmount —
   * a section-local hook instance would be a no-op for the bell (issue #1038).
   */
  refreshPushSubscription?: () => Promise<void>;
  user?: AuthResponse["user"] | null;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppContextProvider(props: {
  value: AppContextValue;
  children: ReactNode;
}) {
  return (
    <AppContext.Provider value={props.value}>
      {props.children}
    </AppContext.Provider>
  );
}

export function useAppContext(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("AppContext is not available");
  }
  return context;
}

/**
 * Non-throwing variant of {@link useAppContext} (issue #2664). Returns null when
 * called OUTSIDE an AppContextProvider (the login / loading / auth-error
 * BrandedFrame renders mount before the provider). The global feedback button
 * uses this so it renders ONLY on authenticated routes and never crashes the
 * unauthenticated app shell.
 */
export function useOptionalAppContext(): AppContextValue | null {
  return useContext(AppContext);
}
