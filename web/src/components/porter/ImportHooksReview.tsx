// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { settingsScriptGateHolds } from "@hapi/protocol/porter";
import type {
  ExecutableScriptReview,
  ImportGroups,
  ImportPlanSummary,
  ImportResult,
  ModeReconcilePreview,
  ModeSkip,
  PlannedItemKind,
} from "@/types/porter";
import { HiddenCharsNotice, VisibleText } from "./VisibleText";

/**
 * #3590 — the whole-tree hooks review surfaces, split out of PorterImportPanel.tsx
 * to keep that file under the 1,500-line max-lines cap (#2077) while it accretes
 * the parity report + registry-drift acknowledgement. All colours come from design
 * tokens (never hardcoded), matching the panel's existing usage.
 */

/**
 * #3590 (K4/D9): the registry-missing-hook acknowledgement set, extracted as a
 * hook so the panel stays under its line cap. `reset()` clears it on a new plan
 * or "Import another".
 */
export function useAckSet(): {
  acked: Set<string>;
  toggle: (name: string) => void;
  reset: () => void;
} {
  const [acked, setAcked] = useState<Set<string>>(() => new Set());
  const toggle = (name: string) => setAcked(toggledIn(name));
  return { acked, toggle, reset: () => setAcked(new Set()) };
}

/** A `setState` updater that adds `key` to a Set, or removes it if present. */
export const toggledIn =
  (key: string) =>
  (prev: ReadonlySet<string>): Set<string> => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

/**
 * #4129: the File-modes rows (destPaths) whose current mode the operator KEEPS.
 * Sent as `keepModes`; the commit leaves those files' modes unchanged.
 */
export function useKeepSet(): {
  kept: Set<string>;
  toggle: (destPath: string) => void;
  reset: () => void;
} {
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  const toggle = (destPath: string) => setKept(toggledIn(destPath));
  return { kept, toggle, reset: () => setKept(new Set()) };
}

/**
 * #4129: whether the Step-1 selection excludes a File-modes row — the SAME rule
 * the commit applies (`server/src/porter/commitSelection.ts`): a `hook-lib`
 * file follows the hooks as a group (excluded only when every hook is), any
 * other file its own destPath. #4173: a `settings-script` follows the setting
 * that runs it — excluded iff `held` names it, whatever `excluded` holds.
 */
export function isModeRowExcluded(
  row: { destPath: string; kind: PlannedItemKind },
  excluded: ReadonlySet<string>,
  groups: ImportGroups,
  held: ReadonlySet<string> = new Set()
): boolean {
  if (row.kind === "settings-script") return held.has(row.destPath);
  if (row.kind !== "hook-lib") return excluded.has(row.destPath);
  const hookKeys = [
    ...groups.independentHooks.map(h => h.id),
    ...groups.skills.flatMap(s => s.servingHooks),
  ];
  return hookKeys.length > 0 && hookKeys.every(k => excluded.has(k));
}

/**
 * D4: a carried `settings-script` is held — not written — when every setting
 * that runs it is a kept conflict. The rule is the commit's own
 * (`settingsScriptGateHolds`, shared with `heldSettingsScripts` in
 * `server/src/porter/planSettingsScripts.ts`).
 */
export function isSettingsScriptHeld(
  row: Pick<ExecutableScriptReview, "kind" | "gatedBy">,
  overwrite: ReadonlySet<string>
): boolean {
  return (
    row.kind === "settings-script" &&
    settingsScriptGateHolds(row.gatedBy, overwrite)
  );
}

/** The destPaths of the scripts the commit would hold back (the commit's rule). */
export function heldScriptPaths(
  rows: readonly ExecutableScriptReview[],
  overwrite: ReadonlySet<string>
): Set<string> {
  const held = new Set<string>();
  for (const row of rows) {
    if (row.destPath && isSettingsScriptHeld(row, overwrite))
      held.add(row.destPath);
  }
  return held;
}

/**
 * #3590 (K4/D9): the plan-time registry-drift gate. Lists each registry-referenced
 * hook the archive AND destination both lack, each with its own acknowledgement
 * checkbox; the panel keeps the commit blocked until every name is acknowledged
 * (or every hook is deselected, the server's other escape hatch). Renders nothing
 * when the archive carries no such drift — the common, clean case.
 */
export function RegistryMissingGate({
  missing,
  acknowledged,
  onToggle,
}: {
  missing: string[];
  acknowledged: ReadonlySet<string>;
  onToggle: (name: string) => void;
}) {
  if (missing.length === 0) return null;
  return (
    <section
      data-testid="registry-missing-gate"
      className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2"
    >
      <h3 className="flex items-center gap-1.5 pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-hot">
        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
        {missing.length} registry hook{missing.length === 1 ? "" : "s"} missing
      </h3>
      <p className="pb-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        The archive&apos;s hook registry references these hooks, but no matching
        file is in the archive or already installed. Acknowledge each to import
        anyway, or deselect the hooks in the previous step.
      </p>
      <ul className="flex flex-col gap-1">
        {missing.map(name => (
          <li key={name}>
            <label className="flex cursor-pointer items-center gap-2 text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
              <input
                type="checkbox"
                checked={acknowledged.has(name)}
                onChange={() => onToggle(name)}
                data-testid={`ack-missing-${name}`}
              />
              <span className="font-mono text-[length:var(--text-caption)]">
                {name}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * #4129: the Step-2 plan-time notices above the commit action — the #3590
 * registry-missing gate and the exec-bit reconcile preview — behind ONE mount
 * point, so PorterImportPanel.tsx stays under its 1,500-line cap.
 */
export function ResolveNotices({
  summary,
  ack,
  keep,
  excluded,
  overwrite = new Set(),
}: {
  summary: ImportPlanSummary;
  ack: ReturnType<typeof useAckSet>;
  keep: ReturnType<typeof useKeepSet>;
  excluded: ReadonlySet<string>;
  /** #4173: the conflicts chosen for overwrite (a held script's mode row is hidden). */
  overwrite?: ReadonlySet<string>;
}) {
  return (
    <>
      <RegistryMissingGate
        missing={summary.hooks.registryMissing}
        acknowledged={ack.acked}
        onToggle={ack.toggle}
      />
      <ModeReconcileNotice
        preview={summary.modeReconcile}
        claudeDir={summary.claudeDir}
        excluded={excluded}
        groups={summary.groups}
        held={heldScriptPaths(summary.settings.executableScripts, overwrite)}
        keep={keep}
      />
    </>
  );
}

/** `0o755` → `0755`. */
const octal = (m: number): string => `0${m.toString(8).padStart(3, "0")}`;

/** A destPath relative to the config root when it lives under it. */
const relTo = (claudeDir: string, p: string): string =>
  p.startsWith(`${claudeDir}/`) ? p.slice(claudeDir.length + 1) : p;

/** `x.sh (symlink), y.sh (changed)` — a skip list by basename + reason. */
const skipList = (skipped: readonly ModeSkip[]): string =>
  skipped
    .map(s => `${s.destPath.split("/").pop() ?? s.destPath} (${s.reason})`)
    .join(", ");

/**
 * #4129: the byte-identical files this commit may give the archive's execute
 * bit (content unchanged) — the commit applies no other mode change. Each row
 * carries its own "Keep" checkbox, so an operator who disabled a hook by
 * removing its execute bit keeps it, whatever the file's kind. Rows the Step-1
 * selection excludes are dropped by the commit's own rule
 * ({@link isModeRowExcluded}). Renders nothing when there is nothing to show.
 */
function ModeReconcileNotice({
  preview,
  claudeDir,
  excluded,
  groups,
  held,
  keep,
}: {
  preview: ModeReconcilePreview;
  claudeDir: string;
  excluded: ReadonlySet<string>;
  groups: ImportGroups;
  held: ReadonlySet<string>;
  keep: ReturnType<typeof useKeepSet>;
}) {
  const fixes = preview.fixes.filter(
    f => !isModeRowExcluded(f, excluded, groups, held)
  );
  const skipped = preview.skipped.filter(
    s => !isModeRowExcluded(s, excluded, groups, held)
  );
  if (fixes.length === 0 && skipped.length === 0) return null;
  const pending = fixes.filter(f => !keep.kept.has(f.destPath)).length;
  return (
    <section
      data-testid="mode-reconcile-preview"
      className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2"
    >
      <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        File modes
      </h3>
      {fixes.length > 0 && (
        <>
          <p
            className="pb-1 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
            data-testid="mode-reconcile-summary"
          >
            {pending > 0 ? (
              <>
                {pending} existing file{pending === 1 ? "" : "s"} already match
                {pending === 1 ? "es" : ""} the archive and will gain its
                execute bit (content unchanged).
              </>
            ) : (
              <>No file mode will change.</>
            )}{" "}
            Tick Keep on a row to leave that file&apos;s mode as it is.
          </p>
          <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
            {fixes.map(f => {
              const rel = relTo(claudeDir, f.destPath);
              const kept = keep.kept.has(f.destPath);
              return (
                <li
                  key={f.destPath}
                  className="flex flex-wrap items-center gap-x-2 text-[length:var(--text-caption)] text-[var(--app-fg)]"
                >
                  <label className="flex cursor-pointer items-center gap-1 text-[var(--app-hint)]">
                    <input
                      type="checkbox"
                      checked={kept}
                      onChange={() => keep.toggle(f.destPath)}
                      data-testid={`mode-keep-${f.destPath}`}
                      aria-label={`Keep the current mode of ${rel}`}
                    />
                    Keep
                  </label>
                  <span className="break-all font-mono">{rel}</span>
                  <span className="font-mono text-[var(--app-hint)]">
                    {kept
                      ? `${octal(f.from)} (kept)`
                      : `${octal(f.from)} → ${octal(f.to)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {skipped.length > 0 && (
        <p
          className="flex items-start gap-1.5 pt-1 text-[length:var(--text-body-dense)] text-warn"
          data-testid="mode-reconcile-preview-skipped"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            {skipped.length} file mode{skipped.length === 1 ? "" : "s"} will be
            left unchanged:{" "}
            <span className="font-mono">{skipList(skipped)}</span>
          </span>
        </p>
      )}
    </section>
  );
}

/** One per-dimension parity row (expected → written, with the non-tautological gaps). */
function ParityRow({
  dim,
  p,
}: {
  dim: string;
  p: ImportResult["parity"][string];
}) {
  const detail: string[] = [];
  if (p.alreadyPresent > 0) detail.push(`${p.alreadyPresent} already present`);
  if (p.skippedConflicts > 0)
    detail.push(`${p.skippedConflicts} skipped (conflict)`);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
      <span className="font-medium text-[var(--app-fg)]">{dim}</span>
      <span>
        {p.written}/{p.expected} written
      </span>
      {detail.length > 0 && <span>· {detail.join(" · ")}</span>}
      {p.missing.length > 0 && (
        <span className="text-hot">· {p.missing.length} missing</span>
      )}
    </li>
  );
}

/**
 * #3590 (K6/D7): the post-commit parity report — per-dimension expected-vs-written,
 * plus the three fail-loud signals never surfaced before this issue (registry
 * modules still missing at the destination, unresolved `from lib.X` imports, and
 * hooks excluded from the imported count). A clean import renders the table with
 * no missing/excluded rows.
 */
export function ImportParityReport({ result }: { result: ImportResult }) {
  const dims = Object.entries(result.parity).filter(
    ([, p]) => p.expected > 0 || p.missing.length > 0
  );
  const registryMissing = result.hookValidation.registryMissing;
  const unresolved = result.hookValidation.unresolvedImports;
  const excluded = result.hooks.excluded;
  return (
    <section
      data-testid="import-parity"
      className="flex flex-col gap-2 rounded-md border border-[var(--app-border)] p-2"
    >
      <h3 className="text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        Import parity
      </h3>
      {dims.length === 0 ? (
        <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          Nothing was imported.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {dims.map(([dim, p]) => (
            <ParityRow key={dim} dim={dim} p={p} />
          ))}
        </ul>
      )}
      {registryMissing.length > 0 && (
        <p
          className="flex items-start gap-1.5 text-[length:var(--text-body-dense)] text-hot"
          data-testid="parity-registry-missing"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            Registry references {registryMissing.length} hook
            {registryMissing.length === 1 ? "" : "s"} still missing:{" "}
            <span className="font-mono">{registryMissing.join(", ")}</span>
          </span>
        </p>
      )}
      {unresolved.length > 0 && (
        <p className="flex items-start gap-1.5 text-[length:var(--text-body-dense)] text-warn">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            {unresolved.length} hook import
            {unresolved.length === 1 ? "" : "s"} unresolved:{" "}
            <span className="font-mono">
              {unresolved.map(u => `${u.module}`).join(", ")}
            </span>
          </span>
        </p>
      )}
      {excluded.length > 0 && (
        <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          {excluded.length} hook{excluded.length === 1 ? "" : "s"} excluded from
          the imported count.
        </p>
      )}
      {result.modesCorrected.length > 0 && (
        <p
          className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
          data-testid="parity-modes-corrected"
        >
          {result.modesCorrected.length} existing file
          {result.modesCorrected.length === 1 ? "" : "s"} had the archive&apos;s
          execute bit restored.
        </p>
      )}
      {result.modesSkipped.length > 0 && (
        <p
          className="flex items-start gap-1.5 text-[length:var(--text-body-dense)] text-warn"
          data-testid="parity-modes-skipped"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            {result.modesSkipped.length} file mode
            {result.modesSkipped.length === 1 ? "" : "s"} left unchanged:{" "}
            <span className="font-mono">{skipList(result.modesSkipped)}</span>
          </span>
        </p>
      )}
    </section>
  );
}

/**
 * The hook commands an import writes, moved out of PorterImportPanel.tsx
 * (#5195) so it can be tested on its own: the unknown events, the command
 * warnings, and each hook's events, matcher, and command.
 *
 * #2600: each hook command string is surfaced VERBATIM for review. An unshown
 * command is the threat (a `curl … | sh` pipeline the path-lint cannot catch),
 * so this is warning-styled. Index keys: two hooks can legitimately share a
 * command string, so a content-keyed list would collide.
 *
 * #5195: every value renders through `VisibleText`, so a hidden or
 * direction-changing code point shows in place as a `U+XXXX` token, and the
 * list carries one notice when any command, matcher, or event contains one.
 */
export function HookCommandsReview({
  hooks,
}: {
  hooks: Pick<
    ImportPlanSummary["hooks"],
    "unknownEvents" | "commandWarnings" | "commands"
  >;
}) {
  return (
    <>
      {hooks.unknownEvents.length > 0 && (
        <p className="text-[length:var(--text-body-dense)] text-warn">
          Unknown events: <VisibleText text={hooks.unknownEvents.join(", ")} />
        </p>
      )}
      {hooks.commandWarnings.length > 0 && (
        <ul
          data-testid="hook-command-warnings"
          className="flex flex-col gap-0.5 text-[length:var(--text-body-dense)] text-warn"
        >
          {hooks.commandWarnings.map(w => (
            <li key={w}>
              ⚠️ <VisibleText text={w} />
            </li>
          ))}
        </ul>
      )}
      {hooks.commands.length > 0 && (
        <>
          <HiddenCharsNotice
            testId="hook-commands-hidden-chars"
            values={hooks.commands.flatMap(h => [
              h.command,
              h.matcher ?? "",
              ...h.events,
            ])}
          />
          <ul
            className="mt-1 flex flex-col gap-1 text-[length:var(--text-body-dense)] text-warn"
            data-testid="hook-commands"
          >
            {hooks.commands.map((h, i) => (
              <li key={i}>
                <span className="text-[var(--app-hint)]">
                  <VisibleText text={h.events.join(", ")} />
                  {h.matcher ? (
                    <>
                      {" · "}
                      <VisibleText text={h.matcher} />
                    </>
                  ) : null}
                  :
                </span>{" "}
                <span className="font-mono break-all whitespace-pre-wrap">
                  <VisibleText text={h.command} />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
