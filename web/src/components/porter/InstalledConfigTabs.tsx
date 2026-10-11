// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, X } from "lucide-react";
import { useAppContext } from "@/lib/app-context";
import { ApiError, type ApiClient } from "@/api/client";
import { usePorterInstalled } from "@/hooks/queries/usePorterInstalled";
import {
  usePorterContent,
  type PorterContentSelection,
} from "@/hooks/queries/usePorterContent";
import { useMcpStatus } from "@/hooks/useMcpStatus";
import { PorterExtractionPrompt } from "@/components/porter/PorterExtractionPrompt";
import { PorterImportPanel } from "@/components/porter/PorterImportPanel";
import type {
  InstalledConfigResponse,
  RegisteredHook,
  ImportPlanSummary,
} from "@/types/porter";
import type { McpServerStatus } from "@/types/api";
import { Button } from "@/components/ui/button";

/** Case-insensitive substring filter + direction-aware name sort (#2745). */
export function filterSortNames(
  names: string[],
  query: string,
  sortDir: "asc" | "desc"
): string[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? names.filter(n => n.toLowerCase().includes(q))
    : [...names];
  filtered.sort((a, b) =>
    sortDir === "asc" ? a.localeCompare(b) : b.localeCompare(a)
  );
  return filtered;
}

/**
 * InstalledConfigTabs — the "what is currently installed" surface of the Admin →
 * Configuration page (issue #2344, R1). Four tabs: Skills, Hooks, MCP Servers,
 * Agents. R1's distinguishing word is *installed*, not importable — every tab
 * lists what the instance already has, read server-side.
 *
 *  - Skills / Agents  → `GET /api/porter/installed` (#2343).
 *  - Hooks            → the SAME endpoint, but rendered as BOTH halves (files on
 *    disk / settings.json registrations) with orphan states surfaced (directive
 *    D5). This page is where a user would actually notice a dead hook, so a
 *    single collapsed row is exactly the wrong shape.
 *  - MCP Servers      → the EXISTING `GET /api/mcp-status` (via `useMcpStatus`),
 *    NOT duplicated into the porter endpoint. Carries the F1 per-account caveat.
 */

type TabId = "skills" | "hooks" | "mcp" | "agents" | "import";

const MCP_STATUS_META: Record<
  McpServerStatus["status"],
  { label: string; color: string }
> = {
  connected: { label: "Connected", color: "var(--status-ok)" },
  hosted: { label: "Hosted", color: "var(--accent-cyan)" }, // decorative accent, not a status token (#2508); converged onto --accent-cyan (#3355)
  needs_auth: { label: "Needs auth", color: "var(--status-warn)" },
  failed: { label: "Failed", color: "var(--status-hot)" },
  // #2142: extended status union. `unknown` = an mcp-list line the parser could
  // not classify (drift-visible, never dropped); `pending_approval` = a ⏸
  // project-scoped server awaiting approval.
  unknown: {
    label: "Unknown",
    color: "var(--status-mcp-unknown)",
  },
  pending_approval: {
    label: "Pending approval",
    color: "var(--status-mcp-pending-approval)",
  },
};

function EmptyState({ label }: { label: string }) {
  return (
    <p className="py-4 text-sm text-[var(--app-hint)]" data-testid="tab-empty">
      No {label} installed on this instance.
    </p>
  );
}

/** A clickable name list (skills / agents). Selecting a row drives the preview
 * pane (#3116); the active row is highlighted. */
function NameList({
  names,
  kind,
  onSelect,
  selectedName,
}: {
  names: string[];
  kind: string;
  onSelect: (name: string) => void;
  selectedName: string | null;
}) {
  if (names.length === 0) return <EmptyState label={kind} />;
  return (
    <ul className="flex flex-col" role="list" data-testid={`list-${kind}`}>
      {names.map(name => (
        <li
          key={name}
          className="border-b border-[var(--app-border)] last:border-b-0"
        >
          <Button
            type="button"
            variant="ghostStatic"
            onClick={() => onSelect(name)}
            data-testid={`row-${kind}`}
            aria-pressed={selectedName === name}
            className={`h-auto w-full justify-start whitespace-normal rounded px-1 py-2 text-left font-mono text-[length:var(--text-body)] font-normal transition-colors hover:text-[var(--app-fg)] ${
              selectedName === name
                ? "bg-accent/15 text-[var(--app-fg)]"
                : "text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
            }`}
          >
            {name}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Hooks tab — BOTH halves (D5). The file list marks orphan files (present on
 * disk, no registration = dead code); the registration list marks orphan
 * registrations (registered, script missing = a hook that never fires). A
 * collapsed single-row view would hide precisely the failure the epic's
 * load-bearing requirement exists to prevent.
 */
function HooksView({
  hooks,
  claudeDir,
  onSelectFile,
  selectedName,
  query = "",
  sortDir = "asc",
}: {
  hooks: InstalledConfigResponse["hooks"];
  /** Config root, used to strip the `<claudeDir>/hooks/` prefix off row paths. */
  claudeDir: string;
  /** Select a hook file; receives the hooks-root-RELATIVE path (#3116). */
  onSelectFile: (relativePath: string) => void;
  selectedName: string | null;
  query?: string;
  sortDir?: "asc" | "desc";
}) {
  // 🔴 Hook file rows carry ABSOLUTE paths (`collectHookFiles` → `join(dir, name)`
  // rooted at `<claudeDir>/hooks`). The content endpoint rejects absolute names by
  // design, so send the hooks-root-RELATIVE path (subdir scripts → multi-segment).
  const hooksRoot = `${claudeDir}/hooks/`;
  const toRel = (f: string): string =>
    f.startsWith(hooksRoot) ? f.slice(hooksRoot.length) : f;
  const orphanFiles = new Set(hooks.orphanFiles);
  const orphanRegistrations = new Set(hooks.orphanRegistrations);
  const registrationKey = (h: RegisteredHook) =>
    `${h.event}::${h.matcher ?? ""}::${h.command}`;

  // #2745 feedback: filter both halves by substring across event/matcher/command
  // (registrations) or path (files); sort by the row's primary text.
  const q = query.trim().toLowerCase();
  const dir = sortDir === "asc" ? 1 : -1;
  const registrations = hooks.registrations
    .filter(
      h =>
        !q ||
        `${h.event} ${h.matcher ?? ""} ${h.command}`.toLowerCase().includes(q)
    )
    .sort((a, b) => dir * registrationKey(a).localeCompare(registrationKey(b)));
  const files = hooks.files
    .filter(f => !q || f.toLowerCase().includes(q))
    .sort((a, b) => dir * a.localeCompare(b));

  if (hooks.files.length === 0 && hooks.registrations.length === 0) {
    return <EmptyState label="hooks" />;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="hooks-view">
      <section>
        <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
          Registered ({registrations.length})
        </h3>
        {registrations.length === 0 ? (
          <p className="py-1 text-[length:var(--text-body)] text-[var(--app-hint)]">
            No hook registrations in settings.json.
          </p>
        ) : (
          <ul className="flex flex-col" role="list">
            {registrations.map(h => {
              const dead = orphanRegistrations.has(h.command);
              return (
                <li
                  key={registrationKey(h)}
                  className="flex items-start gap-2 border-b border-[var(--app-border)] py-2 last:border-b-0"
                  data-testid={
                    dead ? "hook-registration-orphan" : "hook-registration"
                  }
                >
                  {dead ? (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-hot" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-ok" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
                      {h.event}
                      {h.matcher ? (
                        <span className="text-[var(--app-hint)]">
                          {" "}
                          · {h.matcher}
                        </span>
                      ) : null}
                    </div>
                    <div className="break-all font-mono text-[length:var(--text-caption)] text-[var(--app-hint)]">
                      {h.command}
                    </div>
                    {dead && (
                      <div className="text-[length:var(--text-caption)] font-medium text-hot">
                        ⚠️ Registered, but the script file is missing — this
                        hook never fires.
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
          Files on disk ({files.length})
        </h3>
        {files.length === 0 ? (
          <p className="py-1 text-[length:var(--text-body)] text-[var(--app-hint)]">
            No hook script files present.
          </p>
        ) : (
          <ul className="flex flex-col" role="list">
            {files.map(file => {
              const dead = orphanFiles.has(file);
              const rel = toRel(file);
              return (
                <li
                  key={file}
                  className="flex items-start gap-2 border-b border-[var(--app-border)] py-2 last:border-b-0"
                  data-testid={dead ? "hook-file-orphan" : "hook-file"}
                >
                  {dead ? (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warn" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-ok" />
                  )}
                  <div className="min-w-0 flex-1">
                    <Button
                      type="button"
                      variant="ghostStatic"
                      onClick={() => onSelectFile(rel)}
                      data-testid="hook-file-row"
                      aria-pressed={selectedName === rel}
                      className={`h-auto w-full justify-start whitespace-normal break-all rounded p-0 text-left font-mono text-[length:var(--text-body-dense)] font-normal transition-colors hover:text-[var(--app-fg)] ${
                        selectedName === rel
                          ? "bg-accent/15 text-[var(--app-fg)]"
                          : "text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                      }`}
                    >
                      {file}
                    </Button>
                    {dead && (
                      <div className="text-[length:var(--text-caption)] font-medium text-warn">
                        ⚠️ Present on disk, but nothing registers it — dead
                        code.
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * MCP Servers tab — reads the live host `~/.claude.json` status. F1: host-level
 * presence is NOT the same as per-account-session presence. A freshly imported
 * server only reaches account-bound sessions after #2343's per-account merge, so
 * the caveat is stated explicitly rather than implying a single host-level truth.
 */
function McpView({
  onSelect,
  selectedName,
  query = "",
  sortDir = "asc",
}: {
  /** Select an MCP server to preview its `~/.claude.json` stanza (#3116). */
  onSelect: (name: string) => void;
  selectedName: string | null;
  query?: string;
  sortDir?: "asc" | "desc";
}) {
  const { servers, isLoading, disabledServers } = useMcpStatus();
  const disabled = new Set(disabledServers);
  // #2745 feedback: name filter + direction-aware sort.
  const q = query.trim().toLowerCase();
  const dir = sortDir === "asc" ? 1 : -1;
  const shown = servers
    .filter(s => !q || s.name.toLowerCase().includes(q))
    .sort((a, b) => dir * a.name.localeCompare(b.name));

  return (
    <div className="flex flex-col gap-3" data-testid="mcp-view">
      <p className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2 text-[length:var(--text-caption)] text-[var(--app-hint)]">
        Reflects this host's <span className="font-mono">~/.claude.json</span>.
        A server shown here is only present in a session once that session's
        account has received the import — see the per-account status in the
        Import tab's result.
      </p>
      {isLoading && (
        <p className="py-2 text-sm text-[var(--app-hint)]">
          Loading MCP status…
        </p>
      )}
      {!isLoading && shown.length === 0 && <EmptyState label="MCP servers" />}
      {shown.length > 0 && (
        <ul className="flex flex-col" role="list" data-testid="list-mcp">
          {shown.map(s => {
            const meta = MCP_STATUS_META[s.status];
            const isDisabled = disabled.has(s.name);
            return (
              <li
                key={s.name}
                className="border-b border-[var(--app-border)] last:border-b-0"
              >
                <Button
                  type="button"
                  variant="ghostStatic"
                  onClick={() => onSelect(s.name)}
                  data-testid="row-mcp"
                  aria-pressed={selectedName === s.name}
                  className={`flex h-auto w-full items-center justify-start gap-2 rounded px-1 py-2 text-left font-normal transition-colors hover:text-[var(--app-fg)] ${
                    selectedName === s.name
                      ? "bg-accent/15"
                      : "hover:bg-[var(--app-secondary-bg)]"
                  }`}
                >
                  <span
                    className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: meta.color }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
                    {s.name}
                  </span>
                  <span
                    className="flex-shrink-0 text-[length:var(--text-caption)]"
                    style={{ color: meta.color }}
                  >
                    {isDisabled ? "Disabled" : meta.label}
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Preview pane (#3116 R1/R2). Reads the selected item's file text and shows the
 * exact absolute host path with a click-to-copy affordance. Handles the loading,
 * error, binary, oversized, and friendly-404 (MCP not in `~/.claude.json`) states.
 * The copy fallback (catch → leave path visible) covers the iOS-PWA insecure-context
 * case, mirroring `PorterExtractionPrompt`.
 */
function PreviewPane({
  api,
  selected,
  onClose,
}: {
  api: ApiClient;
  selected: PorterContentSelection;
  onClose: () => void;
}) {
  const { data, isLoading, isError, error } = usePorterContent(api, selected);
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    if (!data?.path) return;
    try {
      await navigator.clipboard.writeText(data.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (insecure context / permissions) — the path stays
      // visible so the user can select-and-copy manually.
    }
  };

  const notFound = isError && error instanceof ApiError && error.status === 404;

  return (
    <section
      data-testid="preview-pane"
      className="mt-3 flex flex-col gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
            {selected.dimension} · {selected.name}
          </div>
          {data?.path && (
            <Button
              type="button"
              variant="ghostStatic"
              size="bare"
              onClick={handleCopy}
              data-testid="preview-copy-path"
              title="Copy host path"
              className="mt-0.5 flex max-w-full items-center justify-start gap-1.5 whitespace-normal text-left font-normal hover:text-[var(--app-fg)]"
            >
              <span className="min-w-0 break-all font-mono text-[length:var(--text-caption)] text-[var(--app-link)]">
                {data.path}
              </span>
              {copied ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-ok" />
              ) : (
                <Copy className="h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]" />
              )}
            </Button>
          )}
          {copied && (
            <span
              data-testid="preview-copied"
              className="ml-1 text-[length:var(--text-caption)] text-ok"
            >
              Copied
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="ghostStatic"
          onClick={onClose}
          data-testid="preview-close"
          title="Close preview"
          className="h-auto shrink-0 rounded p-1 text-[var(--app-hint)] hover:text-[var(--app-fg)]"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {isLoading && (
        <p className="py-2 text-[length:var(--text-body)] text-[var(--app-hint)]">
          Loading…
        </p>
      )}
      {notFound && (
        <p
          data-testid="preview-notfound"
          className="py-2 text-[length:var(--text-body)] text-[var(--app-hint)]"
        >
          {selected.dimension === "mcp"
            ? "This server is not present in the host ~/.claude.json — CLI-reported or project-scoped servers live elsewhere."
            : "This item was not found on the host."}
        </p>
      )}
      {isError && !notFound && (
        <p
          data-testid="preview-error"
          className="py-2 text-[length:var(--text-body)] text-hot"
        >
          Failed to load this file.
        </p>
      )}
      {data?.binary && (
        <p className="py-2 text-[length:var(--text-body)] text-[var(--app-hint)]">
          Binary file — preview not available.
        </p>
      )}
      {data?.truncated && (
        <p className="py-2 text-[length:var(--text-body)] text-[var(--app-hint)]">
          File too large to preview
          {typeof data.size === "number"
            ? ` (${Math.round(data.size / 1024)} KB)`
            : ""}
          .
        </p>
      )}
      {data && !data.binary && !data.truncated && (
        <pre
          data-testid="preview-content"
          className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--app-bg)] p-2 font-mono text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
        >
          {data.content}
        </pre>
      )}
    </section>
  );
}

export function InstalledConfigTabs() {
  const { api } = useAppContext();
  const [active, setActive] = useState<TabId>("skills");
  // #3116: the item whose file the preview pane shows. Reset on tab switch so a
  // skill selection never bleeds into the hooks/agents/mcp tab.
  const [selected, setSelected] = useState<PorterContentSelection | null>(null);
  const selectTab = (id: TabId): void => {
    setActive(id);
    setSelected(null);
  };
  const selectedFor = (
    dimension: PorterContentSelection["dimension"]
  ): string | null =>
    selected?.dimension === dimension ? selected.name : null;
  const { data, isLoading, isError } = usePorterInstalled(api);
  // #2745 feedback: name filter + sort direction, shared across the list tabs
  // (mirrors the System Jobs toolbar's discoverability role).
  const [query, setQuery] = useState("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // #3446 (Sub A, 1B#4): the one-liner's received plan, lifted here so the export
  // prompt (which drives the token flow) can hydrate the import panel's review UI
  // — the two are siblings with no shared cache key.
  const [receivedSummary, setReceivedSummary] = useState<
    ImportPlanSummary | undefined
  >(undefined);

  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: "skills", label: "Skills", count: data?.skills.length },
    {
      id: "hooks",
      label: "Hooks",
      count: data
        ? data.hooks.files.length + data.hooks.registrations.length
        : undefined,
    },
    { id: "mcp", label: "MCP Servers" },
    { id: "agents", label: "Agents", count: data?.agents.length },
  ];

  const isListTab = active !== "import";

  return (
    <section data-testid="installed-config-tabs">
      <div
        className="flex items-center gap-1 border-b border-[var(--app-border)]"
        role="tablist"
      >
        {tabs.map(t => (
          <Button
            key={t.id}
            type="button"
            variant="ghostStatic"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => selectTab(t.id)}
            data-testid={`tab-${t.id}`}
            className={`-mb-px h-auto rounded-none border-b-2 px-3 py-2 text-[length:var(--text-body)] font-medium transition-colors hover:text-[var(--app-fg)] ${
              active === t.id
                ? "border-accent text-[var(--app-fg)]"
                : "border-transparent text-[var(--app-hint)] hover:text-[var(--app-fg)]"
            }`}
          >
            {t.label}
            {typeof t.count === "number" && (
              <span className="ml-1 text-[var(--app-hint)]">({t.count})</span>
            )}
          </Button>
        ))}
        {/* #2745 feedback: the Import tab hosts the extraction prompt + import
            panel (previously stacked below every tab) and is styled as a mint
            rounded-rect button so the eye lands on it as the special tab. */}
        <Button
          type="button"
          variant="ghostStatic"
          role="tab"
          aria-selected={active === "import"}
          onClick={() => selectTab("import")}
          data-testid="tab-import"
          className={`ml-auto my-1.5 h-auto rounded-lg border border-accent px-3 py-1.5 text-[length:var(--text-body)] font-medium text-accent transition-colors hover:text-accent ${
            active === "import" ? "bg-accent/15" : "hover:bg-accent/10"
          }`}
        >
          Import
        </Button>
      </div>

      {/* #2745 feedback: filter + sort toolbar for the list tabs. */}
      {isListTab && (
        <div className="flex items-center gap-2 pt-2">
          <input
            autoCapitalize="none"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter by name…"
            data-testid="config-filter"
            className="w-full max-w-xs rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2 py-1 text-[length:var(--text-body)] text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
          />
          <Button
            type="button"
            variant="ghostStatic"
            data-testid="config-sort"
            onClick={() => setSortDir(d => (d === "asc" ? "desc" : "asc"))}
            title="Toggle sort direction"
            className="h-auto shrink-0 rounded-md border border-[var(--app-border)] px-2 py-1 text-[length:var(--text-body-dense)] font-normal text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
          >
            {sortDir === "asc" ? "A→Z" : "Z→A"}
          </Button>
        </div>
      )}

      {/* #2745 feedback: list tabs are height-bounded with their own internal
          scrollbar so hundreds of hooks/skills never grow the page unbounded.
          The Import tab is exempt (its review flow needs natural height). */}
      <div
        className={`pt-3 ${isListTab ? "max-h-[60vh] overflow-y-auto" : ""}`}
        role="tabpanel"
      >
        {isListTab && isLoading && (
          <p className="py-4 text-sm text-[var(--app-hint)]">
            Loading installed configuration…
          </p>
        )}
        {isListTab && isError && !isLoading && (
          <p className="py-4 text-sm text-hot" data-testid="installed-error">
            Failed to read the installed configuration.
          </p>
        )}
        {!isLoading && !isError && data && (
          <>
            {active === "skills" && (
              <NameList
                names={filterSortNames(data.skills, query, sortDir)}
                kind="skills"
                onSelect={name => setSelected({ dimension: "skills", name })}
                selectedName={selectedFor("skills")}
              />
            )}
            {active === "hooks" && (
              <HooksView
                hooks={data.hooks}
                claudeDir={data.claudeDir}
                onSelectFile={name => setSelected({ dimension: "hooks", name })}
                selectedName={selectedFor("hooks")}
                query={query}
                sortDir={sortDir}
              />
            )}
            {active === "agents" && (
              <NameList
                names={filterSortNames(data.agents, query, sortDir)}
                kind="agents"
                onSelect={name => setSelected({ dimension: "agents", name })}
                selectedName={selectedFor("agents")}
              />
            )}
          </>
        )}
        {/* MCP reads its own endpoint — render regardless of porter load state. */}
        {active === "mcp" && (
          <McpView
            onSelect={name => setSelected({ dimension: "mcp", name })}
            selectedName={selectedFor("mcp")}
            query={query}
            sortDir={sortDir}
          />
        )}
        {active === "import" && (
          <div className="flex flex-col gap-6" data-testid="import-tab-panel">
            <PorterExtractionPrompt onReceived={setReceivedSummary} />
            <PorterImportPanel receivedSummary={receivedSummary} />
          </div>
        )}
      </div>
      {/* #3116: preview pane for the selected list item, below the bounded list. */}
      {isListTab && selected && (
        <PreviewPane
          api={api}
          selected={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
