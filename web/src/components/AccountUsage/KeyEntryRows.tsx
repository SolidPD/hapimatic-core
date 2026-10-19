// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useMemo, useRef, useState } from "react";
import type { AccountMonogram, ProviderId } from "@hapi/protocol";
import {
  API_KEY_NAME_MAX_CHARS,
  type RedactedApiKey,
} from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { CheckIcon, ChevronIcon } from "@/components/icons";
import { AccountMonogramEditor } from "@/components/AccountUsage/AccountMonogramEditor";
import {
  MONO_CLASS_BY_ID,
  accountMonogramColor,
} from "@/components/session/AccountChip";
import { accountMonogram } from "@/components/session/accountLabel";
import { useApiKeys } from "@/hooks/queries/useApiKeys";
import { useApiKeyActions } from "@/hooks/mutations/useApiKeyActions";
import { apiKeyDisplayName } from "@/lib/apiKeyStatus";
import {
  describeAddKeyError,
  describeValidKey,
  parseKeyLines,
  rowNeedsAdd,
  vaultProviderFor,
  type KeyRow,
} from "./addModalDone";

const INPUT_CLASS =
  "w-full min-w-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]";

export const PROVIDER_NAME: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Gemini",
};

let rowSeq = 0;
function newRow(key = ""): KeyRow {
  rowSeq += 1;
  return {
    rowId: `row-${Date.now().toString(36)}-${rowSeq}`,
    name: "",
    key,
    status: { kind: "draft" },
  };
}

/** Keep exactly one trailing blank draft row once any row holds a key or has
 *  been stored (R5). A stored row's key is cleared, so "blank" means an empty
 *  DRAFT, not merely an empty key field. */
function withTrailingBlank(rows: KeyRow[]): KeyRow[] {
  if (rows.length === 0) return [newRow()];
  const last = rows[rows.length - 1];
  const lastIsBlank = last.key.trim() === "" && last.status.kind === "draft";
  return lastIsBlank ? rows : [...rows, newRow()];
}

export type KeyRowsApi = ReturnType<typeof useKeyRows>;

/**
 * The API-key rows' state (R5–R7), owned by the "+ Add" modal so Done can see
 * every untested row. Test and Done both call #4463's validate-then-store add in
 * append mode; a row becomes `passed` only on success, because under D-1 A a key
 * that does not validate is never stored.
 */
export function useKeyRows(
  api: ApiClient | null,
  provider: ProviderId,
  uiNodeLabel: string
) {
  const [rows, setRows] = useState<KeyRow[]>(() => [newRow()]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const { add } = useApiKeyActions(api);
  // Each row's running validate-then-store, so Done can wait for a Test that is
  // still in flight instead of closing over it.
  const inflightRef = useRef(new Map<string, Promise<boolean>>());

  const update = useCallback((rowId: string, patch: Partial<KeyRow>) => {
    setRows(prev =>
      withTrailingBlank(
        prev.map(r => {
          if (r.rowId !== rowId) return r;
          const next = { ...r, ...patch };
          // Editing the key of a failed row clears its old error.
          if (patch.key !== undefined && r.status.kind === "failed") {
            next.status = { kind: "draft" };
          }
          return next;
        })
      )
    );
  }, []);

  /** One validate-then-store run for a row (Test or Done). */
  const runAdd = useCallback(
    async (row: KeyRow): Promise<boolean> => {
      const rowId = row.rowId;
      const setStatus = (status: KeyRow["status"], clearKey = false) =>
        setRows(prev =>
          withTrailingBlank(
            prev.map(r =>
              r.rowId === rowId
                ? { ...r, status, ...(clearKey ? { key: "" } : {}) }
                : r
            )
          )
        );
      setStatus({ kind: "testing" });
      try {
        const name = row.name.trim();
        const stored = await add.mutateAsync({
          provider: vaultProviderFor(provider),
          key: row.key.trim(),
          mode: "append",
          validate: true,
          ...(name ? { label: name } : {}),
          ...(row.monogram && Object.keys(row.monogram).length > 0
            ? { monogram: row.monogram }
            : {}),
        });
        // The key is stored: drop the raw secret from state — the row shows the
        // masked key from here on.
        setStatus(
          {
            kind: "passed",
            id: stored.id,
            maskedKey: stored.maskedKey,
            modelCount: stored.lastValidation?.modelCount,
            modelCountCapped: stored.lastValidation?.modelCountCapped,
          },
          true
        );
        return true;
      } catch (err) {
        setStatus({
          kind: "failed",
          message: describeAddKeyError(err, uiNodeLabel),
        });
        return false;
      }
    },
    [add, provider, uiNodeLabel]
  );

  /** Validate, then store one row. Resolves true when the row passed. A row
   *  already being tested resolves with that run's result, so Done can wait
   *  for a Test still in flight. */
  const addRow = useCallback(
    (rowId: string): Promise<boolean> => {
      const running = inflightRef.current.get(rowId);
      if (running) return running;
      const row = rowsRef.current.find(r => r.rowId === rowId);
      if (!row || !rowNeedsAdd(row)) {
        return Promise.resolve(row?.status.kind === "passed");
      }
      const run = runAdd(row).finally(() => {
        inflightRef.current.delete(rowId);
      });
      inflightRef.current.set(rowId, run);
      return run;
    },
    [runAdd]
  );

  /** Done's half (R7): add every untested row in parallel and wait for any Test
   *  still in flight; count the rows that did not pass. */
  const addUntested = useCallback(async (): Promise<number> => {
    const ids = rowsRef.current
      .filter(r => rowNeedsAdd(r) || r.status.kind === "testing")
      .map(r => r.rowId);
    const results = await Promise.all(ids.map(id => addRow(id)));
    return results.filter(ok => !ok).length;
  }, [addRow]);

  /** Paste several keys: each new key becomes a row; keys already in a row are
   *  skipped (a stored key's row no longer holds it, so a re-pasted stored key
   *  is refused by the server as a duplicate). */
  const addFromPaste = useCallback((text: string) => {
    const keys = parseKeyLines(text);
    setRows(prev => {
      const known = new Set(prev.map(r => r.key.trim()).filter(Boolean));
      const kept = prev.filter(
        r => !(r.key.trim() === "" && r.status.kind === "draft")
      );
      const added = keys.filter(k => !known.has(k)).map(k => newRow(k));
      return withTrailingBlank([...kept, ...added]);
    });
  }, []);

  const savedCount = rows.filter(r => r.status.kind === "passed").length;
  const pendingCount = rows.filter(rowNeedsAdd).length;
  const testingCount = rows.filter(r => r.status.kind === "testing").length;
  return {
    rows,
    update,
    addRow,
    addUntested,
    addFromPaste,
    savedCount,
    pendingCount,
    testingCount,
  };
}

function KeyMonogramPill(props: {
  seed: string;
  label: string;
  monogram?: AccountMonogram;
}) {
  const color = props.monogram?.color
    ? MONO_CLASS_BY_ID[props.monogram.color]
    : accountMonogramColor(props.seed);
  const letter = (props.monogram?.letter ?? accountMonogram(props.label)).slice(
    0,
    2
  );
  return (
    <span
      aria-hidden="true"
      className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[length:var(--text-caption)] font-bold leading-none text-[var(--app-bg)] ${color}`}
    >
      {letter}
    </span>
  );
}

/**
 * KeyEntryRows — the "API keys" section of the "+ Add" modal (issue #4464 R5,
 * R6). Renamed from the directive's `ApiKeyRows` because
 * `AccountSelectorModal.tsx` has a file-local `ApiKeyRows` (the #4568 picker of
 * STORED keys); this one ENTERS new keys.
 *
 * The section always writes the UI host node's vault, whatever node the login
 * radio selects: there is no federation key store until #1996.
 */
export function KeyEntryRows(props: {
  api: ApiClient | null;
  provider: ProviderId;
  uiNodeLabel: string;
  keyRows: KeyRowsApi;
}) {
  const { api, provider, uiNodeLabel, keyRows } = props;
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const { data: storedKeys = [] } = useApiKeys(api);
  const vaultProvider = vaultProviderFor(provider);
  const storedById = useMemo(() => {
    const m = new Map<string, RedactedApiKey>();
    for (const k of storedKeys) m.set(k.id, k);
    return m;
  }, [storedKeys]);
  // #4463 D-2 A: the first stored key of the provider (list order) is the one
  // OpenCode sessions use, and the key section says so.
  const openCodeKey =
    provider === "google"
      ? undefined
      : storedKeys.find(k => k.provider === vaultProvider);
  const providerName = PROVIDER_NAME[provider];

  const editingRow = keyRows.rows.find(r => r.rowId === editing);
  const editingStored =
    editingRow?.status.kind === "passed"
      ? storedById.get(editingRow.status.id)
      : undefined;

  return (
    <section className="flex flex-col gap-2" data-testid="add-modal-keys">
      <h3 className="text-[length:var(--text-label-strong)] font-semibold text-[var(--app-fg)]">
        API keys
      </h3>
      {openCodeKey && (
        <p
          className="text-[length:var(--text-caption)] text-[var(--app-hint)]"
          data-testid="opencode-key-line"
        >
          New OpenCode sessions use {apiKeyDisplayName(openCodeKey)}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {keyRows.rows.map(row => {
          const passed = row.status.kind === "passed" ? row.status : null;
          const stored = passed ? storedById.get(passed.id) : undefined;
          const name = stored?.label ?? row.name;
          const monogram = stored?.monogram ?? row.monogram;
          const testing = row.status.kind === "testing";
          return (
            <li
              key={row.rowId}
              className="flex flex-col gap-1"
              data-testid="key-row"
              data-status={row.status.kind}
            >
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghostStatic"
                  size="bare"
                  aria-label="Edit name and monogram"
                  disabled={testing}
                  onClick={() => setEditing(row.rowId)}
                  className="shrink-0"
                  data-testid="key-row-monogram"
                >
                  <KeyMonogramPill
                    seed={passed ? passed.id : row.rowId}
                    label={name.trim() || providerName}
                    monogram={monogram}
                  />
                </Button>
                <input
                  type="text"
                  aria-label="Key name"
                  placeholder="Name"
                  maxLength={API_KEY_NAME_MAX_CHARS}
                  value={name}
                  readOnly={Boolean(passed) || testing}
                  onChange={e =>
                    keyRows.update(row.rowId, { name: e.target.value })
                  }
                  className={`${INPUT_CLASS} basis-1/3`}
                  style={{ fontSize: "16px" }}
                />
                {passed ? (
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
                    data-testid="key-row-masked"
                  >
                    {passed.maskedKey}
                  </span>
                ) : (
                  <input
                    type="password"
                    aria-label={`${providerName} API key`}
                    placeholder="Paste a key"
                    autoComplete="off"
                    spellCheck={false}
                    value={row.key}
                    disabled={testing}
                    onChange={e =>
                      keyRows.update(row.rowId, { key: e.target.value })
                    }
                    className={`${INPUT_CLASS} flex-1`}
                    style={{ fontSize: "16px" }}
                  />
                )}
                {passed ? (
                  <span
                    className="flex h-8 w-14 shrink-0 items-center justify-center text-[var(--status-ok)]"
                    aria-label="Saved"
                    data-testid="key-row-check"
                  >
                    <CheckIcon className="h-4 w-4" />
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-14 shrink-0"
                    disabled={testing || row.key.trim() === ""}
                    onClick={() => void keyRows.addRow(row.rowId)}
                    data-testid="key-row-test"
                  >
                    {testing ? "…" : "Test"}
                  </Button>
                )}
              </div>
              {passed && (
                <p
                  className="pl-8 text-[length:var(--text-caption)] text-[var(--status-ok)]"
                  data-testid="key-row-result"
                >
                  {describeValidKey({
                    lastValidation: {
                      modelCount: passed.modelCount,
                      modelCountCapped: passed.modelCountCapped,
                    },
                  })}
                </p>
              )}
              {row.status.kind === "failed" && (
                <p
                  className="pl-8 text-[length:var(--text-caption)] text-[var(--accent-rose-400)]"
                  data-testid="key-row-error"
                >
                  {row.status.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          aria-expanded={pasteOpen}
          onClick={() => setPasteOpen(o => !o)}
          className="flex items-center justify-start gap-1.5 self-start font-normal text-[var(--app-link)]"
        >
          <ChevronIcon className="h-3 w-3" collapsed={!pasteOpen} />
          Paste several keys at once
        </Button>
        {pasteOpen && (
          <div className="flex flex-col gap-1.5">
            <textarea
              aria-label="Keys, one per line"
              placeholder="One key per line"
              rows={4}
              autoComplete="off"
              spellCheck={false}
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              className={`${INPUT_CLASS} font-mono`}
              style={{ fontSize: "16px" }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-end"
              disabled={pasteText.trim() === ""}
              onClick={() => {
                keyRows.addFromPaste(pasteText);
                setPasteText("");
                setPasteOpen(false);
              }}
            >
              Add rows
            </Button>
          </div>
        )}
      </div>
      <p className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
        Stored on {uiNodeLabel} only, until key sync lands (#1996)
      </p>
      {editingRow && (
        <AccountMonogramEditor
          api={api}
          open
          onClose={() => setEditing(null)}
          nickname={editingStored?.label ?? (editingRow.name || undefined)}
          monogram={editingStored?.monogram ?? editingRow.monogram}
          fallback={providerName}
          subject={
            editingRow.status.kind === "passed"
              ? {
                  kind: "key",
                  id: editingRow.status.id,
                  seed: editingRow.status.id,
                }
              : {
                  kind: "draft",
                  seed: editingRow.rowId,
                  onSave: ({ label, monogram }) =>
                    keyRows.update(editingRow.rowId, { name: label, monogram }),
                }
          }
        />
      )}
    </section>
  );
}
