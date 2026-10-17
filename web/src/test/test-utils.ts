// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { vi } from "vitest";
import type { Mock } from "vitest";

type TestQueryClientOptions = {
  /** Override gcTime for queries and mutations. Default: 0 (immediate gc). */
  gcTime?: number;
};

/**
 * Create a fresh QueryClient configured for testing.
 *
 * Key differences from production:
 * - retry: false — prevents flaky retries in tests
 * - gcTime: 0 — garbage collect immediately to prevent cross-test leaks
 * - staleTime: 0 — always re-fetch on mount
 *
 * Use `{ gcTime: Infinity }` for tests that seed + inspect query cache
 * (optimistic updates, cache rollback, etc.) to prevent premature gc.
 */
export function createTestQueryClient(
  opts?: TestQueryClientOptions
): QueryClient {
  const gc = opts?.gcTime ?? 0;
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: gc,
        staleTime: 0,
      },
      mutations: {
        retry: false,
        gcTime: gc,
      },
    },
  });
}

/**
 * Create a wrapper component that provides QueryClientProvider context.
 * Used with renderHook from @testing-library/react:
 *
 * ```ts
 * const { wrapper, queryClient } = createQueryWrapper();
 * const { result } = renderHook(() => useSessions(mockApi), { wrapper });
 * ```
 *
 * Pass `{ gcTime: Infinity }` when testing optimistic cache updates
 * or any test that seeds data with `setQueryData` then reads it back.
 */
export function createQueryWrapper(opts?: TestQueryClientOptions): {
  wrapper: ({ children }: { children: ReactNode }) => ReactNode;
  queryClient: QueryClient;
} {
  const queryClient = createTestQueryClient(opts);

  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  return { wrapper, queryClient };
}

/**
 * Create a type-safe mock of ApiClient.
 *
 * All methods are vi.fn() stubs. Override specific methods in individual tests:
 *
 * ```ts
 * const api = createMockApiClient();
 * api.getSessions.mockResolvedValue({ sessions: [...] });
 * ```
 */
export function createMockApiClient(): Record<string, Mock> {
  return {
    getSessions: vi.fn(),
    getSession: vi.fn(),
    getMessages: vi.fn(),
    getMessagesAfter: vi.fn(),
    // #3559 (R6): approval-gate state read surface for the server-driven card.
    getApprovalState: vi.fn(),
    getMachines: vi.fn(),
    // Account management (epic #1446 — multi-account OAuth switcher)
    getAccounts: vi.fn(),
    deleteAccount: vi.fn(),
    removeAccountOnNode: vi.fn(),
    setSessionAccount: vi.fn(),
    setSessionPaymentMethod: vi.fn(),
    getNodeActiveAccount: vi.fn(),
    setNodeActiveAccount: vi.fn(),
    getAccountUsage: vi.fn(),
    // Web-initiated OAuth login (issue #1263)
    startAccountLogin: vi.fn(),
    completeAccountLogin: vi.fn(),
    // In-VM Claude sign-in on a tenant VM (issue #4349)
    startInVmAccountLogin: vi.fn(),
    completeInVmAccountLogin: vi.fn(),
    cancelInVmAccountLogin: vi.fn(),
    getGitStatus: vi.fn(),
    getGitRemoteUrl: vi.fn(),
    getGitDiffNumstat: vi.fn(),
    getGitDiffFile: vi.fn(),
    searchSessionFiles: vi.fn(),
    readSessionFile: vi.fn(),
    sendMessage: vi.fn(),
    abortSession: vi.fn(),
    archiveSession: vi.fn(),
    reconnectSession: vi.fn(),
    switchSession: vi.fn(),
    setPermissionMode: vi.fn(),
    setModelMode: vi.fn(),
    setSessionEffort: vi.fn(),
    setSessionRawModel: vi.fn(),
    approvePermission: vi.fn(),
    denyPermission: vi.fn(),
    renameSession: vi.fn(),
    updateSessionNotes: vi.fn(),
    updateSessionView: vi.fn(),
    updateSessionEmoji: vi.fn(),
    updateSessionTimer: vi.fn(),
    getAllTimers: vi.fn(),
    checkMachinePathsExists: vi.fn(),
    listMachineDirectory: vi.fn(),
    createMachineDirectory: vi.fn(),
    getRecentPaths: vi.fn(),
    addRecentPath: vi.fn(),
    spawnSession: vi.fn(),
    spawnOnNode: vi.fn(),
    listNodeDirectory: vi.fn(),
    createNodeDirectory: vi.fn(),
    checkNodePathsExists: vi.fn(),
    getNodeRecentPaths: vi.fn(),
    addNodeRecentPath: vi.fn(),
    getCreateSessionPreferences: vi.fn(),
    setCreateSessionPreferences: vi.fn(),
    getOnboardingState: vi.fn(),
    setOnboardingState: vi.fn(),
    getSlashCommands: vi.fn(),
    getPushVapidPublicKey: vi.fn(),
    subscribePushNotifications: vi.fn(),
    unsubscribePushNotifications: vi.fn(),
    authenticate: vi.fn(),
    bind: vi.fn(),
    getSchedules: vi.fn(),
    getSchedule: vi.fn(),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    toggleSchedule: vi.fn(),
    runScheduleNow: vi.fn(),
    getScheduleHistory: vi.fn(),
    getHeartbeatConfig: vi.fn(),
    updateHeartbeatConfig: vi.fn(),
    getHeartbeatStatus: vi.fn(),
    getHeartbeatHistory: vi.fn(),
    getHeartbeatInstructions: vi.fn(),
    updateHeartbeatInstructions: vi.fn(),
    deleteHeartbeat: vi.fn(),
    // Harness self-update (#1775). ⚠️ createMockApiClient has NO TS binding to
    // ApiClient, so a missing entry compiles fine and fails only at call time —
    // add these deliberately.
    getHarnessPollConfig: vi.fn(),
    setHarnessPollConfig: vi.fn(),
    triggerHarnessCheck: vi.fn(),
    deleteHeartbeatConfig: vi.fn(),
    deleteSession: vi.fn(),
    getTimeLogs: vi.fn(),
    createTimeLogEntry: vi.fn(),
    deleteTimeLogEntry: vi.fn(),
    getTimeLogDailySummary: vi.fn(),
    getTimeLogProjects: vi.fn(),
    getTimeLogProjectGrouped: vi.fn(),
    // Issue #1670 (PR-2): six-control ledger + derived read + cutover gate.
    getTimelogCutoverStatus: vi.fn(),
    getDerivedTimeLog: vi.fn(),
    getTimelogAdjustments: vi.fn(),
    postTimelogAdjustment: vi.fn(),
    getTimeLogWeeklySummary: vi.fn(),
    updateNeedsReviewOverride: vi.fn(),
    updateSessionNeedsReviewOverride: vi.fn(),
    updateLinkedIssue: vi.fn(),
    updateSessionLinkedIssue: vi.fn(),
    uploadFile: vi.fn(),
    getFederationNodes: vi.fn(),
    getFederationAllSessions: vi.fn(),
    getFileClaims: vi.fn(),
    getFileClaimHistory: vi.fn(),
    // System jobs (epic #1534 Sub-Issue D — issue #1538)
    getSystemJobsAll: vi.fn(),
    // Harness self-update panel (epic #1769 Sub-Issue D — #1773). A missing
    // entry compiles fine (the map is Record<string, Mock>) and only fails at
    // call time, so these are added deliberately.
    getHarnessStatus: vi.fn(),
    getHarnessChangelog: vi.fn(),
    getHarnessAnalysis: vi.fn(),
    triggerHarnessAnalysis: vi.fn(),
    enableSystemJob: vi.fn(),
    disableSystemJob: vi.fn(),
    deleteSystemJob: vi.fn(),
    rescheduleSystemJob: vi.fn(),
    renameSystemJob: vi.fn(),
    editSystemJobDescription: vi.fn(),
    getSystemHealth: vi.fn(),
    // Federation health (issue #1445; consumed by #1040 / #1037 / #1444)
    getFederationHealthAggregate: vi.fn(),
    getFederationNodeHealth: vi.fn(),
    // Federation health — alerts feed + batch per-node (issue #1037 / #1632)
    getFederationAlerts: vi.fn(),
    getFederationHealthNodes: vi.fn(),
    // Issue #1325: server-backed queue
    getQueue: vi.fn(),
    enqueueQueuedMessage: vi.fn(),
    updateQueuedMessage: vi.fn(),
    removeQueuedMessage: vi.fn(),
    clearQueue: vi.fn(),
    drainQueueHead: vi.fn(),
    // Issue #1284: the generic escape hatch extension-owned routes call. Unlike
    // every entry above it is NOT a core endpoint — it is the one seam through
    // which an extension reaches its own server routes without core learning
    // their names, so a single mock here serves every current and future
    // extension rather than growing one entry per extension endpoint.
    extensionRequest: vi.fn(),
  };
}

export type MockApiClient = Record<string, Mock>;
