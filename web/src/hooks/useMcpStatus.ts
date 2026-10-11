// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Sentry from "@sentry/react";
import { useAppContext } from "@/lib/app-context";
import { errorReporter } from "@/lib/error-reporter";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/components/Toast";
import type {
  McpServerStatus,
  McpStatusResponse,
  McpToggleErrorCode,
  McpToggleResponse,
} from "@/types/api";

export type McpToggleArgs = {
  sessionId: string;
  serverName: string;
  enabled: boolean;
};

export type McpServerError = {
  message: string;
  code: McpToggleErrorCode;
};

export type UseMcpStatusReturn = {
  servers: McpServerStatus[];
  isLoading: boolean;
  hasFailures: boolean;
  connectedCount: number;
  hostedCount: number;
  failedCount: number;
  needsAuthCount: number;
  unknownCount: number;
  pendingApprovalCount: number;
  disabledServers: string[];
  disabledCount: number;
  totalCount: number;
  checkedAt: string | null;
  refresh: () => void;
  isRefreshing: boolean;
  toggle: (args: McpToggleArgs) => Promise<McpToggleResponse>;
  pendingToggles: ReadonlySet<string>;
  perServerErrors: ReadonlyMap<string, McpServerError>;
  clearServerError: (serverName: string) => void;
};

export function useMcpStatus(projectDir?: string | null): UseMcpStatusReturn {
  const { api } = useAppContext();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const { data, isLoading } = useQuery<McpStatusResponse>({
    queryKey: queryKeys.mcpStatus(projectDir ?? undefined),
    queryFn: () => api.getMcpStatus(projectDir ?? undefined),
    refetchInterval: 5 * 60 * 1000, // 5 minutes fallback
    staleTime: 60 * 1000, // 1 minute
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshMcpStatus(projectDir ?? undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.mcpStatus(projectDir ?? undefined),
      });
    },
    onError: err => {
      // R3: user-clicked refresh that fails was previously silent — the click
      // appeared to do nothing. Surface to all three channels: server error
      // log, Sentry, and a user-visible Toast.
      const message =
        err instanceof Error ? err.message : "Unknown refresh failure";
      errorReporter.report({
        message,
        stack: err instanceof Error ? (err.stack ?? null) : null,
        category: "mcp-refresh-failure",
        severity: "warn",
        context: JSON.stringify({ projectDir: projectDir ?? null }),
      });
      Sentry.captureException(err, {
        contexts: {
          mcp: { projectDir: projectDir ?? null, action: "refresh" },
        },
      });
      showToast("Failed to refresh MCP status", { type: "error" });
    },
  });

  const [pendingToggles, setPendingToggles] = useState<Set<string>>(
    () => new Set()
  );
  const [perServerErrors, setPerServerErrors] = useState<
    Map<string, McpServerError>
  >(() => new Map());

  const toggleMutation = useMutation<McpToggleResponse, Error, McpToggleArgs>({
    mutationFn: async args => {
      return await api.toggleMcpServer(
        args.sessionId,
        args.serverName,
        args.enabled
      );
    },
    onMutate: args => {
      setPendingToggles(prev => {
        const next = new Set(prev);
        next.add(args.serverName);
        return next;
      });
      // Clear any prior error for this server when retrying
      setPerServerErrors(prev => {
        if (!prev.has(args.serverName)) return prev;
        const next = new Map(prev);
        next.delete(args.serverName);
        return next;
      });
    },
    onSuccess: async (result, args) => {
      if (result.ok) {
        // Fast-forward refresh — daemon poller is the slow path.
        // SSE invalidation will follow when the new state lands.
        try {
          await api.refreshMcpStatus(projectDir ?? undefined);
        } catch (err) {
          // R6: same silent-failure pattern as R3 lived here too — was just
          // a console.warn. Toggle itself succeeded; only the optimistic
          // re-fetch failed and SSE will reconcile, so no Toast (would be
          // noise). Reporting goes to error_logs only.
          errorReporter.report({
            message:
              err instanceof Error
                ? err.message
                : "Unknown post-toggle refresh failure",
            stack: err instanceof Error ? (err.stack ?? null) : null,
            category: "mcp-post-toggle-refresh-failure",
            severity: "warn",
            context: JSON.stringify({
              projectDir: projectDir ?? null,
              serverName: args.serverName,
            }),
          });
        }
        void queryClient.invalidateQueries({
          queryKey: queryKeys.mcpStatus(projectDir ?? undefined),
        });
      } else {
        // Server returned a structured failure (e.g., 501 local_mode_not_supported).
        // Caller (StatusBar) decides whether to surface as a per-row error or a banner.
        // Per-row errors are tracked here for non-banner codes.
        if (result.code !== "local_mode_not_supported") {
          setPerServerErrors(prev => {
            const next = new Map(prev);
            next.set(args.serverName, {
              message: result.error,
              code: result.code,
            });
            return next;
          });
        }
      }
    },
    onError: (err, args) => {
      // Transport-level error (network, timeout, etc.) — record as a per-row error
      const message =
        err instanceof Error ? err.message : "Unknown toggle failure";
      setPerServerErrors(prev => {
        const next = new Map(prev);
        next.set(args.serverName, { message, code: "unknown" });
        return next;
      });
    },
    onSettled: (_result, _err, args) => {
      setPendingToggles(prev => {
        if (!prev.has(args.serverName)) return prev;
        const next = new Set(prev);
        next.delete(args.serverName);
        return next;
      });
    },
  });

  const clearServerError = useCallback((serverName: string) => {
    setPerServerErrors(prev => {
      if (!prev.has(serverName)) return prev;
      const next = new Map(prev);
      next.delete(serverName);
      return next;
    });
  }, []);

  const servers = data?.servers ?? [];
  const disabledServers = data?.disabledServers ?? [];
  const connectedCount = servers.filter(s => s.status === "connected").length;
  const hostedCount = servers.filter(s => s.status === "hosted").length;
  const failedCount = servers.filter(s => s.status === "failed").length;
  const needsAuthCount = servers.filter(s => s.status === "needs_auth").length;
  // #2142: extended status union — surfaced so nothing is silently uncounted.
  const unknownCount = servers.filter(s => s.status === "unknown").length;
  const pendingApprovalCount = servers.filter(
    s => s.status === "pending_approval"
  ).length;

  return {
    servers,
    isLoading,
    hasFailures: failedCount > 0 || needsAuthCount > 0,
    connectedCount,
    hostedCount,
    failedCount,
    needsAuthCount,
    unknownCount,
    pendingApprovalCount,
    disabledServers,
    disabledCount: disabledServers.length,
    totalCount: servers.length,
    checkedAt: data?.checkedAt ?? null,
    refresh: () => refreshMutation.mutate(),
    isRefreshing: refreshMutation.isPending,
    toggle: args => toggleMutation.mutateAsync(args),
    pendingToggles,
    perServerErrors,
    clearServerError,
  };
}
