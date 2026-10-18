// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import {
  ACCOUNT_MONO_COLOR_IDS,
  ACCOUNT_MONO_MAX_CHARS,
  type AccountMonogram,
} from "@hapi/protocol";
import { ACCOUNT_NICKNAME_MAX_CHARS } from "@/components/session/accountLabel";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AccountChip,
  MONO_CLASS_BY_ID,
  accountMonogramColor,
} from "@/components/session/AccountChip";
import { useSetAccountMonogram } from "@/hooks/mutations/useSetAccountMonogram";
import { useSetAccountNickname } from "@/hooks/mutations/useSetAccountNickname";
import { useApiKeyActions } from "@/hooks/mutations/useApiKeyActions";

/**
 * V2 centered editor modal for an account's chip identity (issue #3621).
 *
 * Edits — in ONE Save — the account **nickname** (existing PATCH
 * /accounts/:uuid/nickname), the monogram **letters** (auto = follow the
 * nickname's initial, or pinned = one or two fixed characters,
 * `ACCOUNT_MONO_MAX_CHARS`), and the monogram **color** (auto = the per-email
 * hash, or one of the six swatches), with a live `AccountChip` preview fed by
 * the unsaved draft. Cancel/Escape discard. This modal is the ONLY edit path for
 * all three — the Accounts card's Row-2 chip opens it (the inline pencil
 * nickname editor was retired so there is one way to change a nickname).
 *
 * The two PATCHes are NOT atomic. The monogram PATCH is sent FIRST, then the
 * nickname PATCH; if the second fails the first is already persisted and cannot
 * be rolled back — so on a failure the modal stays open, shows which half failed,
 * and leaves the successful half applied (finding 3621-13).
 *
 * Kept under components/AccountUsage/ (NOT components/ui/) — the #3568 catalog
 * guard scans ui/ + layouts/ only, and this is a feature modal, not a primitive.
 *
 * #4463 R9: the same editor names an API KEY. Pass `subject`:
 * - `{ kind: "key", id, seed }` — a stored key; Save sends ONE atomic
 *   `PATCH /api/api-keys/:id` with the name and monogram (no two-PATCH split).
 * - `{ kind: "draft", seed, onSave }` — a key not stored yet (a #4464 modal row
 *   before its Test passes, which under D-1 A has no id to PATCH). Save sends no
 *   request: it hands `{ label, monogram }` to `onSave` and closes; the caller
 *   sends them with the add request.
 * `seed` is the auto-colour hash seed (a stored key's id, or a row-local id for a
 * draft). Without `subject` the editor edits the account named by `uuid`/`email`.
 */

type LetterMode = "auto" | "pinned";
type SaveError = null | "monogram" | "nickname" | "key";

/** A key's name and monogram as the draft subject hands them back. */
export type KeyIdentityDraft = {
  label: string;
  monogram: AccountMonogram;
};

export type KeyEditorSubject =
  | { kind: "key"; id: string; seed: string }
  | {
      kind: "draft";
      seed: string;
      onSave: (draft: KeyIdentityDraft) => void;
    };

type EditorCommonProps = {
  api: ApiClient | null;
  /** The current name — the account's nickname or the key's label. */
  nickname: string | undefined;
  /** The current monogram override (may be undefined). */
  monogram: AccountMonogram | undefined;
  /** Fallback label for the preview (account: display name → email local part;
   *  key: e.g. the provider name). */
  fallback: string;
  open: boolean;
  onClose: () => void;
};

export type AccountMonogramEditorProps = EditorCommonProps &
  (
    | { subject?: undefined; uuid: string; email: string }
    | { subject: KeyEditorSubject; uuid?: undefined; email?: undefined }
  );

export function AccountMonogramEditor(props: AccountMonogramEditorProps) {
  const { api, nickname, monogram, fallback, open, onClose, subject } = props;
  const uuid = props.uuid ?? "";
  // The auto-colour hash seed: the account's email (else its uuid — #3982
  // Task 3), or the key subject's seed.
  const colorSeed = subject ? subject.seed : props.email || uuid;
  const isKey = subject !== undefined;
  // A key name stored before #4463 may be up to 120 characters; the editor
  // trims the draft to the 64 the PATCH accepts so Save can always succeed.
  const initialName = (nickname ?? "").slice(0, ACCOUNT_NICKNAME_MAX_CHARS);

  const [draftNickname, setDraftNickname] = useState(initialName);
  const [letterMode, setLetterMode] = useState<LetterMode>(
    monogram?.letter ? "pinned" : "auto"
  );
  const [draftLetter, setDraftLetter] = useState(monogram?.letter ?? "");
  const [draftColor, setDraftColor] = useState<
    AccountMonogram["color"] | undefined
  >(monogram?.color);
  const [saveError, setSaveError] = useState<SaveError>(null);

  // Reset the draft from the current props each time the modal opens, so a
  // reopen never shows a stale prior edit.
  useEffect(() => {
    if (!open) return;
    setDraftNickname((nickname ?? "").slice(0, ACCOUNT_NICKNAME_MAX_CHARS));
    setLetterMode(monogram?.letter ? "pinned" : "auto");
    setDraftLetter(monogram?.letter ?? "");
    setDraftColor(monogram?.color);
    setSaveError(null);
  }, [open, nickname, monogram]);

  const { setMonogram, isPending: monoPending } = useSetAccountMonogram(api);
  const { setNickname, isPending: nickPending } = useSetAccountNickname(api);
  const { update: updateKey } = useApiKeyActions(api);
  const busy = monoPending || nickPending || updateKey.isPending;

  // The pinned letters, normalized exactly as the store/route will store them
  // (trimmed, at most ACCOUNT_MONO_MAX_CHARS code units, upper-cased) so the
  // preview matches the saved result.
  const pinnedLetter =
    letterMode === "pinned"
      ? draftLetter.trim().slice(0, ACCOUNT_MONO_MAX_CHARS).toUpperCase()
      : "";
  const previewMonogram: AccountMonogram = {
    ...(pinnedLetter ? { letter: pinnedLetter } : {}),
    ...(draftColor ? { color: draftColor } : {}),
  };
  const previewLabel = draftNickname.trim() || fallback;

  const handleSave = async () => {
    setSaveError(null);
    const next: AccountMonogram = {};
    if (pinnedLetter) next.letter = pinnedLetter;
    if (draftColor) next.color = draftColor;
    if (subject?.kind === "draft") {
      subject.onSave({ label: draftNickname.trim(), monogram: next });
      onClose();
      return;
    }
    if (subject?.kind === "key") {
      // One atomic PATCH sets the key's name and monogram (#4463 R6).
      try {
        await updateKey.mutateAsync({
          id: subject.id,
          body: { label: draftNickname.trim(), monogram: next },
        });
      } catch {
        setSaveError("key");
        return;
      }
      onClose();
      return;
    }
    // Monogram PATCH FIRST (non-atomic ordering — finding 3621-13).
    try {
      await setMonogram(uuid, next);
    } catch {
      setSaveError("monogram");
      return; // nickname NOT attempted; nothing persisted
    }
    // Nickname PATCH SECOND. On failure the monogram is already applied.
    try {
      await setNickname(uuid, draftNickname);
    } catch {
      setSaveError("nickname");
      return; // keep modal open; monogram half is applied
    }
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="monogram-editor">
        <DialogHeader>
          <DialogTitle>
            {isKey ? "Edit key name and monogram" : "Edit account chip"}
          </DialogTitle>
          <DialogDescription className="mt-1">
            {isKey
              ? "Set this key’s name and its monogram (one or two letters) and color. These are node-local display settings — the key itself is not changed."
              : "Set this account’s nickname and its chip monogram (one or two letters) and color. These are node-local display settings — the account’s sign-in is not affected."}
          </DialogDescription>
        </DialogHeader>

        {/* Live preview */}
        <div className="flex items-center justify-center py-2">
          <AccountChip
            email={colorSeed}
            label={previewLabel}
            monogram={previewMonogram}
          />
        </div>

        {/* Nickname */}
        <label className="flex flex-col gap-1">
          <span className="text-[length:var(--text-caption)] font-semibold text-[var(--app-hint)]">
            {isKey ? "Name" : "Nickname"}
          </span>
          <input
            autoCapitalize="none"
            value={draftNickname}
            maxLength={ACCOUNT_NICKNAME_MAX_CHARS}
            onChange={e => setDraftNickname(e.target.value)}
            placeholder={fallback}
            aria-label={isKey ? "Key name" : "Account nickname"}
            data-testid="monogram-nickname-input"
            className="w-full rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-[length:var(--text-caption)] text-[var(--app-fg)] outline-none focus:border-[var(--app-accent)]"
          />
        </label>

        {/* Monogram letters — auto (follows the nickname) vs pinned (1–2 chars) */}
        <div className="mt-3 flex flex-col gap-1">
          <span className="text-[length:var(--text-caption)] font-semibold text-[var(--app-hint)]">
            Monogram letters
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={letterMode === "auto" ? "accent" : "outline"}
              onClick={() => setLetterMode("auto")}
              data-testid="monogram-letter-auto"
            >
              Auto
            </Button>
            <Button
              type="button"
              size="sm"
              variant={letterMode === "pinned" ? "accent" : "outline"}
              onClick={() => setLetterMode("pinned")}
              data-testid="monogram-letter-pinned"
            >
              Pinned
            </Button>
            {letterMode === "pinned" ? (
              <>
                <input
                  autoCapitalize="characters"
                  value={draftLetter}
                  maxLength={ACCOUNT_MONO_MAX_CHARS}
                  onChange={e => setDraftLetter(e.target.value)}
                  aria-label="Pinned monogram letters"
                  data-testid="monogram-letter-input"
                  className="h-8 w-12 rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-center text-[length:var(--text-caption)] font-bold uppercase text-[var(--app-fg)] outline-none focus:border-[var(--app-accent)]"
                />
                <span className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
                  one or two characters
                </span>
              </>
            ) : (
              <span className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
                follows the {isKey ? "name" : "nickname"}&rsquo;s initial
              </span>
            )}
          </div>
        </div>

        {/* Monogram color — auto (per-email hash) + the six swatches */}
        <div className="mt-3 flex flex-col gap-1">
          <span className="text-[length:var(--text-caption)] font-semibold text-[var(--app-hint)]">
            Monogram color
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghostStatic"
              size="bare"
              onClick={() => setDraftColor(undefined)}
              aria-label={`Auto color (per-${isKey ? "key" : "account"} default)`}
              aria-pressed={!draftColor}
              data-testid="monogram-swatch-auto"
              title={`Auto (per-${isKey ? "key" : "account"} default)`}
              className={`flex h-6 w-6 items-center justify-center rounded-full ${accountMonogramColor(
                colorSeed
              )} ${
                !draftColor
                  ? "ring-2 ring-[var(--app-link)] ring-offset-1 ring-offset-[var(--app-bg)]"
                  : ""
              }`}
            >
              <span className="text-[length:var(--text-caption-xs)] font-bold text-[var(--app-bg)]">
                A
              </span>
            </Button>
            {ACCOUNT_MONO_COLOR_IDS.map(id => (
              <Button
                key={id}
                type="button"
                variant="ghostStatic"
                size="bare"
                onClick={() => setDraftColor(id)}
                aria-label={`${id} monogram color`}
                aria-pressed={draftColor === id}
                data-testid={`monogram-swatch-${id}`}
                title={id}
                className={`h-6 w-6 rounded-full ${MONO_CLASS_BY_ID[id]} ${
                  draftColor === id
                    ? "ring-2 ring-[var(--app-link)] ring-offset-1 ring-offset-[var(--app-bg)]"
                    : ""
                }`}
              />
            ))}
          </div>
        </div>

        {saveError ? (
          <p
            className="mt-3 text-[length:var(--text-caption)] text-destructive"
            data-testid="monogram-save-error"
          >
            {saveError === "key"
              ? "Could not save the key's name and monogram. Nothing was changed — try again."
              : saveError === "monogram"
                ? "Could not save the monogram. Nothing was changed — try again."
                : "The monogram was saved, but the nickname could not be. Try saving again to retry the nickname."}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={busy}
            data-testid="monogram-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="accent"
            size="sm"
            onClick={() => void handleSave()}
            disabled={busy || (!api && subject?.kind !== "draft")}
            data-testid="monogram-save"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
