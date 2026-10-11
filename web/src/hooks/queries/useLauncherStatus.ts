// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";

/**
 * Launcher status fetched from `GET /api/launcher/status`.
 *
 * The badge in `BrandedFrame` reads this hook to surface the active Claude
 * launcher kind (sdk | pty | tmux) so operators have visibility even when no
 * Claude session is currently running. This is the load-bearing piece of the
 * anxiety scenario from issue #1314 — a broken launcher must not prevent the
 * operator from seeing what's set.
 *
 * Polling cadence (30s) matches the existing version-style polling pattern.
 * Returns a safe fallback shape on fetch failure so the UI never crashes.
 */

export type ClaudeRemoteLauncherKind = "sdk" | "pty" | "tmux";
export type LauncherSource = "env" | "settings" | "default";

export interface LauncherStatus {
  kind: ClaudeRemoteLauncherKind;
  source: LauncherSource;
  rejected: boolean;
  rejectedValue: string | null;
  dependencies: { claude: boolean; tmux?: boolean };
}

const FALLBACK: LauncherStatus = {
  kind: "sdk",
  source: "default",
  rejected: false,
  rejectedValue: null,
  dependencies: { claude: false },
};

export function useLauncherStatus() {
  return useQuery<LauncherStatus>({
    queryKey: ["launcher", "status"],
    queryFn: async () => {
      const res = await fetch("/api/launcher/status");
      if (!res.ok) return FALLBACK;
      return (await res.json()) as LauncherStatus;
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false,
  });
}
