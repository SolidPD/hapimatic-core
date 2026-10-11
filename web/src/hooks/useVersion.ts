// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";

export interface VersionInfo {
  version: string;
  timestamp: string;
  /** Daemon-user home directory — the Create page's Directory fallback (#2269 F18).
   * Optional so an older server that doesn't send it degrades cleanly. */
  defaultDirectory?: string;
  /** Runtime Google SSO gate (#2312) — true when the instance can complete the Google
   * handoff (server-side `HAPI_GOOGLE_HANDOFF_SECRET` set). Consumed by LoginPrompt to
   * show/hide the "Sign in with Google" button. Optional so an older server (or the
   * error-fallback response) degrades cleanly to `undefined` → button hidden. */
  ssoEnabled?: boolean;
  /** Whether this instance can serve a web desktop (#2693 Decision A: Pro-and-up
   * cloud VM tier). Consumed by the View Picker to grey the Desktop tab on a home
   * instance (epic #3285 correction pass 1). Optional so an older server degrades
   * to the pre-correction active-only gate. */
  desktopEligible?: boolean;
}

export function useVersion() {
  return useQuery<VersionInfo>({
    queryKey: ["version"],
    queryFn: async () => {
      const res = await fetch("/api/version");
      if (!res.ok) {
        return { version: "?.?.?", timestamp: "" };
      }
      return res.json();
    },
    staleTime: Infinity, // Never refetch during session
    retry: false,
  });
}
