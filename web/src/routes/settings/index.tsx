// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Network, // Federation Health
  ServerCog, // VMs
  CalendarClock, // System Jobs
  RefreshCw, // Harness Updates
  FileWarning, // File Conflicts
  Puzzle, // Extensions
  FolderCog, // Configuration (Porter)
  Gauge, // Provider Accounts
  BarChart3, // Analytics
  History, // Work Log
  Database, // Session Metadata
  AlertTriangle, // Error Log
  MessageSquare, // Feedback
  Bell, // Notifications (#4906: its own page)
  Sliders, // Preferences
  Info, // About
  LogOut, // Sign Out
  ChevronDown, // group + parent-row expand/collapse chevron
  KeyRound, // Provider API Keys (nested under Provider Accounts)
  ClipboardList, // Harness Scorecard
  Boxes, // Capabilities (#3752)
  ScrollText, // Transcripts (#3839)
  Compass, // Getting started (#3865, nested under Preferences)
  LifeBuoy, // Help (#4371)
  type LucideIcon,
} from "lucide-react";
import { AccentChip } from "@/components/ui/AccentChip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAppContext } from "@/lib/app-context";
import { useVersion } from "@/hooks/useVersion";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useVmPreflight } from "@/hooks/queries/useVmInventory";
import {
  isPorterExposed,
  usePorterStatus,
} from "@/hooks/queries/usePorterStatus";
import { getStorageKey } from "@/lib/storage-keys";

/**
 * SettingsLandingPage — the Settings drawer's landing page (Sub-Issue B, #1036;
 * regrouped by the Settings sidebar reorganization, then by #4906).
 *
 * Rendered DIRECTLY by SettingsDrawer when the URL has `?drawer=settings` (search-param
 * overlay — no `/settings` landing route, no `<Outlet />`). Presents a vertical list
 * of section rows grouped into FOUR categories, in the operator's order (#4906) —
 * USER (things you configure), SYSTEM (this instance and its federation),
 * OPERATIONS (things you observe and run) and ADMIN (operator-only; rendered only
 * when the admin-VM capability gate is open) — plus a standalone Sign Out footer row
 * below a divider. Each row is a `<button>` (NOT a `<Link>` — the codebase convention
 * is programmatic `useNavigate`) wired to its own route (#1935 promoted every
 * informational section to its own `/settings/*` page); navigating there drops the
 * `?drawer=settings` param, dismissing the drawer.
 *
 * The group headings and the two parent rows with sub-rows — Provider Accounts
 * (Provider API Keys) and Preferences (Getting started) — are collapsible. A parent
 * row is a SPLIT control: clicking the row itself (icon, label, empty space)
 * navigates to the page, while its trailing chevron is a SEPARATE button with its
 * own hit area that only expands/collapses the sub-rows. Rows without sub-pages
 * carry no chevron at all — a chevron here means "expandable", never "navigable".
 * Collapse state defaults to expanded and persists per instance in localStorage
 * (`hapi:settingsMenuCollapse:v2`; the v1 blob of the two-group menu is dropped on
 * first read, #4906). The folded pages' contents live as anchored sections on the
 * parent page, and a sub-row navigates to the parent route with a URL hash
 * (`navigate({ to, hash })`) so the page scrolls to that section via
 * `useScrollToLocationHash`. Session Handoff and Backup Key are sections on the
 * Preferences page with no menu row (#4906).
 *
 * The Sign Out row is hidden when `useAppContext().onLogout` is undefined
 * (Telegram mode). On a gateway-onboarded (`ssoEnabled`) instance, confirming
 * also ends the hapimatic.com session — that branch lives in App's sign-out
 * handler (`web/src/lib/signOut.ts`); this page only picks the matching
 * confirmation text (#4897).
 */

type AdminRoute =
  | "/settings/analytics"
  | "/error-logs"
  | "/settings/account-usage"
  | "/settings/federation"
  | "/settings/system-jobs"
  | "/settings/harness-updates"
  | "/settings/time-log"
  | "/settings/session-metadata"
  | "/settings/transcripts"
  | "/settings/preferences"
  | "/settings/notifications"
  | "/settings/about"
  | "/settings/extensions"
  | "/settings/configuration"
  | "/settings/vms"
  | "/settings/harness-scorecard"
  | "/settings/file-conflicts"
  | "/settings/capabilities"
  | "/settings/feedback"
  | "/settings/help";

type SubRow = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Parent page route; the sub-row deep-links to an anchored section on it. */
  to: AdminRoute;
  /** The `id` of the anchored section on the parent page (URL hash, no '#'). */
  hash: string;
};

type SectionRow = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Accent hex color — 15% as the icon-cell background, 100% as the icon stroke. */
  accent: string;
  /**
   * Top-level route. Every row navigates to its own page (#1935 promoted the
   * former in-drawer `?section=` overlays to routes), and navigating there drops
   * the `?drawer=settings` param, dismissing the drawer.
   */
  to: AdminRoute;
  /** Always-visible nested sub-rows (deep-links into the parent page's sections). */
  children?: SubRow[];
};

type SectionGroup = { heading: string; items: SectionRow[] };

/**
 * #4906: the operator-only group. It renders only while the admin-VM preflight
 * gate is open (the VMs row's existing #2470 gate, which #2910 also plans for the
 * Feedback read surface), so a user-VM instance never advertises it.
 */
const ADMIN_GROUP_HEADING = "ADMIN";

const ADMIN_SECTIONS: SectionGroup[] = [
  {
    heading: "USER",
    items: [
      {
        key: "account-usage",
        // Epic #3285 round 14 titled the page "Accounts"; #4906 names it for what
        // it holds, model-provider accounts and keys. The route path is unchanged.
        label: "Provider Accounts",
        icon: Gauge,
        accent: "var(--accent-cyan)", // #3355 C1 — decorative cyan via the --accent-cyan token
        to: "/settings/account-usage",
        children: [
          {
            // #4906: the provider API-key vault moved here from the Keys page.
            key: "api-keys",
            label: "Provider API Keys",
            icon: KeyRound,
            to: "/settings/account-usage",
            hash: "api-keys",
          },
        ],
      },
      {
        key: "timelog",
        // #4906: the operator's label. #4428 renames the page and route; until it
        // lands the route stays /settings/time-log.
        label: "Work Log",
        icon: History,
        accent: "var(--accent-purple-400)",
        to: "/settings/time-log",
      },
      {
        key: "preferences",
        label: "Preferences",
        icon: Sliders,
        accent: "var(--accent-teal-400)",
        to: "/settings/preferences",
        // #4906: Session Handoff and Backup Key are sections on the page with no
        // menu row. Getting started keeps its row: #3865 keeps the tour's re-entry
        // in the Settings drawer.
        children: [
          {
            // #3865: the in-app first-run tour's re-entry (NOT the gateway
            // #onboarding section, which keeps its own anchor).
            key: "getting-started",
            label: "Getting started",
            icon: Compass,
            to: "/settings/preferences",
            hash: "getting-started",
          },
        ],
      },
      {
        // #4906: its own page, ready for the #4916 inbox beside the settings.
        key: "notifications",
        label: "Notifications",
        icon: Bell,
        accent: "var(--accent-amber-400)",
        to: "/settings/notifications",
      },
      {
        // #4371 (operator ruling 4371-D1 = C): the in-app Help page — the
        // support assistant, the tour, and the human lifeline. The drawer stays
        // a pure menu (#1935), so the row navigates to its own page.
        key: "help",
        label: "Help",
        icon: LifeBuoy,
        accent: "var(--accent-sky-400)",
        to: "/settings/help",
      },
    ],
  },
  {
    heading: "SYSTEM",
    items: [
      {
        key: "federation",
        label: "Federation Health",
        icon: Network,
        accent: "var(--accent-emerald-400)",
        to: "/settings/federation",
      },
      {
        key: "configuration",
        label: "Configuration",
        icon: FolderCog,
        accent: "var(--accent-teal-200)",
        to: "/settings/configuration",
      },
      {
        key: "extensions",
        label: "Extensions",
        icon: Puzzle,
        accent: "var(--accent-indigo-400)",
        to: "/settings/extensions",
      },
      {
        key: "about",
        label: "About",
        icon: Info,
        accent: "var(--accent-amber-500)",
        to: "/settings/about",
      },
    ],
  },
  {
    heading: "OPERATIONS",
    items: [
      {
        key: "harness-updates",
        label: "Harness Updates",
        icon: RefreshCw,
        accent: "var(--accent-green-400)",
        to: "/settings/harness-updates",
      },
      {
        // #4906 D1: not in the operator's list; kept beside Harness Updates so a
        // working page stays reachable from the menu.
        key: "harness-scorecard",
        label: "Harness Scorecard",
        icon: ClipboardList,
        accent: "var(--accent-mint)",
        to: "/settings/harness-scorecard",
      },
      {
        key: "capabilities",
        label: "Capabilities",
        icon: Boxes,
        accent: "var(--accent-cyan)",
        to: "/settings/capabilities",
      },
      {
        key: "system-jobs",
        label: "System Jobs",
        icon: CalendarClock,
        accent: "var(--accent-violet-400)",
        to: "/settings/system-jobs",
      },
      {
        key: "analytics",
        label: "Analytics",
        icon: BarChart3,
        accent: "var(--accent-blue-400)",
        to: "/settings/analytics",
      },
      {
        key: "file-conflicts",
        label: "File Conflicts",
        icon: FileWarning,
        accent: "var(--accent-orange-400)",
        to: "/settings/file-conflicts",
      },
      {
        key: "session-metadata",
        label: "Session Metadata",
        icon: Database,
        accent: "var(--accent-sky-400)",
        to: "/settings/session-metadata",
      },
      {
        key: "transcripts",
        label: "Transcripts",
        icon: ScrollText,
        accent: "var(--accent-mint)",
        to: "/settings/transcripts",
      },
      {
        key: "errorlog",
        label: "Error Log",
        icon: AlertTriangle,
        accent: "var(--accent-rose-400)",
        to: "/error-logs",
      },
    ],
  },
  {
    heading: ADMIN_GROUP_HEADING,
    items: [
      {
        key: "vms",
        label: "VMs",
        icon: ServerCog,
        accent: "var(--accent-sky-400)",
        to: "/settings/vms",
      },
      {
        key: "feedback",
        label: "Feedback",
        icon: MessageSquare,
        accent: "var(--accent-pink-400)",
        to: "/settings/feedback",
      },
    ],
  },
];

/**
 * Every route the menu navigates to (rows and sub-rows), de-duplicated. #4906:
 * `router.test.tsx` checks each one against the REAL route table, so a row whose
 * page is not registered (an invisible page, #2344) or is only a redirect fails.
 */
export function listSettingsMenuRoutes(): string[] {
  const routes = ADMIN_SECTIONS.flatMap(group =>
    group.items.flatMap(item => [
      item.to,
      ...(item.children ?? []).map(sub => sub.to),
    ])
  );
  return [...new Set(routes)];
}

/** Collapsed-state map (true = collapsed) for group headings and parent rows. */
type CollapseState = {
  groups: Record<string, boolean>;
  rows: Record<string, boolean>;
};

const COLLAPSE_STORAGE_KEY = getStorageKey("hapi:settingsMenuCollapse:v2");

/**
 * #4906: v1 keyed the two-group menu (USER/SYSTEM, the Keys row). Its entries name
 * groups and rows that moved or no longer exist, so the blob is dropped rather than
 * mapped — an existing instance opens with every group expanded.
 */
const LEGACY_COLLAPSE_STORAGE_KEY = getStorageKey(
  "hapi:settingsMenuCollapse:v1"
);

// Guarded read (themePersistence.ts pattern): a disabled/full store or corrupt
// blob degrades to the default (everything expanded) and never throws into render.
function readCollapseState(): CollapseState {
  try {
    localStorage.removeItem(LEGACY_COLLAPSE_STORAGE_KEY);
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return { groups: {}, rows: {} };
    const parsed = JSON.parse(raw) as Partial<CollapseState>;
    return { groups: parsed.groups ?? {}, rows: parsed.rows ?? {} };
  } catch {
    return { groups: {}, rows: {} };
  }
}

export default function SettingsLandingPage() {
  useDocumentTitle("Settings - Hapimatic");
  useEmojiFavicon(null);
  const navigate = useNavigate();
  const { api, onLogout } = useAppContext();
  // #4897: the same `/api/version` flag App's sign-out handler branches on, so the
  // confirmation text always matches what Sign Out will do.
  const { data: versionInfo } = useVersion();
  const ssoEnabled = versionInfo?.ssoEnabled === true;
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [collapse, setCollapse] = useState<CollapseState>(readCollapseState);

  // Persist on every change (ThemePersistenceBridge pattern). Functional
  // setState updates below keep two toggles fired before a re-render (React 18
  // batches same-task clicks) from clobbering each other — the naive
  // "spread render-scoped state, then setItem in the handler" version lost the
  // first toggle, verified live in the deployed drawer.
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(collapse));
    } catch {
      // Persistence is best-effort; the in-memory state still applies.
    }
  }, [collapse]);
  const toggleGroup = (heading: string) =>
    setCollapse(prev => ({
      ...prev,
      groups: { ...prev.groups, [heading]: !prev.groups[heading] },
    }));
  const toggleRow = (key: string) =>
    setCollapse(prev => ({
      ...prev,
      rows: { ...prev.rows, [key]: !prev.rows[key] },
    }));

  // The ADMIN group (VMs, Feedback) is gated FAIL-CLOSED on the admin-VM preflight
  // verdict: it shows only when the capability gate is open. On a user-VM binary
  // the preflight route 404s, so `data` stays undefined and the group is hidden — a
  // non-operator instance never advertises it (issue #2470 R1, #4906 R6). The VMs
  // row keeps its own check too, and the VMs page gates again as defense-in-depth.
  const vmEnabled = useVmPreflight(api).data?.enabled === true;

  // #4533 / #5165: the Configuration (Porter) row is gated FAIL-CLOSED on the
  // Porter exposure probe — Porter is exposed by default, but a node withheld by
  // `HAPI_PORTER_EXPOSED=0` answers 404, so the row appears only when the server
  // answers 200 `{ exposed: true }` (product-map decisions 6 and 47). #4655: the
  // verdict reads the query's status first, so a tab that cached `exposed` hides
  // the row once a refetch fails.
  const porterExposed = isPorterExposed(usePorterStatus(api));

  return (
    <div data-testid="settings-landing-root" className="flex flex-col pb-2">
      {ADMIN_SECTIONS.map(group => {
        if (group.heading === ADMIN_GROUP_HEADING && !vmEnabled) return null;
        const visibleItems = group.items.filter(item =>
          item.key === "vms"
            ? vmEnabled
            : item.key === "configuration"
              ? porterExposed
              : true
        );
        if (visibleItems.length === 0) return null;
        const groupCollapsed = Boolean(collapse.groups[group.heading]);

        return (
          <section key={group.heading} className="flex flex-col">
            <div className="flex items-center justify-between pr-2">
              <h2 className="px-4 pb-1 pt-2.5 text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                {group.heading}
              </h2>
              <button /* design-tokens-allow: settings-landing group collapse toggle (nav-list split control) - D2 E3 exception (#3358) */
                type="button"
                onClick={() => toggleGroup(group.heading)}
                aria-expanded={!groupCollapsed}
                aria-label={`${groupCollapsed ? "Expand" : "Collapse"} ${group.heading} section`}
                data-testid={`settings-group-toggle-${group.heading.toLowerCase()}`}
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
              >
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${groupCollapsed ? "-rotate-90" : ""}`}
                />
              </button>
            </div>
            {!groupCollapsed && (
              <ul className="flex flex-col" role="list">
                {visibleItems.map(item => {
                  const Icon = item.icon;
                  const rowCollapsed = Boolean(collapse.rows[item.key]);
                  return (
                    <li key={item.key}>
                      <div className="flex items-center">
                        <button /* design-tokens-allow: settings-landing nav row (bespoke full-height nav-list widget; directive carve-out) - D2 E3 exception (#3358) */
                          type="button"
                          onClick={() => navigate({ to: item.to })}
                          className="flex h-11 min-w-0 flex-1 items-center gap-2.5 px-3 text-left transition-colors hover:bg-[var(--app-secondary-bg)] active:bg-[var(--app-secondary-bg)]"
                          aria-label={item.label}
                          data-testid={`settings-row-${item.key}`}
                        >
                          <AccentChip accent={item.accent}>
                            <Icon
                              className="h-4 w-4"
                              style={{ color: item.accent }}
                            />
                          </AccentChip>
                          <span
                            /* design-tokens-allow: 15px nav-row label - no exact type-scale token (ladder tops out at 14px) - D2 px-floor exception (#3358) */ className="flex-1 truncate text-[15px] font-medium text-[var(--app-fg)]"
                          >
                            {item.label}
                          </span>
                        </button>
                        {item.children && (
                          <button /* design-tokens-allow: settings-landing sub-row expand toggle (nav-list split control) - D2 E3 exception (#3358) */
                            type="button"
                            onClick={() => toggleRow(item.key)}
                            aria-expanded={!rowCollapsed}
                            aria-label={`${rowCollapsed ? "Expand" : "Collapse"} ${item.label} sub-pages`}
                            data-testid={`settings-expand-${item.key}`}
                            className="flex h-11 w-11 flex-shrink-0 items-center justify-center text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] active:bg-[var(--app-secondary-bg)]"
                          >
                            <ChevronDown
                              className={`h-4 w-4 transition-transform ${rowCollapsed ? "-rotate-90" : ""}`}
                            />
                          </button>
                        )}
                      </div>
                      {item.children && !rowCollapsed && (
                        <ul className="flex flex-col" role="list">
                          {item.children.map(sub => {
                            const SubIcon = sub.icon;
                            return (
                              <li key={sub.key}>
                                <button /* design-tokens-allow: settings-landing sub-row nav (bespoke nav-list widget; directive carve-out) - D2 E3 exception (#3358) */
                                  type="button"
                                  onClick={() =>
                                    navigate({ to: sub.to, hash: sub.hash })
                                  }
                                  className="flex h-9 w-full items-center gap-2.5 pl-[30px] pr-3 text-left transition-colors hover:bg-[var(--app-secondary-bg)] active:bg-[var(--app-secondary-bg)]" /* design-tokens-allow: 30px sub-row indent - no spacing-scale token (pl-7 is 28px, pl-8 is 32px) - D2 px-floor exception (#3358) */
                                  aria-label={sub.label}
                                  data-testid={`settings-subrow-${sub.key}`}
                                >
                                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-white/5">
                                    <SubIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />
                                  </span>
                                  <span className="flex-1 text-[length:var(--text-label-strong)] text-[var(--app-fg)]">
                                    {sub.label}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      {/* Standalone Sign Out footer — an action, not a destination, so it sits
          below a divider outside the groups (no chevron). */}
      {onLogout && (
        <div className="mt-1.5 border-t border-black/10 pt-1.5">
          <button /* design-tokens-allow: settings-landing sign-out action row (bespoke nav-list widget) - D2 E3 exception (#3358) */
            type="button"
            onClick={() => setSignOutOpen(true)}
            className="flex h-11 w-full items-center gap-2.5 px-3 text-left transition-colors hover:bg-[var(--app-secondary-bg)] active:bg-[var(--app-secondary-bg)]"
            aria-label="Sign Out"
            data-testid="settings-row-signout"
          >
            <AccentChip accent="var(--accent-red-500)">
              <LogOut
                className="h-4 w-4"
                style={{ color: "var(--accent-red-500)" }}
              />
            </AccentChip>
            <span
              /* design-tokens-allow: 15px sign-out label - no exact type-scale token (ladder tops out at 14px) - D2 px-floor exception (#3358) */ className="flex-1 text-[15px] font-medium text-[var(--app-fg)]"
            >
              Sign Out
            </span>
          </button>
        </div>
      )}

      {onLogout && (
        <ConfirmDialog
          isOpen={signOutOpen}
          onClose={() => setSignOutOpen(false)}
          title="Sign Out"
          description={
            ssoEnabled
              ? "Are you sure you want to sign out? This also signs you out of hapimatic.com, and you will need to sign in again to reconnect."
              : "Are you sure you want to sign out? You will need to enter your access token again to reconnect."
          }
          confirmLabel="Sign Out"
          confirmingLabel="Signing out..."
          onConfirm={async () => {
            onLogout();
          }}
          isPending={false}
          destructive
        />
      )}
    </div>
  );
}
