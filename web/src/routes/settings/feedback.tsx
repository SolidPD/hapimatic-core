// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { MessageSquare } from "lucide-react";
import type { FeedbackListItem } from "@/types/api";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useFeedbackList } from "@/hooks/queries/useFeedbackList";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { KVGrid } from "@/components/ui/KVGrid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * AdminFeedbackPage — the `/settings/feedback` route (issue #2666, epic #2663 Sub C).
 *
 * A read-only admin viewer of the persisted `feedback` rows (#2664), the durable
 * complement to the AgentMail email channel — the "email got lost" safety net.
 * Modeled on `session-metadata.tsx`: a shared `SettingsSectionHeader` + a list of
 * `CollapsibleSection` rows whose expanded body is a `KVGrid` plus the full
 * description and the scrubbed, read-only `metadata_json`.
 *
 * R3 (durable safety net): each row surfaces its `emailed`/`emailError` state —
 * a persist-only row (`emailed=false`) is visibly flagged "Not emailed", proving
 * feedback survives even when the email send is off / fails.
 *
 * Auth: `GET /api/feedback` mounts behind the JWT gate (server.ts) — the page is
 * reachable only inside the authenticated app, and the fetch is JWT-bearing.
 * The list is node-global (the documented permissive bulk-read tier); role-gated
 * reads are future hardening (cf. epic #2494).
 */

const PAGE_SIZE = 50;
const FEEDBACK_ACCENT = "var(--accent-pink-400)"; // pink — distinct from Error Log's rose

const CATEGORY_LABEL: Record<FeedbackListItem["category"], string> = {
  bug: "Bug",
  feature: "Feature",
  other: "Other",
};

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

function FeedbackRow({
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
        <p className="mb-1 text-[length:var(--text-body-dense)] uppercase tracking-wide text-[var(--app-hint)]">
          Description
        </p>
        <p className="whitespace-pre-wrap break-words text-[length:var(--text-body)] text-[var(--app-fg)]">
          {item.description}
        </p>
      </div>

      <div className="mt-3">
        <p className="mb-1 text-[length:var(--text-body-dense)] uppercase tracking-wide text-[var(--app-hint)]">
          Metadata
        </p>
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

export default function AdminFeedbackPage() {
  useDocumentTitle("Feedback - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();

  const [offset, setOffset] = useState(0);
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());

  const { items, total, isLoading, isError } = useFeedbackList(api, {
    limit: PAGE_SIZE,
    offset,
  });

  const makeToggle = (key: string) => (next: boolean) =>
    setOpenKeys(prev => {
      const set = new Set(prev);
      if (next) set.add(key);
      else set.delete(key);
      return set;
    });

  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = offset + items.length;
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

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
        {isLoading ? (
          <p
            data-testid="feedback-loading"
            className="py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
          >
            Loading…
          </p>
        ) : isError ? (
          <p
            data-testid="feedback-error"
            className="py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
          >
            Could not load feedback.
          </p>
        ) : items.length === 0 ? (
          <p
            data-testid="feedback-empty"
            className="py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
          >
            No feedback submitted yet.
          </p>
        ) : (
          <>
            <div
              data-testid="feedback-list"
              className="flex flex-col gap-2 py-2"
            >
              {items.map(item => (
                <FeedbackRow
                  key={item.id}
                  item={item}
                  open={openKeys.has(item.id)}
                  onOpenChange={makeToggle(item.id)}
                />
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 py-2 text-[length:var(--text-body)] text-[var(--app-hint)]">
              <span data-testid="feedback-page-info">
                {rangeStart}–{rangeEnd} of {total}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  data-testid="feedback-prev"
                  onClick={() =>
                    setOffset(prev => Math.max(0, prev - PAGE_SIZE))
                  }
                  disabled={!canPrev}
                  className="h-auto rounded-md px-3 py-1 text-[length:var(--text-body)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-40"
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="feedback-next"
                  onClick={() => setOffset(prev => prev + PAGE_SIZE)}
                  disabled={!canNext}
                  className="h-auto rounded-md px-3 py-1 text-[length:var(--text-body)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-40"
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
