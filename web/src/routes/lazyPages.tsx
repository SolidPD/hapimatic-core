// SPDX-License-Identifier: AGPL-3.0-only
// #3098: every route page below loads on demand, each behind its own fallback
// (lazyRoutePage). The sessions list, chat and new-session pages stay in the
// main bundle. Admin pages became routes of their own in #1935; the capability
// panel lives under components/Settings (#3752).
//
// The pages live here rather than in router.tsx so the screens that lead to
// them can preload them (ViewPicker, SettingsDrawer) without importing the
// router. The router waits for a route page's preload() before it renders the
// route, keeping the current screen up meanwhile; preloading ahead of time
// removes that wait. NodeDetailViewPage renders inside a wrapper route the
// router does not wait on, so until it is preloaded it shows its fallback.
import { lazyWithPreload, preloadWhenIdle } from "@/lib/lazyWithPreload";
import { lazyRoutePage, routeFallback } from "@/routes/lazyRoutePage";

export const AnalyticsRoutePage = lazyRoutePage(
  () => import("@/extensions/analytics/routes/analytics"),
  "Loading analytics..."
);
export const ErrorLogsPage = lazyRoutePage(
  () => import("@/extensions/error-log-viewer/routes/error-logs"),
  "Loading error logs..."
);
export const ExtensionMarketplacePage = lazyRoutePage(
  () => import("@/extensions/extension-marketplace/routes/extensions"),
  "Loading extensions..."
);
export const FilesPage = lazyRoutePage(
  () => import("@/extensions/git-rpc/routes/files"),
  "Loading files..."
);
export const FilePage = lazyRoutePage(
  () => import("@/extensions/git-rpc/routes/file"),
  "Loading file..."
);
export const TerminalPage = lazyRoutePage(
  () => import("@/routes/sessions/terminal"),
  "Loading terminal..."
);
export const ClaudePtyPage = lazyRoutePage(
  () => import("@/routes/sessions/claude-pty"),
  "Loading terminal..."
);
export const DesktopPage = lazyRoutePage(
  () => import("@/routes/sessions/desktop"),
  "Loading desktop..."
);
export const AccountUsagePage = lazyRoutePage(
  () => import("@/routes/account-usage"),
  "Loading account usage..."
);
export const FederationDashboard = lazyRoutePage(
  () => import("@/routes/settings/federation"),
  "Loading federation..."
);
export const AdminSystemJobsPage = lazyRoutePage(
  () => import("@/routes/settings/system-jobs"),
  "Loading system jobs..."
);
export const AdminFileConflictsPage = lazyRoutePage(
  () => import("@/routes/settings/file-conflicts"),
  "Loading file conflicts..."
);
export const TimeLogPage = lazyRoutePage(
  () => import("@/extensions/time-log/routes/time-log"),
  "Loading time log..."
);
export const SessionMetadataPage = lazyRoutePage(
  () => import("@/routes/settings/session-metadata"),
  "Loading session metadata..."
);
export const TranscriptsPage = lazyRoutePage(
  () => import("@/routes/settings/transcripts"),
  "Loading transcripts..."
);
export const AdminFeedbackPage = lazyRoutePage(
  () => import("@/routes/settings/feedback"),
  "Loading feedback..."
);
export const AdminHelpPage = lazyRoutePage(
  () => import("@/routes/settings/help"),
  "Loading help..."
);
export const AdminPreferencesPage = lazyRoutePage(
  () => import("@/routes/settings/preferences"),
  "Loading preferences..."
);
export const AdminAboutPage = lazyRoutePage(
  () => import("@/routes/settings/about"),
  "Loading about..."
);
export const NotificationsPage = lazyRoutePage(
  () => import("@/routes/settings/notifications"),
  "Loading notifications..."
);
export const ConnectorsPage = lazyRoutePage(
  () => import("@/routes/settings/connectors"),
  "Loading connectors..."
);
export const NetworkPage = lazyRoutePage(
  () => import("@/routes/settings/network"),
  "Loading network..."
);
export const ExtensionsAdminPage = lazyRoutePage(
  () => import("@/routes/settings/extensions"),
  "Loading extensions..."
);
export const ConfigurationAdminPage = lazyRoutePage(
  () => import("@/routes/settings/configuration"),
  "Loading configuration..."
);
export const AdminVmsPage = lazyRoutePage(
  () => import("@/routes/settings/vms"),
  "Loading VMs..."
);
export const HarnessScorecardPage = lazyRoutePage(
  () => import("@/routes/settings/harness-scorecard"),
  "Loading harness scorecard..."
);
export const AdminHarnessUpdatesPage = lazyRoutePage(
  () => import("@/routes/settings/harness-updates"),
  "Loading harness updates..."
);
export const CapabilitiesPanel = lazyRoutePage(
  () => import("@/components/Settings/CapabilitiesPanel"),
  "Loading capabilities..."
);
export const NodeDetailViewPage = lazyWithPreload<{ nodeId: string }>(
  () =>
    import("@/components/federation/NodeDetailView").then(m => ({
      default: m.NodeDetailView,
    })),
  { fallback: routeFallback("Loading node...") }
);

/** The session views reached from a session's Chat/Terminal/Desktop/Files tabs. */
const SESSION_VIEW_PAGES = [
  TerminalPage,
  ClaudePtyPage,
  DesktopPage,
  FilesPage,
  FilePage,
];

/**
 * Pages reached from the settings drawer. Analytics is left out: it was lazy
 * before #3098 too, and its 443 KB chunk is not worth loading on every open.
 */
const SETTINGS_PAGES = [
  ErrorLogsPage,
  ExtensionMarketplacePage,
  AccountUsagePage,
  FederationDashboard,
  AdminSystemJobsPage,
  AdminFileConflictsPage,
  TimeLogPage,
  SessionMetadataPage,
  TranscriptsPage,
  AdminFeedbackPage,
  AdminHelpPage,
  AdminPreferencesPage,
  AdminAboutPage,
  NotificationsPage,
  ConnectorsPage,
  NetworkPage,
  ExtensionsAdminPage,
  ConfigurationAdminPage,
  AdminVmsPage,
  HarnessScorecardPage,
  AdminHarnessUpdatesPage,
  CapabilitiesPanel,
  NodeDetailViewPage,
];

/** Called when a session opens, so its first tab switch does not wait for code. */
export function preloadSessionViewPages(): () => void {
  return preloadWhenIdle(SESSION_VIEW_PAGES);
}

/** Called when the settings drawer opens, so the page a row opens does not wait for code. */
export function preloadSettingsPages(): () => void {
  return preloadWhenIdle(SETTINGS_PAGES);
}
