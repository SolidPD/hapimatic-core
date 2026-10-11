// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { ScrollText } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { TranscriptSort, TranscriptSummary } from "@hapi/protocol/schemas";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { DenseRow } from "@/components/ui/DenseRow";
import { KVGrid } from "@/components/ui/KVGrid";
import { FilterChip } from "@/components/ui/FilterChip";
import {
  SegmentedToggle,
  type SegmentedToggleOption,
} from "@/components/ui/SegmentedToggle";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { useToast } from "@/components/Toast";
import { DirectoryBrowser } from "@/components/NewSession/DirectoryBrowser";
import { TranscriptReader } from "@/components/transcripts/TranscriptReader";
import type { ApiClient } from "@/api/client";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import {
  type TranscriptFilters,
  useResumeTranscript,
  useTranscriptFilterOptions,
  useTranscripts,
} from "@/hooks/queries/useTranscripts";

/**
 * TranscriptsPage — the `/settings/transcripts` route (issue #3839). The archive
 * of every Claude-harness transcript ever run on this node, including sessions
 * deleted since, scoped to the caller's namespace (D27): full-text search,
 * filters (date, harness, account, repo, linked issue), sort, in-place reading
 * through the chat renderers (R3), and one-click resume (R4, D28).
 *
 * Registered in BOTH `router.tsx` (route) and `settings/index.tsx` (nav row) —
 * the #2344 lesson: an unregistered route is an invisible page.
 */

const SORT_OPTIONS: SegmentedToggleOption<TranscriptSort>[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "largest", label: "Largest" },
];

type Range = "any" | "7d" | "30d";
const RANGE_OPTIONS: SegmentedToggleOption<Range>[] = [
  { value: "any", label: "Any time" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];
const DAY_MS = 24 * 60 * 60 * 1000;

const SELECT_CLASS =
  "rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2 py-1 text-[length:var(--text-body)] text-[var(--app-fg)]";

function fmtDate(ms: number | null): string {
  return ms === null ? "—" : new Date(ms).toLocaleString();
}

/**
 * Display title for a transcript row. A slash-command launch records its first
 * prompt as Claude Code's `<command-message>…<command-name>/x</command-name>
 * <command-args>…</command-args>` envelope; show it as "/x args" instead of raw
 * markup. Display-only — the indexed text stays verbatim for search.
 */
export function displayTitle(raw: string): string {
  return (
    raw
      .replace(/<command-message>[\s\S]*?<\/command-message>/g, " ")
      .replace(/<\/?[a-z][a-z-]*>/g, " ")
      // A title capped mid-envelope ends in a partial tag ("… <command-args").
      .replace(/<\/?[a-z-]*$/, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type PickerState = {
  ccSessionId: string;
  machineId: string;
  initialPath: string;
};

export default function TranscriptsPage() {
  useDocumentTitle("Transcripts - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [sort, setSort] = useState<TranscriptSort>("newest");
  const [range, setRange] = useState<Range>("any");
  // The date bound is captured when the range is chosen (not per render), so the
  // query key stays stable and the list does not refetch in a loop.
  const [fromMs, setFromMs] = useState<number | undefined>(undefined);
  const [harness, setHarness] = useState("");
  const [account, setAccount] = useState("");
  const [repo, setRepo] = useState("");
  const [linkedIssue, setLinkedIssue] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);

  // Paging is offset-based inside useTranscripts (#4050); every filter here is
  // part of its query key, so any change restarts at the first page.
  const query: TranscriptFilters = {
    ...(submitted ? { q: submitted } : {}),
    ...(fromMs !== undefined ? { fromMs } : {}),
    ...(harness ? { harness } : {}),
    ...(account ? { account } : {}),
    ...(repo ? { repo } : {}),
    ...(linkedIssue ? { linkedIssue: Number(linkedIssue) } : {}),
    sort,
  };
  const list = useTranscripts(api, query);
  const { options } = useTranscriptFilterOptions(api);
  const resume = useResumeTranscript(api);

  const rows = list.transcripts;
  const status = list.status;

  function doResume(ccSessionId: string, directory?: string) {
    resume.mutate(
      { ccSessionId, directory },
      {
        onSuccess: result => {
          if (result.type === "needsDirectory") {
            setPicker({
              ccSessionId,
              machineId: result.machineId,
              initialPath: result.suggestedDirectory,
            });
            return;
          }
          setPicker(null);
          showToast(
            result.restoredWorktree
              ? `Restored the worktree at ${result.directory} and resumed the transcript.`
              : "Transcript resumed."
          );
          void navigate({
            to: "/sessions/$sessionId",
            params: { sessionId: result.sessionId },
          });
        },
        onError: error => {
          showToast(`Resume failed: ${error.message}`);
        },
      }
    );
  }

  const activeFilters: Array<{ label: string; clear: () => void }> = [
    ...(harness
      ? [{ label: `Harness: ${harness}`, clear: () => setHarness("") }]
      : []),
    ...(account
      ? [{ label: `Account: ${account}`, clear: () => setAccount("") }]
      : []),
    ...(repo ? [{ label: `Repo: ${repo}`, clear: () => setRepo("") }] : []),
    ...(linkedIssue
      ? [{ label: `Issue #${linkedIssue}`, clear: () => setLinkedIssue("") }]
      : []),
  ];

  return (
    <div
      data-testid="settings-transcripts-root"
      className="h-full overflow-y-auto"
    >
      <SettingsSectionHeader
        icon={<TitleChip icon={ScrollText} accent="var(--accent-mint)" />}
        title="Transcripts"
      />
      <div className="mx-auto flex w-full max-w-content flex-col gap-3 px-4 pb-6">
        <p
          className="text-xs text-[var(--app-hint)]"
          data-testid="transcripts-scope-banner"
        >
          The archive of every Claude-harness transcript ever run on this node,
          scoped to your namespace — including sessions that have since been
          deleted. Secret tokens are masked.
        </p>

        {status?.disabled ? (
          // #4053 (M8): "Indexed 0 of 0" over a stale list read as "you have
          // no transcripts"; say what is actually happening.
          <p
            className="text-xs text-[var(--app-hint)]"
            data-testid="transcripts-index-disabled"
          >
            Indexing is disabled on this instance — the list and search reflect
            the last index, and new transcripts are not added.
          </p>
        ) : status ? (
          <p
            className="text-xs text-[var(--app-hint)]"
            data-testid="transcripts-index-status"
          >
            Indexed {status.indexed} of {status.total}
            {status.fts5 ? "" : " · search is running in basic mode"}
          </p>
        ) : null}

        <form
          className="flex gap-2"
          onSubmit={e => {
            e.preventDefault();
            setSubmitted(search.trim());
          }}
        >
          <input
            className={`${SELECT_CLASS} min-w-0 flex-1`}
            type="search"
            placeholder='Search transcripts (use "quotes" for a phrase)'
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search transcripts"
            data-testid="transcripts-search"
          />
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedToggle
            options={RANGE_OPTIONS}
            value={range}
            onChange={next => {
              setRange(next);
              setFromMs(
                next === "any"
                  ? undefined
                  : Date.now() - (next === "7d" ? 7 : 30) * DAY_MS
              );
            }}
            ariaLabel="Date range"
            testIdPrefix="transcripts-range"
          />
          <SegmentedToggle
            options={SORT_OPTIONS}
            value={sort}
            onChange={setSort}
            ariaLabel="Sort"
            testIdPrefix="transcripts-sort"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            className={SELECT_CLASS}
            value={harness}
            onChange={e => setHarness(e.target.value)}
            aria-label="Harness"
          >
            <option value="">All harnesses</option>
            {(options?.harnesses ?? []).map(h => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          <select
            className={SELECT_CLASS}
            value={account}
            onChange={e => setAccount(e.target.value)}
            aria-label="Account"
          >
            <option value="">All accounts</option>
            {(options?.accounts ?? []).map(a => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select
            className={SELECT_CLASS}
            value={repo}
            onChange={e => setRepo(e.target.value)}
            aria-label="Repo"
          >
            <option value="">All repos</option>
            {(options?.repos ?? []).map(r => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            className={SELECT_CLASS}
            value={linkedIssue}
            onChange={e => setLinkedIssue(e.target.value)}
            aria-label="Linked issue"
            data-testid="transcripts-issue-filter"
          >
            <option value="">Any linked issue</option>
            {(options?.linkedIssues ?? []).map(n => (
              <option key={n} value={String(n)}>
                #{n}
              </option>
            ))}
          </select>
        </div>

        {activeFilters.length > 0 ? (
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
        ) : null}

        {list.isLoading ? (
          <p className="py-6 text-sm text-[var(--app-hint)]">
            Loading transcripts…
          </p>
        ) : list.isError ? (
          <p
            className="py-6 text-sm text-[var(--app-hint)]"
            data-testid="transcripts-error"
          >
            The transcript archive is unavailable on this instance.
          </p>
        ) : rows.length === 0 ? (
          <p
            className="py-6 text-sm text-[var(--app-hint)]"
            data-testid="transcripts-empty"
          >
            {status?.disabled
              ? "Indexing is disabled on this instance, so there is nothing to search."
              : "No transcripts match."}
          </p>
        ) : (
          <div className="flex flex-col" data-testid="transcripts-list">
            {rows.map(t => (
              <TranscriptRow
                key={t.ccSessionId}
                api={api}
                transcript={t}
                open={openId === t.ccSessionId}
                onToggle={() =>
                  setOpenId(openId === t.ccSessionId ? null : t.ccSessionId)
                }
                onResume={() => doResume(t.ccSessionId)}
                resuming={
                  resume.isPending &&
                  resume.variables?.ccSessionId === t.ccSessionId
                }
              />
            ))}
            {list.loadMoreError ? (
              <p
                className="py-2 text-xs text-[var(--app-hint)]"
                data-testid="transcripts-load-more-error"
              >
                Couldn't load more transcripts. Try again.
              </p>
            ) : null}
            {list.hasMore ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={list.loadMore}
                disabled={list.isLoadingMore}
                data-testid="transcripts-show-more"
              >
                {list.isLoadingMore
                  ? "Loading…"
                  : `Show more (${rows.length} of ${list.total})`}
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {picker && api ? (
        <DirectoryBrowser
          api={api}
          machineId={picker.machineId}
          initialPath={picker.initialPath}
          onSelect={path => doResume(picker.ccSessionId, path)}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </div>
  );
}

function TranscriptRow(props: {
  api: ApiClient | null;
  transcript: TranscriptSummary;
  open: boolean;
  onToggle: () => void;
  onResume: () => void;
  resuming: boolean;
}) {
  const t = props.transcript;
  const title = displayTitle(t.title ?? t.firstPrompt ?? "") || t.ccSessionId;
  const sub = [
    fmtDate(t.lastActivityMs),
    t.repo,
    t.linkedIssue !== null ? `#${t.linkedIssue}` : null,
    t.hasSessionRow ? null : "deleted session",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="border-b border-[var(--app-hover)]"
      data-testid="transcript-row"
    >
      <BareButton
        type="button"
        // BareButton's base is `inline-flex justify-center whitespace-nowrap`,
        // which lets the row overflow its parent and centers it off-screen on a
        // phone (measured at 393px: row 1325px wide, left -473px). Start-align,
        // allow wrapping, and let the row shrink so each line truncates instead.
        className="w-full justify-start whitespace-normal text-left"
        onClick={props.onToggle}
        aria-expanded={props.open}
      >
        <DenseRow
          className="w-full min-w-0"
          label={
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[var(--app-fg)]">{title}</span>
              <span className="truncate text-xs text-[var(--app-hint)]">
                {sub}
              </span>
            </span>
          }
          trailing={
            <span className="text-xs text-[var(--app-hint)]">
              {fmtSize(t.sizeBytes)}
            </span>
          }
        />
      </BareButton>
      {t.snippet ? (
        <p
          className="px-3 pb-2 text-xs text-[var(--app-hint)]"
          data-testid="transcript-snippet"
        >
          {t.snippet}
        </p>
      ) : null}
      {props.open && props.api ? (
        <div className="flex flex-col gap-3 px-3 pb-4">
          <KVGrid
            items={[
              { key: "Started", value: fmtDate(t.startedAtMs) },
              { key: "Last activity", value: fmtDate(t.lastActivityMs) },
              { key: "Directory", value: t.cwd ?? "—" },
              { key: "Branch", value: t.gitBranch ?? "—" },
              { key: "Account", value: t.account ?? "—" },
              { key: "Messages", value: String(t.messageCount) },
            ]}
          />
          <div>
            <Button
              size="sm"
              onClick={props.onResume}
              disabled={props.resuming}
              data-testid="transcript-resume"
            >
              {props.resuming ? "Resuming…" : "Resume in a new session"}
            </Button>
          </div>
          <TranscriptReader api={props.api} ccSessionId={t.ccSessionId} />
        </div>
      ) : null}
    </div>
  );
}
