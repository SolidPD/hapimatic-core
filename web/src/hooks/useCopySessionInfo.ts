// SPDX-License-Identifier: AGPL-3.0-only
/**
 * useCopySessionInfo — the session kebab's "Copy Session Info" entry (issue
 * #4480). Writes the `HAPImatic Session Info v1` block (built by the pure
 * shared `buildSessionInfoText`) to the clipboard.
 *
 * iOS / WebKit only allows a clipboard write inside the tap's user-activation
 * window, so the tap path is SYNCHRONOUS up to `copy(text)`: it reads only data
 * already in memory (the surface's session + React Query cache) and makes no
 * network request. To make the cache useful, the kebab's OPEN event prefetches
 * the full session record (a list card holds only the `SessionSummary`
 * projection) and the MCP status. A tap that beats the prefetch still copies —
 * Effort / Safe Mode / Output Style / Session Role print `—`, and Model may show
 * the summary's mode or resolved model instead of the pinned raw model
 * (operator ruling C-3: A). Whether a record is "full" is derived from the data
 * (`seq` exists only on a full `Session`), never trusted from the caller, so a
 * summary-shaped fallback response prints `—` rather than a confident value.
 */
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  buildSessionInfoText,
  type SessionInfoBranch,
} from "@hapi/protocol/sessionInfoText";
import type { ApiClient } from "@/api/client";
import type {
  McpStatusResponse,
  Session,
  SessionResponse,
  SessionSummary,
} from "@/types/api";
import type { CurrentIssue } from "@/types/github";
import type { VersionInfo } from "@/hooks/useVersion";
import { queryKeys } from "@/lib/query-keys";
import {
  getCliDisplayName,
  getLauncherDisplayLabel,
  resolveNativeSessionId,
} from "@/lib/sessionHelpers";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useToast } from "@/components/Toast";
import { useSessionAccountEmail } from "@/hooks/queries/useSessionAccountEmail";

/**
 * The surface's branch-row state, mirroring `SessionBranchRow`: detached →
 * "Detached HEAD", a branch name, a "not a git" error → No Git, else unknown
 * (still retrieving, or retrieval failed).
 */
export function toSessionInfoBranch(args: {
  isDetached: boolean;
  branchName: string | null;
  branchError: string | null | undefined;
}): SessionInfoBranch {
  if (args.isDetached) return { kind: "detached" };
  if (args.branchName) return { kind: "name", name: args.branchName };
  if (args.branchError?.toLowerCase().includes("not a git")) {
    return { kind: "no-git" };
  }
  return { kind: "unknown" };
}

export type UseCopySessionInfoArgs = {
  api: ApiClient | null;
  /** The surface's session: the full record (header) or a list summary. */
  session: Session | SessionSummary;
  /** True when `session` is the full `Session` record (instance header). */
  isFullRecord: boolean;
  /** The surface title (`getSessionTitle`). */
  sessionName: string;
  nodeId?: string;
  nodeLabel?: string;
  nodeUrl?: string;
  branch: SessionInfoBranch;
  linkedIssue: CurrentIssue | null;
  /** The surface's message-count badge value. */
  messageCount?: number;
  /** The surface's effective thinking flag (drives Status and the live Thinking Time segment). */
  effectiveThinking: boolean;
};

export function useCopySessionInfo({
  api,
  session,
  isFullRecord,
  sessionName,
  nodeId,
  nodeLabel,
  nodeUrl,
  branch,
  linkedIssue,
  messageCount,
  effectiveThinking,
}: UseCopySessionInfoArgs): {
  onCopySessionInfo: () => void;
  onKebabOpenChange: (open: boolean) => void;
} {
  const queryClient = useQueryClient();
  const { copy } = useCopyToClipboard();
  const { showToast } = useToast();
  // The ONE account rule every account surface reads (React Query dedupes).
  const { email: accountEmail } = useSessionAccountEmail(api, session, nodeId);

  const sessionId = session.id;
  const projectDir = session.metadata?.path || undefined;

  const onKebabOpenChange = useCallback(
    (open: boolean) => {
      if (!open || !api) return;
      if (!isFullRecord) {
        void queryClient
          .prefetchQuery({
            queryKey: queryKeys.session(sessionId),
            queryFn: () => api.getSession(sessionId),
          })
          .catch(() => {});
      }
      void queryClient
        .prefetchQuery({
          queryKey: queryKeys.mcpStatus(projectDir),
          queryFn: () => api.getMcpStatus(projectDir),
          staleTime: 60_000,
        })
        .catch(() => {});
    },
    [api, isFullRecord, projectDir, queryClient, sessionId]
  );

  const onCopySessionInfo = useCallback(() => {
    // Everything below up to `copy(text)` is synchronous — no await, no fetch.
    const cachedFull = isFullRecord
      ? undefined
      : queryClient.getQueryData<SessionResponse>(queryKeys.session(sessionId))
          ?.session;
    const src: Session | SessionSummary = cachedFull ?? session;
    // Derived from the data: a degraded node proxy can return a summary inside
    // the `{ session }` envelope, and only a full `Session` carries `seq`.
    const fullRecord = typeof (src as Partial<Session>).seq === "number";

    const mcp = queryClient.getQueryData<McpStatusResponse>(
      queryKeys.mcpStatus(projectDir)
    );
    // `checkedAt: null` = the server has no status yet; print unknown, not "none".
    const mcpEnabled =
      mcp && mcp.checkedAt != null
        ? mcp.servers
            .map(server => server.name)
            .filter(name => !(mcp.disabledServers ?? []).includes(name))
        : undefined;
    const version = queryClient.getQueryData<VersionInfo>(["version"]);
    const { descriptor, nativeId } = resolveNativeSessionId(src);

    const text = buildSessionInfoText(src, {
      origin: window.location.origin,
      sessionName,
      harnessLabel: getCliDisplayName(src),
      launcherLabel: getLauncherDisplayLabel(src.metadata?.launcherKind),
      nativeId,
      hasNativeId: descriptor.mode === "native",
      accountEmail,
      nodeId,
      nodeLabel,
      nodeUrl,
      branch,
      linkedIssue: linkedIssue
        ? {
            number: linkedIssue.number,
            title: linkedIssue.title,
            url: linkedIssue.url,
          }
        : null,
      messageCount,
      mcpEnabled,
      appVersion:
        version?.version && version.version !== "?.?.?"
          ? version.version
          : undefined,
      nowMs: Date.now(),
      isThinking: effectiveThinking,
      isFullRecord: fullRecord,
    });

    // `copy` calls navigator.clipboard.writeText before its first await, so the
    // write stays inside the tap gesture. (Never `copy(text).then`: the global
    // test mock returns undefined.)
    void (async () => {
      if (await copy(text)) {
        showToast("Session info copied", { type: "success" });
      }
    })();
  }, [
    accountEmail,
    branch,
    copy,
    effectiveThinking,
    isFullRecord,
    linkedIssue,
    messageCount,
    nodeId,
    nodeLabel,
    nodeUrl,
    projectDir,
    queryClient,
    session,
    sessionId,
    sessionName,
    showToast,
  ]);

  return { onCopySessionInfo, onKebabOpenChange };
}
