// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import {
  Upload,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import {
  CLAUDE_INCLUDES_DIR,
  PORTER_SOURCE_IDS,
  PORTER_SOURCE_LABELS,
} from "@hapi/protocol/porter";
import { useAppContext } from "@/lib/app-context";
import { usePorterImport } from "@/hooks/mutations/usePorterImport";
import type {
  AccountVisibility,
  ImportGroups,
  ImportPlanSummary,
  ImportResult,
  McpFileMergeResult,
  PlannedMcpServer,
  SecretOverlay,
} from "@/types/porter";
import { Button } from "@/components/ui/button";
import {
  ResolveNotices,
  ImportParityReport,
  toggledIn,
  useAckSet,
  useKeepSet,
} from "./ImportHooksReview";
import {
  ExecutableSettingsReview,
  SettingsScriptsHeldList,
} from "./ExecutableSettingsReview";
import { ImportOmissions } from "./ImportOmissions";
import { conflictExcludedBy, resolvableConflicts } from "./importConflicts";
import { hookRowLabels } from "./hookRowLabels";
import {
  ImportDestination,
  SymlinkedSettingsGate,
  useSettingsLinkAck,
} from "./ImportSettingsLink";
import { McpServerDefinition } from "./McpServerDefinition";

/**
 * PorterImportPanel — the upload → review → commit surface of the Admin →
 * Configuration page (issue #2344, R4). Mirrors #2343's two-phase server model
 * as two explicit UI states:
 *
 *   1. Upload  → `POST /api/porter/import/plan` → a reviewable summary. No write.
 *   2. Review  → the user resolves conflicts (skip is the pre-selected default,
 *      matching #2343's non-destructive default) → `POST /api/porter/import/commit`.
 *
 * :red_circle: R4 is a UI obligation, not only the server's: the commit control is
 * DISABLED until the review summary has rendered. A UI that auto-committed after
 * a successful plan would satisfy the endpoint contract while defeating the
 * user-review guarantee. The commit button below is `disabled` whenever no plan
 * summary is present, and its handler refuses structurally as a second guard.
 */

function McpMergeLine({
  result,
  scope,
}: {
  result: McpFileMergeResult;
  scope: string;
}) {
  return (
    <li className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
      <span className="font-medium text-[var(--app-fg)]">{scope}</span>
      {" — "}
      {result.imported.length > 0
        ? `imported ${result.imported.join(", ")}`
        : "nothing imported"}
      {result.skipped.length > 0 && `; skipped ${result.skipped.length}`}
    </li>
  );
}

/**
 * #3246 — one account's post-import visibility row. `orphaned` dims render a
 * warning ("isolation degraded" + the delete-to-re-provision remediation, which
 * is the bridge's own logged advice); `pending` dims render informationally
 * ("will link on next session spawn") and NEVER get a remediation prompt; a
 * fully-visible account confirms.
 */
function VisibilityLine({ account }: { account: AccountVisibility }) {
  const shortId = account.account.slice(0, 8);
  return (
    <li className="text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
      <span className="font-medium">Account {shortId}</span>
      {account.orphaned.length > 0 ? (
        <span className="text-warn">
          {" — "}isolation degraded: {account.orphaned.join(", ")} — sessions
          for this account fall back to the host directory (delete the stale
          isolated dir to re-provision)
        </span>
      ) : account.pending.length > 0 ? (
        <span className="text-[var(--app-hint)]">
          {" — "}
          {account.pending.join(", ")} will link on next session spawn
        </span>
      ) : (
        <span className="text-[var(--app-hint)]">
          {" — "}all imported dimensions visible
        </span>
      )}
    </li>
  );
}

/** Post-commit result view (F1 per-account MCP status; D5 validator output). */
function ResultView({
  result,
  onReset,
}: {
  result: ImportResult;
  onReset: () => void;
}) {
  const { orphanFiles, orphanRegistrations } = result.hookValidation;
  const hasDrift = orphanFiles.length > 0 || orphanRegistrations.length > 0;
  return (
    <section data-testid="import-result" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-ok" />
        <h2 className="text-sm font-semibold text-[var(--app-fg)]">
          Import complete
        </h2>
      </div>

      <ul className="flex flex-col gap-1 text-[length:var(--text-body)] text-[var(--app-fg)]">
        <li>
          {result.filesWritten.length} file
          {result.filesWritten.length === 1 ? "" : "s"} written
        </li>
        {/* #3246 (R3) — resolved destination, consistent with the plan step's
            destination display, so a bare file count is never the whole story. */}
        <li
          className="text-[var(--app-hint)]"
          data-testid="import-result-destination"
        >
          Destination:{" "}
          <span className="break-all font-mono text-[var(--app-fg)]">
            {result.claudeDir}
          </span>
        </li>
        <li>settings.json {result.settingsMerged ? "merged" : "unchanged"}</li>
        {result.skippedConflicts.length > 0 && (
          <li className="text-[var(--app-hint)]">
            {result.skippedConflicts.length} conflict
            {result.skippedConflicts.length === 1 ? "" : "s"} skipped (your
            existing config was kept)
          </li>
        )}
      </ul>

      <ImportParityReport result={result} />

      {/* F1 — per-account MCP write status, not a single host-level truth. */}
      <div>
        <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
          MCP servers
        </h3>
        <ul className="flex flex-col gap-0.5">
          <McpMergeLine result={result.mcp.host} scope="Host" />
          {result.mcp.perAccount.length === 0 ? (
            <li className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
              No account-bound configs updated.
            </li>
          ) : (
            result.mcp.perAccount.map(a => (
              <McpMergeLine
                key={a.configPath}
                result={a}
                scope={`Account: ${a.configPath}`}
              />
            ))
          )}
        </ul>
      </div>

      {/* #2640 / #3546 — MCP servers excluded: an unresolvable command (missing
          runtime / non-portable path, #2640) OR a secret that could not be
          restored (#2638) — named here so a dead-on-arrival server is never
          silently counted as imported. #3546 (R7): the `kind:"secret"` row reads
          "needs re-auth" (was mislabelled "non-portable") and points an
          already-committed user at the re-auth path — re-upload the archive and
          supply the secret in the pre-import step. No secret VALUE is shown. */}
      {result.mcpExclusions.length > 0 && (
        <div>
          <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-hot">
            MCP servers excluded ({result.mcpExclusions.length})
          </h3>
          <ul className="flex flex-col gap-0.5" data-testid="mcp-exclusions">
            {result.mcpExclusions.map(x => (
              <li
                key={x.name}
                className="text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
              >
                <span className="font-medium">{x.name}</span>
                {x.kind === "secret" ? (
                  <span className="text-[var(--app-hint)]">
                    {" "}
                    — needs re-auth — re-upload the archive to supply its
                    secret(s)
                  </span>
                ) : (
                  <span className="text-[var(--app-hint)]">
                    {" "}
                    —{" "}
                    {x.kind === "runtime"
                      ? "missing runtime"
                      : "non-portable"}: {x.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <SettingsScriptsHeldList result={result} />

      {/* D5 — surface the post-commit registration-validator output. */}
      <div
        className={`rounded-md border p-2 ${
          hasDrift
            ? "border-warn bg-warn/10"
            : "border-[var(--app-border)] bg-[var(--app-secondary-bg)]"
        }`}
        data-testid="hook-validation"
      >
        <h3 className="text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-fg)]">
          Hook registration check
        </h3>
        {hasDrift ? (
          <ul className="mt-1 flex flex-col gap-0.5 text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
            {orphanRegistrations.length > 0 && (
              <li className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-hot" />
                {orphanRegistrations.length} registration
                {orphanRegistrations.length === 1 ? "" : "s"} with a missing
                script (will not fire)
              </li>
            )}
            {orphanFiles.length > 0 && (
              <li className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warn" />
                {orphanFiles.length} hook file
                {orphanFiles.length === 1 ? "" : "s"} with no registration
              </li>
            )}
          </ul>
        ) : (
          <p className="mt-1 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
            No orphaned hooks — every registration has a script and every script
            is registered.
          </p>
        )}
      </div>

      {/* #3246 (R2/R3) — per-account visibility of the imported bridge dims via
          the #1562 symlink bridge. `orphaned` ⇒ isolation degraded (warning +
          remediation); `pending` ⇒ informational (normal first-import state).
          Rendered only when isolated per-account config dirs exist. */}
      {result.visibility.length > 0 && (
        <div
          className={`rounded-md border p-2 ${
            result.isolationIntact
              ? "border-[var(--app-border)] bg-[var(--app-secondary-bg)]"
              : "border-warn bg-warn/10"
          }`}
          data-testid="account-visibility"
        >
          <h3 className="text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-fg)]">
            Per-account visibility
          </h3>
          {!result.isolationIntact && (
            <p
              className="mt-1 flex items-start gap-1.5 text-[length:var(--text-body-dense)] text-warn"
              data-testid="isolation-degraded"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warn" />
              Isolation degraded — sessions for the named account(s) fall back
              to the host directory. Imported skills stay reachable there, but
              per-account isolation is lost.
            </p>
          )}
          <ul className="mt-1 flex flex-col gap-0.5">
            {result.visibility.map(a => (
              <VisibilityLine key={`${a.base}:${a.account}`} account={a} />
            ))}
          </ul>
        </div>
      )}

      <Button
        type="button"
        variant="ghost"
        onClick={onReset}
        data-testid="import-reset"
        className="self-end h-auto rounded-md border border-[var(--app-border)] px-3 py-1.5 text-[length:var(--text-body)] font-normal text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
      >
        Import another archive
      </Button>
    </section>
  );
}

/** Compact leaf label = the last path segment of a destPath key (or the key). */
function leafLabel(key: string): string {
  const seg = key.split("/").filter(Boolean).pop();
  return seg && seg.length > 0 ? seg : key;
}

/**
 * #4156: a nested CLAUDE.md include keeps its path from `claude-includes/` on,
 * so `a/RULES.md` and `b/RULES.md` are two distinct rows, not two "RULES.md".
 */
function includeLabel(key: string): string {
  const at = key.lastIndexOf(`/${CLAUDE_INCLUDES_DIR}/`);
  return at >= 0 ? key.slice(at + 1) : leafLabel(key);
}

/**
 * #4373: a memory file's label is its project key and file
 * (`-home-me-projects-app/MEMORY.md`), from `…/projects/<key>/memory/<file>`.
 */
function memoryLabel(key: string): string {
  const m = /\/projects\/([^/]+)\/memory\/(.+)$/.exec(key);
  return m ? `${m[1]}/${m[2]}` : leafLabel(key);
}

/** Tri-state of a skill's parent checkbox, derived from its leaves' exclusion. */
function skillCheckState(
  leaves: readonly string[],
  excluded: ReadonlySet<string>
): { checked: boolean; indeterminate: boolean } {
  if (leaves.length === 0) return { checked: true, indeterminate: false };
  const ex = leaves.filter(k => excluded.has(k)).length;
  return { checked: ex === 0, indeterminate: ex > 0 && ex < leaves.length };
}

/** One selectable leaf row (a file / hook / MCP server). Checked = will import. */
function LeafRow({
  keyId,
  label,
  hint,
  excluded,
  onToggle,
  indent,
}: {
  keyId: string;
  label: string;
  hint?: string;
  excluded: Set<string>;
  onToggle: (k: string) => void;
  indent?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 py-0.5 ${
        indent ? "pl-6" : ""
      }`}
    >
      <input
        type="checkbox"
        checked={!excluded.has(keyId)}
        onChange={() => onToggle(keyId)}
        data-testid={`select-${keyId}`}
        className="h-4 w-4 flex-shrink-0 accent-[var(--app-link)]"
      />
      {hint && (
        <span className="rounded border border-[var(--app-border)] px-1 py-0.5 text-[length:var(--text-caption-xs)] uppercase text-[var(--app-hint)]">
          {hint}
        </span>
      )}
      <span
        className="min-w-0 flex-1 truncate text-[length:var(--text-body)] text-[var(--app-fg)]"
        title={keyId}
      >
        {label}
      </span>
    </label>
  );
}

/** A flat per-item dimension group in the selection tree. */
function DimGroup({
  title,
  keys,
  excluded,
  onToggle,
  labelOf = leafLabel,
}: {
  title: string;
  keys: string[];
  excluded: Set<string>;
  onToggle: (k: string) => void;
  labelOf?: (k: string) => string;
}) {
  if (keys.length === 0) return null;
  return (
    <div>
      <h4 className="pb-0.5 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        {title} ({keys.length})
      </h4>
      {keys.map(k => (
        <LeafRow
          key={k}
          keyId={k}
          label={labelOf(k)}
          excluded={excluded}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

/**
 * #3448 (Sub C, R3): a one-line summary of what a source contributes. claude-code
 * spans its file dimensions plus MCP; Cursor / Claude Desktop are MCP-only. The
 * MCP count comes from the manifest `sources[]` metadata when present (which
 * distinguishes found-but-empty), else falls back to the source's grouped keys.
 */
function sourceSummary(
  id: (typeof PORTER_SOURCE_IDS)[number],
  groups: ImportGroups,
  sources: ImportPlanSummary["sources"]
): string {
  const rec = sources?.find(s => s.id === id);
  const plural = (n: number, w: string): string =>
    `${n} ${w}${n === 1 ? "" : "s"}`;
  if (id === "claude-code") {
    const mcpCount = rec?.counts.mcpServers ?? groups.mcpServers.length; // legacy: all MCP is claude-code
    const hookCount =
      groups.independentHooks.length +
      groups.skills.reduce((n, s) => n + s.servingHooks.length, 0);
    const parts = (
      [
        [groups.skills.length, "skill"],
        [hookCount, "hook"],
        [groups.commands.length, "command"],
        [groups.agents.length, "agent"],
        [groups.rules.length, "rule"],
        [(groups.memory ?? []).length, "memory file"],
        [mcpCount, "MCP server"],
      ] as [number, string][]
    )
      .filter(([n]) => n > 0)
      .map(([n, w]) => plural(n, w));
    return parts.length > 0 ? parts.join(" · ") : "no importable items";
  }
  const mcpCount = rec?.counts.mcpServers ?? groups.bySource[id].keys.length;
  return plural(mcpCount, "MCP server");
}

/**
 * #3448 (Sub C, R3): the per-source review cards, above {@link SelectionTree}.
 * One card per {@link PORTER_SOURCE_IDS}: a found source is checked while ANY of
 * its keys are selected and its checkbox cascades over that source's keys (via
 * {@link onToggleSource}, the same all-or-nothing toggle skills use); a not-found
 * source is disabled with a "Not found" caption. The cascade drives the ONE
 * existing `excluded` set — no parallel selection state (D3(a)).
 */
function SourceCards({
  groups,
  sources,
  excluded,
  onToggleSource,
}: {
  groups: ImportGroups;
  sources: ImportPlanSummary["sources"];
  excluded: Set<string>;
  onToggleSource: (keys: string[]) => void;
}) {
  return (
    <section data-testid="source-cards" className="flex flex-col gap-2">
      <h3 className="text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        Choose what to bring over
      </h3>
      {PORTER_SOURCE_IDS.map(id => {
        const { found, keys } = groups.bySource[id];
        const st = skillCheckState(keys, excluded);
        return (
          <label
            key={id}
            data-testid={`source-card-${id}`}
            className={`flex items-start gap-3 rounded-lg border p-3 ${
              found
                ? "cursor-pointer border-[var(--app-border)]"
                : "cursor-not-allowed border-[var(--app-border)] opacity-60"
            } ${
              found && st.checked
                ? "border-l-2 border-l-[var(--app-success)]"
                : ""
            }`}
          >
            <input
              type="checkbox"
              checked={found && st.checked}
              disabled={!found}
              ref={el => {
                if (el) el.indeterminate = found && st.indeterminate;
              }}
              onChange={() => onToggleSource(keys)}
              data-testid={`source-toggle-${id}`}
              className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[var(--app-link)]"
            />
            <div className="min-w-0 flex-1">
              <div className="text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
                {PORTER_SOURCE_LABELS[id]}
              </div>
              <div className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                {found ? sourceSummary(id, groups, sources) : "Not found"}
              </div>
            </div>
          </label>
        );
      })}
    </section>
  );
}

/**
 * #3247 — Step 1: the hierarchical checkbox tree over ALL plan dimensions,
 * all-checked by default. Deselecting a skill cascades (via {@link onToggleSkill})
 * to uncheck+exclude its files AND serving hooks. Rendered from the server-shipped
 * `groups` — the SAME structure the commit cascades from, so the client cascade
 * and the server exclusion cannot drift (the monorepo boundary forbids sharing
 * the helper itself).
 */
function SelectionTree({
  groups,
  claudeDir,
  excluded,
  onToggleLeaf,
  onToggleSkill,
}: {
  groups: ImportGroups;
  claudeDir: string;
  excluded: Set<string>;
  onToggleLeaf: (k: string) => void;
  onToggleSkill: (leaves: string[]) => void;
}) {
  // #4331: two same-named hooks in different folders get distinct labels.
  const hookLabels = hookRowLabels(
    [
      ...groups.skills.flatMap(s => s.servingHooks),
      ...groups.independentHooks.map(h => h.id),
    ],
    claudeDir
  );
  const isEmpty =
    groups.skills.length === 0 &&
    groups.independentHooks.length === 0 &&
    groups.mcpServers.length === 0 &&
    groups.agents.length === 0 &&
    groups.commands.length === 0 &&
    groups.rules.length === 0 &&
    groups.outputStyles.length === 0 &&
    groups.claudeMd.length === 0 &&
    (groups.memory ?? []).length === 0;

  return (
    <section data-testid="selection-tree">
      <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        Step 1 of 2 — Select what to import
      </h3>
      <p className="pb-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        Everything is selected by default. Uncheck anything you do not want
        written. Unchecking a skill also removes its files and the hooks that
        serve it.
      </p>
      {isEmpty ? (
        <p className="text-[length:var(--text-body)] text-[var(--app-hint)]">
          No selectable items in this archive.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.skills.length > 0 && (
            <div>
              <h4 className="pb-0.5 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                Skills ({groups.skills.length})
              </h4>
              {groups.skills.map(s => {
                const leaves = [...s.files, ...s.servingHooks];
                const st = skillCheckState(leaves, excluded);
                return (
                  <div key={s.skill}>
                    <label className="flex cursor-pointer items-center gap-2 py-0.5">
                      <input
                        type="checkbox"
                        checked={st.checked}
                        ref={el => {
                          if (el) el.indeterminate = st.indeterminate;
                        }}
                        onChange={() => onToggleSkill(leaves)}
                        data-testid={`select-skill-${s.skill}`}
                        className="h-4 w-4 flex-shrink-0 accent-[var(--app-link)]"
                      />
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
                        {s.skill}
                      </span>
                    </label>
                    {s.files.map(f => (
                      <LeafRow
                        key={f}
                        keyId={f}
                        label={leafLabel(f)}
                        excluded={excluded}
                        onToggle={onToggleLeaf}
                        indent
                      />
                    ))}
                    {s.servingHooks.map(h => (
                      <LeafRow
                        key={h}
                        keyId={h}
                        label={hookLabels.get(h) ?? leafLabel(h)}
                        hint="hook"
                        excluded={excluded}
                        onToggle={onToggleLeaf}
                        indent
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
          {groups.independentHooks.length > 0 && (
            <div>
              <h4 className="pb-0.5 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                Hooks ({groups.independentHooks.length})
              </h4>
              {groups.independentHooks.map(h => (
                <LeafRow
                  key={h.id}
                  keyId={h.id}
                  label={hookLabels.get(h.id) ?? leafLabel(h.id)}
                  hint="hook"
                  excluded={excluded}
                  onToggle={onToggleLeaf}
                />
              ))}
            </div>
          )}
          <DimGroup
            title="MCP servers"
            keys={groups.mcpServers}
            excluded={excluded}
            onToggle={onToggleLeaf}
          />
          <DimGroup
            title="Agents"
            keys={groups.agents}
            excluded={excluded}
            onToggle={onToggleLeaf}
          />
          <DimGroup
            title="Commands"
            keys={groups.commands}
            excluded={excluded}
            onToggle={onToggleLeaf}
          />
          <DimGroup
            title="Rules"
            keys={groups.rules}
            excluded={excluded}
            onToggle={onToggleLeaf}
          />
          <DimGroup
            title="Output styles"
            keys={groups.outputStyles}
            excluded={excluded}
            onToggle={onToggleLeaf}
          />
          <DimGroup
            title="CLAUDE.md"
            keys={groups.claudeMd}
            excluded={excluded}
            onToggle={onToggleLeaf}
            labelOf={includeLabel}
          />
          <DimGroup
            title="Memory"
            keys={groups.memory ?? []}
            excluded={excluded}
            onToggle={onToggleLeaf}
            labelOf={memoryLabel}
          />
        </div>
      )}
    </section>
  );
}

/**
 * #3546 (ADR-0006 Fork A): the declared re-auth slots for a server as
 * `{ synthetic slotKey, human label }`. `slotKey` is the SYNTHETIC bundle key the
 * overlay is keyed by (`__args_<i>__`, `__url__`, an env key, a header key); the
 * label is display-only. The classifier over-detects (every env key / header is a
 * slot, e.g. `NODE_ENV`), which is why the wording is "values to supply".
 */
export function reAuthSlots(
  s: PlannedMcpServer
): { slotKey: string; label: string }[] {
  const out: { slotKey: string; label: string }[] = [];
  for (const a of s.argsNames ?? [])
    out.push({ slotKey: a.name, label: `args[${a.index}]` });
  if (s.urlName !== undefined) out.push({ slotKey: s.urlName, label: "url" });
  for (const e of s.envNames ?? []) out.push({ slotKey: e, label: `env.${e}` });
  for (const h of s.headerNames ?? [])
    out.push({ slotKey: h, label: `headers.${h}` });
  return out;
}

/**
 * #3546: build the commit-body overlay from the collected inputs. Includes a
 * server ONLY when it is `secretRestorable: false`, NOT deselected, and EVERY
 * declared slot has a non-blank value — so a partial fill is simply not re-authed
 * (stays excluded, exactly as today) rather than triggering the server's up-front
 * 400. Returns undefined when nothing is complete, so the commit body is
 * byte-identical to a no-re-auth import.
 */
export function buildCommitOverlay(
  servers: PlannedMcpServer[],
  overlay: SecretOverlay,
  excluded: Set<string>
): SecretOverlay | undefined {
  const out: SecretOverlay = {};
  for (const s of servers) {
    if (s.secretRestorable || excluded.has(s.name)) continue;
    const slots = reAuthSlots(s);
    if (slots.length === 0) continue;
    const entered = overlay[s.name] ?? {};
    const complete = slots.every(
      sl => (entered[sl.slotKey] ?? "").trim().length > 0
    );
    if (!complete) continue;
    out[s.name] = Object.fromEntries(
      slots.map(sl => [sl.slotKey, entered[sl.slotKey]])
    );
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * #3546 (R2/R4): the pre-commit re-authentication step (ADR-0006 Fork A). Renders
 * one password input per declared secret slot for every `secretRestorable: false`
 * server that is still selected, keyed by the human label. Values feed the
 * `secretOverlay` carried ONCE in the commit body; they are never echoed to logs
 * and never placed in a URL. A deselected server's card disappears (its overlay
 * is dropped, matching the server's deselect-wins rule).
 */
function ReAuthStep({
  servers,
  overlay,
  onChange,
}: {
  servers: PlannedMcpServer[];
  overlay: SecretOverlay;
  onChange: (server: string, slotKey: string, value: string) => void;
}) {
  if (servers.length === 0) return null;
  return (
    <section data-testid="reauth-step">
      <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        Re-authenticate MCP servers ({servers.length})
      </h3>
      <p className="pb-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        These servers were imported without their secrets. Enter the values to
        supply so they connect on this machine. Values are sent once with the
        import and are never stored or logged. Leave a server blank to skip it.
      </p>
      <div className="flex flex-col gap-3">
        {servers.map(s => {
          const slots = reAuthSlots(s);
          const entered = overlay[s.name] ?? {};
          const complete = slots.every(
            sl => (entered[sl.slotKey] ?? "").trim().length > 0
          );
          return (
            <div
              key={s.name}
              data-testid={`reauth-server-${s.name}`}
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2"
            >
              <div className="flex items-center justify-between pb-1">
                <span className="text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
                  {s.name}
                </span>
                <span
                  className={`text-[length:var(--text-caption)] ${
                    complete ? "text-ok" : "text-[var(--app-hint)]"
                  }`}
                  data-testid={`reauth-status-${s.name}`}
                >
                  {complete
                    ? "ready to re-auth"
                    : "supply all values to re-auth"}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {slots.map(sl => (
                  <label key={sl.slotKey} className="flex flex-col gap-0.5">
                    <span className="font-mono text-[length:var(--text-caption)] text-[var(--app-hint)]">
                      {sl.label}
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={entered[sl.slotKey] ?? ""}
                      onChange={e =>
                        onChange(s.name, sl.slotKey, e.target.value)
                      }
                      placeholder="value to supply"
                      data-testid={`reauth-input-${s.name}-${sl.slotKey}`}
                      className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
                    />
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function PorterImportPanel({
  receivedSummary,
}: { receivedSummary?: ImportPlanSummary } = {}) {
  const { api } = useAppContext();
  const { plan, commit } = usePorterImport(api);
  // #4277 (R1): reset() detaches a running commit, so its onSuccess never shows
  // the result. clearReview reads this ref, not `commit.isPending`, because a
  // plan's onSuccess runs with the click-time render's (stale) `commit`.
  const commitRunning = useRef(false);
  commitRunning.current = commit.isPending;
  const [file, setFile] = useState<File | null>(null);
  // #3446 (Sub A, 1B#4): the ONE-LINER hydration seam. Seed from the received
  // plan when present so the review UI renders without a manual file upload; a
  // later async arrival is adopted by the effect below. C (#3448) rebases its
  // per-source cards on this same `receivedSummary` seam instead of adding its own.
  const [summary, setSummary] = useState<ImportPlanSummary | null>(
    receivedSummary ?? null
  );
  const [result, setResult] = useState<ImportResult | null>(null);
  const [overwrite, setOverwrite] = useState<Set<string>>(() => new Set());
  // #3247: keys the operator DESELECTED in Step 1 (file/hook destPaths, MCP names).
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  // #3590 (K4/D9): registry-missing hook acknowledgement (extracted hook).
  const ack = useAckSet();
  // #4129: File-modes rows whose current mode the operator keeps (keepModes).
  const keep = useKeepSet();
  // #4277: the symlinked settings.json 409, acknowledged per plan (#4146 D14).
  const linkAck = useSettingsLinkAck();
  // #3546 (ADR-0006 Fork A): recipient re-auth values, keyed by server name then
  // SYNTHETIC slot name. Memory-only; cleared on reset + re-plan; never persisted.
  const [secretOverlay, setSecretOverlay] = useState<SecretOverlay>({});
  // #3247: two-step confirmation — Step 1 (select) → Step 2 (resolve conflicts).
  const [phase, setPhase] = useState<"select" | "resolve">("select");
  // #2745 feedback: the section is collapsible from its own heading.
  const [importOpen, setImportOpen] = useState(true);
  // #3299: same-machine isolation — redirect the import under <isolatedDest>/.claude
  // instead of the live ~/.claude. The path must be an absolute throwaway dir.
  const [isolatedEnabled, setIsolatedEnabled] = useState(false);
  const [isolatedDest, setIsolatedDest] = useState("");

  // #4177 (L5): the review state every plan adoption starts from — shared by
  // reset(), handlePlan() (and its onSuccess) and the received-plan effect so
  // they cannot drift.
  const clearReview = () => {
    setOverwrite(new Set());
    setExcluded(new Set());
    ack.reset();
    keep.reset();
    // #4277: a new plan drops the last plan's refusal and its error line, but
    // leaves a running commit attached so its result still shows (R1).
    linkAck.reset();
    if (!commitRunning.current) commit.reset();
    setSecretOverlay({});
    setPhase("select");
  };

  // #3446: adopt a received plan that arrives AFTER mount (the async one-liner
  // upload flow) so the panel switches into review without a manual upload.
  // #4177 (L5): a DIFFERENT plan (new staging handle) starts a fresh review; a
  // re-delivery of the displayed plan keeps the operator's choices.
  useEffect(() => {
    if (!receivedSummary) return;
    if (receivedSummary.stagingHandle !== summary?.stagingHandle) clearReview();
    setSummary(receivedSummary);
    // Keyed on the received plan alone. Do NOT add clearReview/ack/keep/linkAck:
    // those hooks return new objects every render, so they would re-fire this
    // effect in a loop. `summary` is read from this render's closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receivedSummary]);

  const reset = () => {
    setFile(null);
    setSummary(null);
    setResult(null);
    clearReview();
    // #3299 (D6): intentionally KEEP isolatedEnabled/isolatedDest — a protective
    // isolation mode must survive "Import another" and never silently revert to
    // the live ~/.claude on the second archive.
    plan.reset();
    commit.reset();
  };

  const handlePlan = () => {
    if (!file) return;
    setSummary(null);
    clearReview();
    // #4177 (L5): clear again on success — a one-liner plan received while this
    // one was pending may have been reviewed, and this new plan replaces it.
    plan.mutate(
      { file, isolatedDest: isolatedEnabled ? isolatedDest.trim() : undefined },
      {
        onSuccess: s => {
          clearReview();
          setSummary(s);
        },
      }
    );
  };

  const toggleOverwrite = (key: string) => setOverwrite(toggledIn(key));

  // #3247: Step-1 selection. A leaf toggle flips one key; a skill toggle cascades
  // to all its files + serving hooks (uncheck-all when any selected, else check-all).
  const toggleExcludedLeaf = (key: string) => setExcluded(toggledIn(key));

  const toggleSkill = (leaves: string[]) => {
    setExcluded(prev => {
      const next = new Set(prev);
      const anySelected = leaves.some(k => !next.has(k));
      for (const k of leaves) {
        if (anySelected) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  };

  // #3546: record one re-auth slot value. An empty value clears the slot (and the
  // server entry once it empties), so the in-memory overlay never carries a blank.
  const onOverlayChange = (server: string, slotKey: string, value: string) => {
    setSecretOverlay(prev => {
      const next = { ...prev };
      const forServer = { ...(next[server] ?? {}) };
      if (value === "") delete forServer[slotKey];
      else forServer[slotKey] = value;
      if (Object.keys(forServer).length === 0) delete next[server];
      else next[server] = forServer;
      return next;
    });
  };

  const handleCommit = () => {
    // R4 structural guard: refuse to commit with no rendered summary, even if a
    // future refactor drops the `disabled` attribute below.
    if (!summary) return;
    const isExcluded = conflictExcludedBy(summary, excluded);
    commit.mutate(
      {
        stagingHandle: summary.stagingHandle,
        // #3247: an excluded item cannot also be overwrite-resolved — drop its key.
        overwrite: [...overwrite].filter(k => !isExcluded(k)),
        excluded: [...excluded],
        // #3590 (K4/D9): the acknowledged registry-missing hook names.
        acknowledgeMissingHooks: [...ack.acked],
        // #4129: the File-modes rows whose current mode the operator keeps.
        keepModes: [...keep.kept],
        // #3546: send only COMPLETE, non-deselected server overlays — a partial
        // fill stays excluded rather than 400ing the whole commit.
        secretOverlay: buildCommitOverlay(
          summary.mcpServers,
          secretOverlay,
          excluded
        ),
        // #4277: the target THIS plan's 409 echoed, once the operator ticked it.
        acknowledgeSymlinkedSettings: linkAck.ackFor(summary.stagingHandle),
      },
      {
        onSuccess: r => setResult(r),
        onError: e => linkAck.capture(e, summary.stagingHandle),
      }
    );
  };

  if (result) {
    return <ResultView result={result} onReset={reset} />;
  }

  // #3247: Step 2 is selection-aware — conflicts belonging to Step-1-excluded
  // items are hidden (an excluded item is never overwrite-resolved).
  const conflicts = summary ? resolvableConflicts(summary, excluded) : [];
  const linkRefusal = linkAck.liveFor(summary?.stagingHandle);

  return (
    <section data-testid="import-panel" className="flex flex-col gap-3">
      <div>
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          aria-expanded={importOpen}
          onClick={() => setImportOpen(o => !o)}
          data-testid="import-panel-toggle"
          className="flex w-full items-center justify-start gap-1.5 text-left font-normal hover:text-[var(--app-fg)]"
        >
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-[var(--app-hint)] transition-transform ${
              importOpen ? "" : "-rotate-90"
            }`}
          />
          <h2 className="text-sm font-semibold text-[var(--app-fg)]">
            Import a configuration archive
          </h2>
        </Button>
        {importOpen && (
          <p className="mt-0.5 text-[length:var(--text-body)] text-[var(--app-hint)]">
            Upload the encrypted <span className="font-mono">.tar.gz</span> the
            extraction prompt produced. You will see exactly what would change
            before anything is written.
          </p>
        )}
      </div>

      {!importOpen ? null : (
        <>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <input
              type="file"
              accept=".tar.gz,.tgz,application/gzip"
              data-testid="import-file"
              onChange={e => {
                setFile(e.target.files?.[0] ?? null);
                setSummary(null);
              }}
              className="text-[length:var(--text-body)] text-[var(--app-fg)] file:mr-3 file:rounded-md file:border file:border-[var(--app-border)] file:bg-[var(--app-secondary-bg)] file:px-3 file:py-1.5 file:text-[var(--app-fg)]"
            />
            <Button
              type="button"
              variant="ghost"
              onClick={handlePlan}
              disabled={
                !file ||
                plan.isPending ||
                (isolatedEnabled && !isolatedDest.trim())
              }
              data-testid="plan-import"
              className="flex h-auto items-center gap-1.5 rounded-md bg-[var(--app-link)] px-3 py-1.5 text-[length:var(--text-body)] font-medium text-[var(--app-bg)] transition-opacity hover:bg-[var(--app-link)] hover:text-[var(--app-bg)] disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              {plan.isPending ? "Reviewing…" : "Review import"}
            </Button>
          </div>

          {/* #3299: same-machine isolation. A protective mode — redirect the
          import under <dest>/.claude instead of the live ~/.claude. Any change to
          the toggle or path drops a stale summary so a plan resolved for a
          different destination can never be committed (R10). */}
          <div className="flex flex-col gap-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-[length:var(--text-body)] text-[var(--app-fg)]">
              <input
                type="checkbox"
                checked={isolatedEnabled}
                onChange={e => {
                  setIsolatedEnabled(e.target.checked);
                  setSummary(null);
                }}
                data-testid="import-isolated-toggle"
                className="h-4 w-4 flex-shrink-0 accent-[var(--app-link)]"
              />
              Isolated destination (advanced)
            </label>
            {isolatedEnabled && (
              <>
                <input
                  type="text"
                  value={isolatedDest}
                  onChange={e => {
                    setIsolatedDest(e.target.value);
                    setSummary(null);
                  }}
                  placeholder="/abs/path/to/throwaway-dir"
                  data-testid="import-isolated-path"
                  className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2 py-1 font-mono text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
                />
                <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                  Absolute path required; the destination paths below will
                  resolve under{" "}
                  <span className="font-mono">&lt;dest&gt;/.claude</span> and
                  the live <span className="font-mono">~/.claude</span> is not
                  touched. <span className="font-mono">/tmp</span>,{" "}
                  <span className="font-mono">~/.config</span>, and the porter
                  staging/backup subtrees are rejected. Per-account MCP
                  propagation is skipped, and gated plugin install stays
                  host-scoped.
                </p>
              </>
            )}
          </div>

          {plan.isError && (
            <p
              className="text-[length:var(--text-body)] text-hot"
              data-testid="plan-error"
            >
              {plan.error?.message ?? "Failed to plan the import."}
            </p>
          )}

          {summary && (
            <div
              className="flex flex-col gap-4 rounded-md border border-[var(--app-border)] p-3"
              data-testid="plan-summary"
            >
              <ImportDestination summary={summary} isolated={isolatedEnabled} />

              {/* #3247 Step 1 — hierarchical selection tree (all-checked default),
                  replacing the flat item list. Deselecting a skill cascades to its
                  files + serving hooks. Shown in the "select" phase; the operator
                  advances to the conflict gate via the "Continue" button below. */}
              {phase === "select" && (
                <div className="flex flex-col gap-4">
                  {/* #3448 (Sub C) — per-source review cards above the detailed
                      tree; a card is a whole-source toggle over the same excluded
                      set the tree edits. */}
                  <SourceCards
                    groups={summary.groups}
                    sources={summary.sources}
                    excluded={excluded}
                    onToggleSource={toggleSkill}
                  />
                  <SelectionTree
                    groups={summary.groups}
                    claudeDir={summary.claudeDir}
                    excluded={excluded}
                    onToggleLeaf={toggleExcludedLeaf}
                    onToggleSkill={toggleSkill}
                  />
                  {/* #3546 (ADR-0006 Fork A): pre-commit re-auth for servers whose
                      secrets could not be carried — one input per declared slot,
                      only for still-selected servers. */}
                  <ReAuthStep
                    servers={summary.mcpServers.filter(
                      s => !s.secretRestorable && !excluded.has(s.name)
                    )}
                    overlay={secretOverlay}
                    onChange={onOverlayChange}
                  />
                </div>
              )}

              {/* #3247 Step 2 — per-conflict overwrite/keep, selection-aware:
                  conflicts of Step-1-excluded items are already filtered out of
                  `conflicts`. Skip stays the pre-selected default (unchecked =
                  keep yours). Shown only in the "resolve" phase. */}
              {phase === "resolve" && (
                <section data-testid="conflicts">
                  <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                    Step 2 of 2 — Resolve conflicts
                    {conflicts.length > 0 ? ` (${conflicts.length})` : ""}
                  </h3>
                  {conflicts.length === 0 ? (
                    <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                      No conflicts among the selected items — nothing existing
                      will be overwritten.
                    </p>
                  ) : (
                    <>
                      <p className="pb-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                        These already exist with different content. Leave
                        unchecked to keep your current version (the default);
                        check to overwrite it.
                      </p>
                      <ul className="flex flex-col gap-1" role="list">
                        {conflicts.map(c => (
                          <li key={`${c.category}:${c.key}`}>
                            <label className="flex cursor-pointer items-start gap-2">
                              <input
                                type="checkbox"
                                checked={overwrite.has(c.key)}
                                onChange={() => toggleOverwrite(c.key)}
                                data-testid={`overwrite-${c.key}`}
                                className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[var(--app-link)]"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="text-[length:var(--text-caption)] uppercase text-[var(--app-hint)]">
                                  {c.category}
                                </span>
                                <span className="block break-all font-mono text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
                                  {c.label}
                                </span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}

              {/* Settings — F6 (keys written) + F7 (keys not ported) */}
              {(summary.settings.keys.length > 0 ||
                summary.settings.skippedKeys.length > 0) && (
                <section data-testid="settings-summary">
                  <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                    settings.json
                  </h3>
                  {summary.settings.keys.length > 0 && (
                    <p className="text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
                      <span className="font-medium">Will write:</span>{" "}
                      <span className="font-mono text-[var(--app-hint)]">
                        {summary.settings.keys.join(", ")}
                      </span>
                    </p>
                  )}
                  {summary.settings.skippedKeys.length > 0 && (
                    <p
                      className="mt-1 text-[length:var(--text-body-dense)] text-warn"
                      data-testid="skipped-keys"
                    >
                      {summary.settings.skippedKeys.length} key
                      {summary.settings.skippedKeys.length === 1 ? "" : "s"} not
                      ported:{" "}
                      <span className="font-mono">
                        {summary.settings.skippedKeys.join(", ")}
                      </span>
                    </p>
                  )}
                  {/*
                #2600: env + permissions VALUES surfaced for review. Rendered as
                inert monospace text (never interpolated into HTML / executed) —
                the value IS the control (a NODE_OPTIONS / ANTHROPIC_BASE_URL
                override or a defaultMode escalation is legible before commit).
              */}
                  {summary.settings.envValues.length > 0 && (
                    <div className="mt-1" data-testid="env-values">
                      <p className="text-[length:var(--text-body-dense)] font-medium text-[var(--app-fg)]">
                        env:
                      </p>
                      <ul className="flex flex-col gap-0.5 text-[length:var(--text-body-dense)] text-warn">
                        {summary.settings.envValues.map(e => (
                          <li key={e.key}>
                            <span className="font-mono">{e.key}</span>
                            {" = "}
                            <span className="font-mono break-all">
                              {e.value}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {summary.settings.permissionsValues.length > 0 && (
                    <div className="mt-1" data-testid="permissions-values">
                      <p className="text-[length:var(--text-body-dense)] font-medium text-[var(--app-fg)]">
                        permissions:
                      </p>
                      <ul className="flex flex-col gap-0.5 text-[length:var(--text-body-dense)] text-warn">
                        {summary.settings.permissionsValues.map(p => (
                          <li key={p.key}>
                            <span className="font-mono">{p.key}</span>
                            {" = "}
                            <span className="font-mono break-all whitespace-pre-wrap">
                              {typeof p.value === "string"
                                ? p.value
                                : JSON.stringify(p.value, null, 2)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {/* #2565 (F5) + #4173: the executable values and the files they run. */}
                  <ExecutableSettingsReview
                    settings={summary.settings}
                    claudeDir={summary.claudeDir}
                    overwrite={overwrite}
                    excluded={excluded}
                    groups={summary.groups}
                  />
                </section>
              )}

              {/* Hooks */}
              {summary.hooks.count > 0 && (
                <section>
                  <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                    Hooks ({summary.hooks.count})
                  </h3>
                  {summary.hooks.unknownEvents.length > 0 && (
                    <p className="text-[length:var(--text-body-dense)] text-warn">
                      Unknown events: {summary.hooks.unknownEvents.join(", ")}
                    </p>
                  )}
                  {summary.hooks.commandWarnings.length > 0 && (
                    <ul className="flex flex-col gap-0.5 text-[length:var(--text-body-dense)] text-warn">
                      {summary.hooks.commandWarnings.map(w => (
                        <li key={w}>⚠️ {w}</li>
                      ))}
                    </ul>
                  )}
                  {/*
                #2600: each hook command string surfaced VERBATIM for review — an
                unshown command is the threat (a `curl … | sh` pipeline the
                path-lint cannot catch), so this is warning-styled. Index keys:
                two hooks can legitimately share a command string, so a
                content-keyed list would collide.
              */}
                  {summary.hooks.commands.length > 0 && (
                    <ul
                      className="mt-1 flex flex-col gap-1 text-[length:var(--text-body-dense)] text-warn"
                      data-testid="hook-commands"
                    >
                      {summary.hooks.commands.map((h, i) => (
                        <li key={i}>
                          <span className="text-[var(--app-hint)]">
                            {h.events.join(", ")}
                            {h.matcher ? ` · ${h.matcher}` : ""}:
                          </span>{" "}
                          <span className="font-mono break-all">
                            {h.command}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {/* MCP servers */}
              {summary.mcpServers.length > 0 && (
                <section>
                  <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                    MCP servers ({summary.mcpServers.length})
                  </h3>
                  <ul className="flex flex-col" role="list">
                    {summary.mcpServers.map(s => (
                      <li
                        key={s.name}
                        className="flex flex-col gap-0.5 py-1 text-[length:var(--text-body)] text-[var(--app-fg)]"
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">
                            {s.name}
                          </span>
                          {s.hasSecrets && (
                            <span className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
                              has secrets
                            </span>
                          )}
                          {s.conflict?.kind === "differs" && (
                            <span className="text-[length:var(--text-caption)] text-warn">
                              conflict
                            </span>
                          )}
                          {/* #2640: a server whose command is unresolvable on this
                          destination is flagged loudly and will be EXCLUDED from
                          the import (not silently written dead-on-arrival). */}
                          {!s.resolvable && (
                            <span className="text-[length:var(--text-caption)] font-semibold text-hot">
                              {s.nonPortable ? "non-portable" : "unresolvable"}
                            </span>
                          )}
                          {s.commandTranslation && (
                            <span className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
                              path translated
                            </span>
                          )}
                        </div>
                        {!s.resolvable && s.unresolvedReason && (
                          <span className="text-[length:var(--text-caption)] text-hot">
                            {s.unresolvedReason}
                          </span>
                        )}
                        {s.commandTranslation && (
                          <span className="font-mono break-all text-[length:var(--text-caption)] text-[var(--app-hint)]">
                            {s.commandTranslation.from} →{" "}
                            {s.commandTranslation.to}
                          </span>
                        )}
                        <McpServerDefinition server={s} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* #4156: policy refusals, then the other omissions. */}
              <ImportOmissions
                omissions={summary.omissions}
                policySkips={summary.policySkips ?? []}
              />
            </div>
          )}

          {/* #4277: the symlinked-settings 409 shows as its gate, not raw JSON. */}
          {commit.isError && !linkRefusal && (
            <p
              className="text-[length:var(--text-body)] text-hot"
              data-testid="commit-error"
            >
              {commit.error?.message ?? "Failed to commit the import."}
            </p>
          )}

          {/* #3247: two-gate action row — the commit button exists ONLY in Step 2.
              #3590: the registry-missing gate sits above it, gating the commit. */}
          {summary && phase === "resolve" && (
            <ResolveNotices
              summary={summary}
              ack={ack}
              keep={keep}
              excluded={excluded}
              overwrite={overwrite}
            />
          )}
          {/* #4277: the commit's symlinked settings.json 409, beside (not inside)
              ResolveNotices, which holds the plan-time notices. */}
          {linkRefusal && phase === "resolve" && (
            <SymlinkedSettingsGate
              link={linkRefusal}
              acknowledged={linkAck.acked}
              onToggle={linkAck.toggle}
            />
          )}
          {summary && phase === "select" && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPhase("resolve")}
              data-testid="selection-continue"
              className="flex h-auto items-center gap-1.5 self-end rounded-md bg-[var(--app-link)] px-4 py-2 text-[length:var(--text-label-strong)] font-medium text-[var(--app-bg)] transition-opacity hover:bg-[var(--app-link)] hover:text-[var(--app-bg)]"
            >
              Continue to conflicts
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
          {summary && phase === "resolve" && (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPhase("select")}
                data-testid="selection-back"
                className="flex h-auto items-center gap-1.5 rounded-md border border-[var(--app-border)] px-3 py-2 text-[length:var(--text-body)] font-normal text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={handleCommit}
                disabled={
                  !summary ||
                  commit.isPending ||
                  !summary.hooks.registryMissing.every(n => ack.acked.has(n)) ||
                  (linkRefusal !== null && !linkAck.acked)
                }
                data-testid="commit-import"
                className="h-auto rounded-md bg-[var(--app-link)] px-4 py-2 text-[length:var(--text-label-strong)] font-medium text-[var(--app-bg)] transition-opacity hover:bg-[var(--app-link)] hover:text-[var(--app-bg)] disabled:opacity-50"
              >
                {commit.isPending ? "Importing…" : "Import"}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
