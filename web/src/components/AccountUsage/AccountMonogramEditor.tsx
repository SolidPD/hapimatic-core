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
 */

type LetterMode = "auto" | "pinned";
type SaveError = null | "monogram" | "nickname";

export function AccountMonogramEditor(props: {
  api: ApiClient | null;
  uuid: string;
  email: string;
  /** The account's current nickname (may be empty/undefined). */
  nickname: string | undefined;
  /** The account's current monogram override (may be undefined). */
  monogram: AccountMonogram | undefined;
  /** Fallback label (OAuth display name → email local part) for the preview. */
  fallback: string;
  open: boolean;
  onClose: () => void;
}) {
  const { api, uuid, email, nickname, monogram, fallback, open, onClose } =
    props;

  const [draftNickname, setDraftNickname] = useState(nickname ?? "");
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
    setDraftNickname(nickname ?? "");
    setLetterMode(monogram?.letter ? "pinned" : "auto");
    setDraftLetter(monogram?.letter ?? "");
    setDraftColor(monogram?.color);
    setSaveError(null);
  }, [open, nickname, monogram]);

  const { setMonogram, isPending: monoPending } = useSetAccountMonogram(api);
  const { setNickname, isPending: nickPending } = useSetAccountNickname(api);
  const busy = monoPending || nickPending;

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
          <DialogTitle>Edit account chip</DialogTitle>
          <DialogDescription className="mt-1">
            Set this account&rsquo;s nickname and its chip monogram (one or two
            letters) and color. These are node-local display settings — your
            Claude login is not affected.
          </DialogDescription>
        </DialogHeader>

        {/* Live preview */}
        <div className="flex items-center justify-center py-2">
          <AccountChip
            email={email}
            label={previewLabel}
            monogram={previewMonogram}
          />
        </div>

        {/* Nickname */}
        <label className="flex flex-col gap-1">
          <span className="text-[length:var(--text-caption)] font-semibold text-[var(--app-hint)]">
            Nickname
          </span>
          <input
            autoCapitalize="none"
            value={draftNickname}
            maxLength={ACCOUNT_NICKNAME_MAX_CHARS}
            onChange={e => setDraftNickname(e.target.value)}
            placeholder={fallback}
            aria-label="Account nickname"
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
                follows the nickname&rsquo;s initial
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
              aria-label="Auto color (per-account default)"
              aria-pressed={!draftColor}
              data-testid="monogram-swatch-auto"
              title="Auto (per-account default)"
              className={`flex h-6 w-6 items-center justify-center rounded-full ${accountMonogramColor(
                email
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
            {saveError === "monogram"
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
            disabled={busy || !api}
            data-testid="monogram-save"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
