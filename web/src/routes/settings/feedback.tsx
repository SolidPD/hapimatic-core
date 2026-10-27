// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import type {
  FeedbackInboxFilters,
  FeedbackInboxItem,
  FeedbackListItem,
  FeedbackStatus,
} from "@/types/api";
import { feedbackLinkedIssueUrl } from "@hapi/protocol/feedbackSink";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useFeedbackList } from "@/hooks/queries/useFeedbackList";
import { useFeedbackPreflight } from "@/hooks/queries/useFeedbackPreflight";
import {
  useFeedbackInbox,
  useFeedbackInboxCounts,
} from "@/hooks/queries/useFeedbackInbox";
import {
  describeFeedbackActionError,
  useFeedbackActions,
  type FeedbackActionError,
} from "@/hooks/mutations/useFeedbackActions";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { FilterChip } from "@/components/ui/FilterChip";
import { KVGrid } from "@/components/ui/KVGrid";
import { Textarea } from "@/components/ui/Textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * AdminFeedbackPage — the `/settings/feedback` route: the operators' shared
 * feedback inbox (issue #2912, epic #2909 Sub C; first a local viewer, #2666).
 *
 * The inbox reads the gateway's central store through this instance's proxy
 * (`/api/feedback/inbox…`), so every operator device shows the SAME rows, each
 * with its origin node or VM. Rows move `new → acknowledged → actioned |
 * dismissed` (and can be reopened); the server records who acted, and two
 * operators see each other's actions on refresh. Bright rows are `new`; handled
 * rows are dimmed. The default view is the open items (`new` + `acknowledged`).
 *
 * This node's own rows that have not reached the gateway (or whose email
 * failed) stay visible in a collapsed "This node" section, which is also the
 * page body when the inbox cannot be read (no gateway credential on this node,
 * or the gateway down), under a degraded-state message — a row that never left
 * this node is invisible in a central inbox by construction.
 *
 * Gate (#2910, #5571): the preflight is checked FIRST and nothing is requested
 * until it is open; a non-operator instance shows a gated state. Customer text,
 * notes and origin labels render as plain React text (escaped) — never as
 * markdown or HTML.
 */

const PAGE_SIZE = 50;
const FEEDBACK_ACCENT = "var(--accent-pink-400)"; // pink — distinct from Error Log's rose
const SEARCH_DEBOUNCE_MS = 300;

const CONTROL_CLASS =
  "rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2 py-1 text-[length:var(--text-body)] text-[var(--app-fg)]";
const ACTION_CLASS =
  "h-auto rounded-md px-3 py-1 text-[length:var(--text-body)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-40";
const MUTED_TEXT =
  "py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]";

const CATEGORY_LABEL: Record<FeedbackListItem["category"], string> = {
  bug: "Bug",
  feature: "Feature",
  other: "Other",
  // #4371: a "Contact a human" escalation from the in-app support session.
  "support-escalation": "Support escalation",
};

const STATUS_LABEL: Record<FeedbackStatus, string> = {
  new: "New",
  acknowledged: "Acknowledged",
  actioned: "Actioned",
  dismissed: "Dismissed",
};

/** The status views; "open" (the default) is `new` + `acknowledged`. */
const STATUS_VIEWS = {
  open: ["new", "acknowledged"],
  new: ["new"],
  acknowledged: ["acknowledged"],
  actioned: ["actioned"],
  dismissed: ["dismissed"],
  all: undefined,
} as const satisfies Record<string, readonly FeedbackStatus[] | undefined>;
type StatusView = keyof typeof STATUS_VIEWS;

const SORTS = {
  newest: { sort: "received_at", dir: "desc", label: "Newest first" },
  oldest: { sort: "received_at", dir: "asc", label: "Oldest first" },
  origin: { sort: "origin_label", dir: "asc", label: "Origin" },
  status: { sort: "status", dir: "asc", label: "Status" },
  category: { sort: "category", dir: "asc", label: "Category" },
} as const;
type SortKey = keyof typeof SORTS;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Pretty-print the scrubbed metadata JSON for read-only display. Never inject
 *  as HTML — React escapes the text content of the `<pre>`. Falls back to the
 *  raw string if it is not valid JSON. */
function formatMetadata(metadataJson: string): string {
  try {
    return JSON.stringify(JSON.parse(metadataJson), null, 2);
  } catch {
    return metadataJson;
  }
}

function LinkedIssue({ value }: { value: string }) {
  // A link only for an `owner/repo#N` value; anything else is plain text.
  const href = feedbackLinkedIssueUrl(value);
  if (href === null) return <span>{value}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[var(--app-accent)] underline"
      data-testid="feedback-linked-issue"
    >
      {value}
    </a>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 text-[length:var(--text-body-dense)] uppercase tracking-wide text-[var(--app-hint)]">
      {children}
    </p>
  );
}

const ACTION_ERROR_TEXT: Record<FeedbackActionError["kind"], string> = {
  conflict:
    "Another operator acted on this row. It now shows its current state.",
  gh_unavailable:
    "Convert needs the GitHub CLI, which is not available on this node.",
  label_missing:
    "The target repo has no “🏷️ type: ✉️ feedback” label, so no issue was filed.",
  unavailable: "The inbox could not be reached. Try again.",
  failed: "That did not work. Try again.",
};

/**
 * A row's last action outcome, kept by the page: an action can move its row
 * out of the current view (a 409 on a row another operator just dismissed, a
 * Convert that stamped it actioned), and the row's own message leaves with it.
 */
interface RowOutcome {
  id: string;
  text: string;
  alert: boolean;
}

/** The conflict text once the row has left the view it was acted on in. */
const CONFLICT_GONE_TEXT =
  "Another operator acted on this row, so it no longer matches this view.";

/** Which row an outcome is about, for when the row itself is gone. */
function rowSummary(item: FeedbackInboxItem): string {
  const text = item.description.replace(/\s+/g, " ").trim();
  const short = text.length > 60 ? `${text.slice(0, 59)}…` : text;
  return `${item.originLabel} · “${short}”`;
}

function InboxRow({
  item,
  open,
  onOpenChange,
  onOutcome,
  actions,
}: {
  item: FeedbackInboxItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOutcome: (outcome: RowOutcome | null) => void;
  actions: ReturnType<typeof useFeedbackActions>;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<FeedbackActionError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ghUnavailable, setGhUnavailable] = useState(false);
  const isNew = item.status === "new";
  const handled = item.status === "actioned" || item.status === "dismissed";
  const categoryLabel = CATEGORY_LABEL[item.category] ?? item.category;
  // The mutations are shared by every row: only this row's own call counts.
  const converting =
    actions.convert.isPending && actions.convert.variables === item.id;
  const busy =
    converting ||
    (actions.acknowledge.isPending &&
      actions.acknowledge.variables === item.id) ||
    (actions.dismiss.isPending && actions.dismiss.variables?.id === item.id) ||
    (actions.reopen.isPending && actions.reopen.variables?.id === item.id);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    onOutcome(null);
    try {
      await fn();
      return true;
    } catch (err) {
      const described = describeFeedbackActionError(err);
      if (described.kind === "gh_unavailable") setGhUnavailable(true);
      setError(described);
      onOutcome({
        id: item.id,
        text: `${rowSummary(item)}: ${
          described.kind === "conflict"
            ? CONFLICT_GONE_TEXT
            : ACTION_ERROR_TEXT[described.kind]
        }`,
        alert: true,
      });
      return false;
    }
  };

  const convert = () =>
    run(async () => {
      const result = await actions.convert.mutateAsync(item.id);
      const text = result.stamped
        ? `Filed ${result.issue}.`
        : `Filed ${result.issue}, but the row is not marked yet — convert again to finish.`;
      setNotice(text);
      onOutcome({
        id: item.id,
        text: `${rowSummary(item)}: ${text}`,
        alert: false,
      });
    });

  const title = (
    <span
      className={`inline-flex min-w-0 items-center gap-2 ${isNew ? "font-semibold" : ""}`}
    >
      {isNew && (
        <span
          aria-label="Unread"
          className="h-2 w-2 shrink-0 rounded-full bg-[var(--app-accent)]"
        />
      )}
      <Badge
        variant={isNew ? "mint" : "subscription"}
        className="shrink-0"
        data-testid={`feedback-status-${item.id}`}
      >
        {STATUS_LABEL[item.status]}
      </Badge>
      <Badge variant="default" className="shrink-0">
        {categoryLabel}
      </Badge>
      <span
        className="min-w-0 truncate"
        data-testid={`feedback-origin-${item.id}`}
      >
        {item.originLabel}
      </span>
    </span>
  );

  const summary = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="truncate">{item.description}</span>
      <span className="shrink-0 opacity-50">·</span>
      <span className="shrink-0">{fmtTime(item.receivedAt)}</span>
    </span>
  );

  const kvItems = [
    { key: "Status", value: STATUS_LABEL[item.status] },
    { key: "Category", value: categoryLabel },
    {
      key: "Origin",
      value: `${item.originLabel} (${item.originKind}, ${item.originInstanceId})`,
    },
    { key: "Received", value: fmtTime(item.receivedAt) },
    { key: "Submitted", value: fmtTime(item.createdAt) },
    // #5799: the sender's own createdAt, kept only when the gateway clamped it.
    // Sender-reported, so it is shown beside the trusted times, never in place of them.
    ...(item.claimedCreatedAt === null
      ? []
      : [
          {
            key: "Sender-reported time",
            value: fmtTime(item.claimedCreatedAt),
          },
        ]),
    { key: "Submitter", value: item.submitterEmail ?? "—" },
    { key: "App version", value: item.appVersion ?? "—" },
    { key: "Acted by", value: item.actedBy ?? "—" },
    {
      key: "Acted at",
      value: item.actedAt === null ? "—" : fmtTime(item.actedAt),
    },
  ];

  return (
    <CollapsibleSection
      data-testid={`feedback-inbox-row-${item.id}`}
      className={handled ? "opacity-60" : undefined}
      title={title}
      summary={summary}
      open={open}
      onOpenChange={onOpenChange}
    >
      <KVGrid items={kvItems} className="pt-1" />

      {item.linkedIssue !== null && (
        <div className="mt-3">
          <SectionLabel>Linked issue</SectionLabel>
          <LinkedIssue value={item.linkedIssue} />
        </div>
      )}
      {item.dispositionNote !== null && (
        <div className="mt-3">
          <SectionLabel>Note</SectionLabel>
          <p className="whitespace-pre-wrap break-words text-[length:var(--text-body)] text-[var(--app-fg)]">
            {item.dispositionNote}
          </p>
        </div>
      )}

      <div className="mt-3">
        <SectionLabel>Description</SectionLabel>
        <p
          data-testid={`feedback-description-${item.id}`}
          className="whitespace-pre-wrap break-words text-[length:var(--text-body)] text-[var(--app-fg)]"
        >
          {item.description}
        </p>
      </div>

      <div className="mt-3">
        <SectionLabel>Metadata</SectionLabel>
        <pre className="max-h-64 overflow-auto rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
          {JSON.stringify(item.metadata, null, 2)}
        </pre>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isNew && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            className={ACTION_CLASS}
            data-testid={`feedback-acknowledge-${item.id}`}
            onClick={() =>
              void run(() => actions.acknowledge.mutateAsync(item.id))
            }
          >
            Acknowledge
          </Button>
        )}
        {!handled && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || ghUnavailable}
            title={ghUnavailable ? ACTION_ERROR_TEXT.gh_unavailable : undefined}
            className={ACTION_CLASS}
            data-testid={`feedback-convert-${item.id}`}
            onClick={() => void convert()}
          >
            {converting ? "Converting…" : "Convert to issue"}
          </Button>
        )}
        {!handled && !dismissing && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            className={ACTION_CLASS}
            data-testid={`feedback-dismiss-${item.id}`}
            onClick={() => setDismissing(true)}
          >
            Dismiss
          </Button>
        )}
        {handled && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            className={ACTION_CLASS}
            data-testid={`feedback-reopen-${item.id}`}
            onClick={() =>
              void run(() =>
                actions.reopen.mutateAsync({ id: item.id, from: item.status })
              )
            }
          >
            Reopen
          </Button>
        )}
      </div>

      {dismissing && (
        <div className="mt-3 flex flex-col gap-2">
          <Textarea
            aria-label="Reason for dismissing"
            placeholder="Why dismiss this? (required)"
            value={note}
            maxLength={2000}
            onChange={e => setNote(e.target.value)}
            data-testid={`feedback-dismiss-note-${item.id}`}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy || note.trim() === ""}
              className={ACTION_CLASS}
              data-testid={`feedback-dismiss-confirm-${item.id}`}
              onClick={async () => {
                const ok = await run(() =>
                  actions.dismiss.mutateAsync({
                    id: item.id,
                    note: note.trim(),
                    from: item.status,
                  })
                );
                if (ok) {
                  setDismissing(false);
                  setNote("");
                }
              }}
            >
              Dismiss with note
            </Button>
            <Button
              type="button"
              variant="outline"
              className={ACTION_CLASS}
              onClick={() => {
                setDismissing(false);
                setNote("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error !== null && (
        <p
          role="alert"
          data-testid={`feedback-action-error-${item.id}`}
          className="mt-2 text-[length:var(--text-body)] text-[var(--app-hint)]"
        >
          {ACTION_ERROR_TEXT[error.kind]}
        </p>
      )}
      {notice !== null && (
        <p
          data-testid={`feedback-action-notice-${item.id}`}
          className="mt-2 text-[length:var(--text-body)] text-[var(--app-hint)]"
        >
          {notice}
        </p>
      )}
    </CollapsibleSection>
  );
}

function LocalFeedbackRow({
  item,
  open,
  onOpenChange,
}: {
  item: FeedbackListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const categoryLabel = CATEGORY_LABEL[item.category] ?? item.category;

  const title = (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Badge variant="mint" className="shrink-0">
        {categoryLabel}
      </Badge>
      {!item.emailed && (
        <Badge
          variant="warning"
          className="shrink-0"
          data-testid={`feedback-not-emailed-${item.id}`}
        >
          Not emailed
        </Badge>
      )}
      {item.forwardState !== undefined && item.forwardState !== "forwarded" && (
        <Badge
          variant="warning"
          className="shrink-0"
          data-testid={`feedback-not-forwarded-${item.id}`}
        >
          Not in the inbox
        </Badge>
      )}
      <span className="min-w-0 truncate">
        {item.submitterEmail ?? "anonymous"}
      </span>
    </span>
  );

  const summary = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="truncate">{item.description}</span>
      <span className="shrink-0 opacity-50">·</span>
      <span className="shrink-0">{fmtTime(item.createdAt)}</span>
    </span>
  );

  const kvItems = [
    { key: "Category", value: categoryLabel },
    { key: "Submitted", value: fmtTime(item.createdAt) },
    { key: "Submitter", value: item.submitterEmail ?? "—" },
    { key: "Emailed", value: item.emailed ? "Yes" : "No" },
    { key: "Email error", value: item.emailError ?? "—" },
    { key: "Forwarded", value: item.forwardState ?? "—" },
    { key: "Forward error", value: item.forwardError ?? "—" },
    { key: "Namespace", value: item.namespace ?? "—" },
  ];

  return (
    <CollapsibleSection
      data-testid={`feedback-row-${item.id}`}
      title={title}
      summary={summary}
      open={open}
      onOpenChange={onOpenChange}
    >
      <KVGrid items={kvItems} className="pt-1" />

      <div className="mt-3">
        <SectionLabel>Description</SectionLabel>
        <p className="whitespace-pre-wrap break-words text-[length:var(--text-body)] text-[var(--app-fg)]">
          {item.description}
        </p>
      </div>

      <div className="mt-3">
        <SectionLabel>Metadata</SectionLabel>
        <pre
          data-testid={`feedback-metadata-${item.id}`}
          className="max-h-64 overflow-auto rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
        >
          {formatMetadata(item.metadataJson)}
        </pre>
      </div>
    </CollapsibleSection>
  );
}

function Pager({
  offset,
  shown,
  total,
  onOffset,
  testIdPrefix,
}: {
  offset: number;
  shown: number;
  total: number;
  onOffset: (next: number) => void;
  testIdPrefix: string;
}) {
  const rangeStart = total === 0 ? 0 : offset + 1;
  return (
    <div className="flex items-center justify-between gap-2 py-2 text-[length:var(--text-body)] text-[var(--app-hint)]">
      <span data-testid={`${testIdPrefix}-page-info`}>
        {rangeStart}–{offset + shown} of {total}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          data-testid={`${testIdPrefix}-prev`}
          onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}
          disabled={offset === 0}
          className={ACTION_CLASS}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid={`${testIdPrefix}-next`}
          onClick={() => onOffset(offset + PAGE_SIZE)}
          disabled={offset + PAGE_SIZE >= total}
          className={ACTION_CLASS}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export default function AdminFeedbackPage() {
  useDocumentTitle("Feedback - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();

  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const [statusView, setStatusView] = useState<StatusView>("open");
  const [category, setCategory] = useState<"" | FeedbackListItem["category"]>(
    ""
  );
  const [origin, setOrigin] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [searchText, setSearchText] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [localOffset, setLocalOffset] = useState(0);
  const [localOpen, setLocalOpen] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<RowOutcome | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQ(searchText.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText]);
  // Any filter change starts again from the first page.
  useEffect(() => {
    setOffset(0);
  }, [statusView, category, origin, sortKey, q]);
  // The kept outcome explains a row that just left THIS view; a new view or
  // page drops it.
  useEffect(() => {
    setLastOutcome(null);
  }, [statusView, category, origin, sortKey, q, offset]);

  // #2910: fail-closed — no query fires until the gate is open. #5571: the
  // gate has three non-open states — still checking, closed (the instance
  // answered 404), and a failed check (network / 5xx), which offers a retry
  // instead of claiming the inbox is unavailable.
  const preflight = useFeedbackPreflight(api);
  const enabled = preflight.data?.enabled === true;
  const gate: "open" | "closed" | "failed" | "checking" = preflight.data
    ? preflight.data.enabled
      ? "open"
      : "closed"
    : preflight.isError
      ? "failed"
      : "checking";

  const [originKind, originInstanceId] = origin === "" ? [] : origin.split(":");
  const filters: Partial<FeedbackInboxFilters> = {
    status: STATUS_VIEWS[statusView]
      ? [...STATUS_VIEWS[statusView]]
      : undefined,
    category: category === "" ? undefined : category,
    originKind: originKind as FeedbackInboxFilters["originKind"] | undefined,
    originInstanceId,
    q: q === "" ? undefined : q,
    sort: SORTS[sortKey].sort,
    dir: SORTS[sortKey].dir,
    limit: PAGE_SIZE,
    offset,
  };
  const inbox = useFeedbackInbox(api, filters, { enabled: gate === "open" });
  const { counts } = useFeedbackInboxCounts(api, {
    enabled: gate === "open",
  });
  const actions = useFeedbackActions(api);

  const local = useFeedbackList(
    api,
    { limit: PAGE_SIZE, offset: localOffset },
    { enabled }
  );
  // This node's rows the central inbox cannot show (not forwarded), or whose
  // email failed — the durable safety net (#2666 R3).
  const localRows = local.items.filter(
    item =>
      (item.forwardState !== undefined && item.forwardState !== "forwarded") ||
      !item.emailed
  );

  const makeToggle = (key: string) => (next: boolean) =>
    setOpenKeys(prev => {
      const set = new Set(prev);
      if (next) set.add(key);
      else set.delete(key);
      return set;
    });

  const statusCount = (view: StatusView): number | null => {
    if (!counts) return null;
    if (view === "all") return counts.total;
    if (view === "open") return counts.new + counts.acknowledged;
    return counts[view];
  };

  const activeFilters: Array<{ label: string; clear: () => void }> = [];
  if (statusView !== "open") {
    activeFilters.push({
      label: `Status: ${statusView === "all" ? "All" : STATUS_LABEL[statusView]}`,
      clear: () => setStatusView("open"),
    });
  }
  if (category !== "") {
    activeFilters.push({
      label: `Category: ${CATEGORY_LABEL[category]}`,
      clear: () => setCategory(""),
    });
  }
  if (origin !== "") {
    const label =
      counts?.origins.find(
        o => `${o.originKind}:${o.originInstanceId}` === origin
      )?.originLabel ?? originInstanceId;
    activeFilters.push({
      label: `Origin: ${label}`,
      clear: () => setOrigin(""),
    });
  }
  if (q !== "") {
    activeFilters.push({
      label: `Search: ${q}`,
      clear: () => setSearchText(""),
    });
  }

  const localSection = (forceOpen: boolean) => (
    <CollapsibleSection
      data-testid="feedback-local-section"
      title={<span>This node — local / unforwarded</span>}
      summary={<span>{localRows.length} on this page</span>}
      open={forceOpen || localOpen}
      onOpenChange={setLocalOpen}
    >
      {local.isLoading ? (
        <p className={MUTED_TEXT}>Loading…</p>
      ) : local.isError ? (
        <p data-testid="feedback-error" className={MUTED_TEXT}>
          Could not load feedback.
        </p>
      ) : localRows.length === 0 ? (
        <p data-testid="feedback-empty" className={MUTED_TEXT}>
          Nothing on this node that the inbox is missing.
        </p>
      ) : (
        <div data-testid="feedback-list" className="flex flex-col gap-2 py-2">
          {localRows.map(item => (
            <LocalFeedbackRow
              key={item.id}
              item={item}
              open={openKeys.has(`local:${item.id}`)}
              onOpenChange={makeToggle(`local:${item.id}`)}
            />
          ))}
        </div>
      )}
      {local.total > PAGE_SIZE && (
        <Pager
          offset={localOffset}
          shown={local.items.length}
          total={local.total}
          onOffset={setLocalOffset}
          testIdPrefix="feedback"
        />
      )}
    </CollapsibleSection>
  );

  return (
    <div
      data-testid="settings-feedback-root"
      className="flex h-full flex-col overflow-y-auto"
    >
      <SettingsSectionHeader
        icon={<TitleChip icon={MessageSquare} accent={FEEDBACK_ACCENT} />}
        title="Feedback"
      />

      <div className="mx-auto min-h-0 w-full max-w-content flex-1 px-4 pb-4">
        {/* #2910: the gate is checked FIRST — a disabled query reports
            isLoading=false, so a non-open gate must never fall through. */}
        {gate === "checking" ? (
          <p data-testid="feedback-checking" className={MUTED_TEXT}>
            Checking…
          </p>
        ) : gate === "failed" ? (
          <div
            data-testid="feedback-check-failed"
            className="flex flex-col items-center gap-3 py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
          >
            <p>
              Couldn&apos;t check whether the feedback inbox is available here.
            </p>
            <Button
              type="button"
              variant="outline"
              data-testid="feedback-check-retry"
              onClick={() => void preflight.refetch()}
              disabled={preflight.isFetching}
              className={ACTION_CLASS}
            >
              Retry
            </Button>
          </div>
        ) : gate === "closed" ? (
          <p data-testid="feedback-disabled" className={MUTED_TEXT}>
            The feedback inbox is not available on this instance.
          </p>
        ) : inbox.isError ? (
          <div className="flex flex-col gap-2 py-2">
            <p
              role="status"
              data-testid="feedback-inbox-degraded"
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-[length:var(--text-body)] text-[var(--app-hint)]"
            >
              The shared inbox can&apos;t be reached from this node (no gateway
              credential here, or the gateway is down). Showing this node&apos;s
              own feedback only.
            </p>
            {localSection(true)}
          </div>
        ) : (
          <>
            <div
              data-testid="feedback-inbox-toolbar"
              className="flex flex-col gap-2 py-2"
            >
              <input
                className={`${CONTROL_CLASS} min-w-0`}
                type="search"
                placeholder="Search feedback, submitters and origins"
                aria-label="Search feedback"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                data-testid="feedback-inbox-search"
              />
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className={CONTROL_CLASS}
                  value={statusView}
                  onChange={e => setStatusView(e.target.value as StatusView)}
                  aria-label="Status"
                  data-testid="feedback-inbox-status"
                >
                  {(Object.keys(STATUS_VIEWS) as StatusView[]).map(view => {
                    const n = statusCount(view);
                    const label =
                      view === "open"
                        ? "Open"
                        : view === "all"
                          ? "All"
                          : STATUS_LABEL[view];
                    return (
                      <option key={view} value={view}>
                        {n === null ? label : `${label} (${n})`}
                      </option>
                    );
                  })}
                </select>
                <select
                  className={CONTROL_CLASS}
                  value={category}
                  onChange={e => setCategory(e.target.value as typeof category)}
                  aria-label="Category"
                  data-testid="feedback-inbox-category"
                >
                  <option value="">All categories</option>
                  {(
                    Object.keys(CATEGORY_LABEL) as Array<
                      FeedbackListItem["category"]
                    >
                  ).map(c => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
                <select
                  className={CONTROL_CLASS}
                  value={origin}
                  onChange={e => setOrigin(e.target.value)}
                  aria-label="Origin"
                  data-testid="feedback-inbox-origin"
                >
                  <option value="">All origins</option>
                  {(counts?.origins ?? []).map(o => (
                    <option
                      key={`${o.originKind}:${o.originInstanceId}`}
                      value={`${o.originKind}:${o.originInstanceId}`}
                    >
                      {o.originLabel} ({o.count})
                    </option>
                  ))}
                </select>
                <select
                  className={CONTROL_CLASS}
                  value={sortKey}
                  onChange={e => setSortKey(e.target.value as SortKey)}
                  aria-label="Sort"
                  data-testid="feedback-inbox-sort"
                >
                  {(Object.keys(SORTS) as SortKey[]).map(key => (
                    <option key={key} value={key}>
                      {SORTS[key].label}
                    </option>
                  ))}
                </select>
              </div>
              {activeFilters.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {activeFilters.map(f => (
                    <FilterChip
                      key={f.label}
                      label={f.label}
                      active
                      onClick={f.clear}
                      ariaLabel={`Clear ${f.label}`}
                    />
                  ))}
                </div>
              )}
            </div>

            {lastOutcome !== null &&
              !inbox.items.some(item => item.id === lastOutcome.id) && (
                <p
                  role={lastOutcome.alert ? "alert" : "status"}
                  data-testid="feedback-inbox-outcome"
                  className={MUTED_TEXT}
                >
                  {lastOutcome.text}
                </p>
              )}
            {inbox.isLoading ? (
              <p data-testid="feedback-loading" className={MUTED_TEXT}>
                Loading…
              </p>
            ) : inbox.items.length === 0 ? (
              <p data-testid="feedback-inbox-empty" className={MUTED_TEXT}>
                {statusView === "open" && activeFilters.length === 0
                  ? "Inbox zero — nothing open."
                  : "No feedback matches these filters."}
              </p>
            ) : (
              <>
                <div
                  data-testid="feedback-inbox-list"
                  className="flex flex-col gap-2 py-2"
                >
                  {inbox.items.map(item => (
                    <InboxRow
                      key={item.id}
                      item={item}
                      open={openKeys.has(item.id)}
                      onOpenChange={makeToggle(item.id)}
                      onOutcome={setLastOutcome}
                      actions={actions}
                    />
                  ))}
                </div>
                <Pager
                  offset={offset}
                  shown={inbox.items.length}
                  total={inbox.total}
                  onOffset={setOffset}
                  testIdPrefix="feedback-inbox"
                />
              </>
            )}

            <div className="mt-4">{localSection(false)}</div>
          </>
        )}
      </div>
    </div>
  );
}
