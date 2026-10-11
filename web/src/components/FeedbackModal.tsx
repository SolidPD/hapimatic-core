// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES,
} from "@hapi/protocol/schemas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import type { ApiClient } from "@/api/client";
import type { FeedbackCategory, FeedbackMetadata } from "@/types/api";
import { composeFeedbackMetadata } from "@/lib/feedbackMetadata";
import { useSubmitFeedback } from "@/hooks/mutations/useSubmitFeedback";
import {
  planAttachmentAdditions,
  readFileAsBase64,
  toFeedbackAttachments,
  type PendingFeedbackAttachment,
} from "@/lib/feedbackAttachments";
import { useFeedbackDraftAssist } from "@/hooks/useFeedbackDraftAssist";

const ATTACHMENT_TOTAL_CAP_MB =
  FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024;

interface FeedbackModalProps {
  open: boolean;
  onClose: () => void;
  api: ApiClient;
  /** Current route/pathname — always recorded in the metadata. */
  route: string;
  /** Present when the modal is opened inside a session view (adds the session block). */
  sessionId?: string | null;
  appVersion?: string;
  loginUsername?: string | null;
}

const CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature request" },
  { value: "other", label: "Other" },
];

/**
 * Feedback modal (issue #2664, epic #2663). Composes the privacy-safe metadata
 * on open, shows the user EXACTLY what will be sent (read-only preview), takes a
 * description + category, and submits to `POST /api/feedback` with success /
 * failure toast. `useToast` is safe outside a ToastProvider (no-op), but this
 * modal is only ever mounted inside the authenticated tree (BrandedFrame gates
 * it on `useOptionalAppContext().api`), so the toast is live.
 */
export function FeedbackModal({
  open,
  onClose,
  api,
  route,
  sessionId,
  appVersion,
  loginUsername,
}: FeedbackModalProps) {
  const { showToast } = useToast();
  const submit = useSubmitFeedback(api);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [metadata, setMetadata] = useState<FeedbackMetadata | null>(null);
  const [submitterEmail, setSubmitterEmail] = useState<string | null>(
    loginUsername ?? null
  );
  const [composing, setComposing] = useState(false);
  const [attachments, setAttachments] = useState<PendingFeedbackAttachment[]>(
    []
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Monotonic local id source. NOT crypto.randomUUID() — that requires a secure
  // context, but the primary deployment is plain-HTTP over the Tailscale IP.
  const attachmentIdRef = useRef(0);

  // Issue #2668 (epic #2663): optional in-session "help me describe this" AI
  // assist. Strictly additive — `available` is false (the button is hidden)
  // unless the flag is on AND the modal was opened inside an ACTIVE session.
  // The assist NEVER auto-submits (R2) and the plain-description path is
  // unaffected when it is disabled or errors (R3).
  const assist = useFeedbackDraftAssist({ api, sessionId, enabled: open });
  // Destructure the primitive draft + stable reset so the effects below depend
  // on exactly those (not the fresh `assist` object identity each render).
  const { draft: assistDraft, reset: resetAssist } = assist;

  // Populate the description with the scrubbed draft when it arrives. Keyed on
  // the draft value so it applies once per draft and never clobbers manual edits.
  useEffect(() => {
    if (assistDraft != null) setDescription(assistDraft);
  }, [assistDraft]);

  // Compose the privacy-safe metadata preview whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setComposing(true);
    setMetadata(null);
    composeFeedbackMetadata({
      api,
      route,
      sessionId,
      appVersion,
      loginUsername,
    })
      .then(res => {
        if (cancelled) return;
        setMetadata(res.metadata);
        setSubmitterEmail(res.submitterEmail);
      })
      .catch(() => {
        if (!cancelled) setMetadata({ route } as FeedbackMetadata);
      })
      .finally(() => {
        if (!cancelled) setComposing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, api, route, sessionId, appVersion, loginUsername]);

  // Reset the form when the modal closes.
  useEffect(() => {
    if (!open) {
      setDescription("");
      setCategory("bug");
      setAttachments([]);
      resetAssist();
    }
  }, [open, resetAssist]);

  const trimmed = description.trim();
  const canSubmit =
    trimmed.length > 0 && metadata !== null && !submit.isPending;

  const handleSubmit = useCallback(() => {
    if (!trimmed || !metadata) return;
    submit.mutate(
      {
        description: trimmed,
        category,
        metadata,
        submitterEmail,
        route,
        appVersion,
        attachments:
          attachments.length > 0
            ? toFeedbackAttachments(attachments)
            : undefined,
      },
      {
        onSuccess: () => {
          showToast("Feedback sent — thank you!", { type: "success" });
          onClose();
        },
        onError: () => {
          showToast("Couldn't send feedback. Please try again.", {
            type: "error",
          });
        },
      }
    );
  }, [
    trimmed,
    metadata,
    category,
    submitterEmail,
    route,
    appVersion,
    attachments,
    submit,
    showToast,
    onClose,
  ]);

  // Validate a freshly-picked batch (extension + count + size, all from File
  // metadata — no bytes read yet), surface any rejections, then read only the
  // accepted files to base64 and append them. Reused validation keeps parity
  // with the prompt attachment feature; the server re-validates regardless.
  const handleFilesSelected = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      const { planned, errors } = planAttachmentAdditions(attachments, files);
      if (errors.length > 0) {
        showToast(errors.join("\n"), { type: "error" });
      }
      if (planned.length === 0) return;
      try {
        const added = await Promise.all(
          planned.map(async p => ({
            id: `att-${attachmentIdRef.current++}`,
            filename: p.filename,
            mimeType: p.mimeType,
            size: p.size,
            data: await readFileAsBase64(files[p.sourceIndex]),
          }))
        );
        setAttachments(prev => [...prev, ...added]);
      } catch {
        showToast("Couldn't read a selected file. Please try again.", {
          type: "error",
        });
      }
    },
    [attachments, showToast]
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const previewPayload = {
    category,
    description: trimmed,
    submitterEmail,
    // Filenames only — the base64 bytes are omitted from the preview for
    // readability (they ARE sent; this is a faithful, human-readable summary).
    attachments: attachments.map(a => a.filename),
    metadata: metadata ?? "(composing…)",
  };

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Your message plus the safe diagnostics previewed below are emailed
            to the maintainer. No conversation content, notes, or tokens are
            ever included.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 flex flex-col gap-4">
          {/* Category */}
          <div
            className="flex flex-wrap gap-2"
            role="radiogroup"
            aria-label="Feedback category"
          >
            {CATEGORIES.map(c => (
              <Button
                key={c.value}
                type="button"
                variant="outline"
                role="radio"
                aria-checked={category === c.value}
                onClick={() => setCategory(c.value)}
                data-testid={`feedback-category-${c.value}`}
                className={`h-auto rounded-md px-3 py-1.5 text-sm font-normal transition-colors ${
                  category === c.value
                    ? "border-transparent bg-accent font-medium text-black hover:bg-accent"
                    : "border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                }`}
              >
                {c.label}
              </Button>
            ))}
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1.5">
            {/* Optional AI assist (issue #2668) — only inside an active session. */}
            {assist.available ? (
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-xs text-[var(--app-hint)]"
                  data-testid="feedback-assist-status"
                >
                  {assist.isDrafting
                    ? "Claude is drafting a description in this session…"
                    : (assist.error ??
                      "In a session? Let Claude draft this for you.")}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => assist.requestDraft(description, category)}
                  disabled={assist.isDrafting}
                  data-testid="feedback-assist-button"
                  className="h-auto shrink-0 rounded-md border border-[var(--app-border)] px-2.5 py-1 text-xs font-normal text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {assist.isDrafting ? "Drafting…" : "Help me describe this"}
                </Button>
              </div>
            ) : null}
            <textarea
              autoCapitalize="none"
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={5}
              maxLength={5000}
              placeholder="Describe the bug, request, or feedback…"
              aria-label="Feedback description"
              data-testid="feedback-description"
              className="w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-sm text-[var(--app-fg)] outline-none"
            />
          </div>

          {/* Attachments (issue #2665) — optional files sent with the feedback. */}
          <div className="flex flex-col gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              data-testid="feedback-attach-input"
              aria-label="Attach files"
              onChange={e => {
                void handleFilesSelected(e.target.files);
                // Clear so re-selecting the same file still re-fires onChange.
                e.target.value = "";
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                data-testid="feedback-attach-button"
                className="h-auto rounded-md border border-[var(--app-border)] px-3 py-1.5 text-sm font-normal text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
              >
                Attach files
              </Button>
              <span className="text-xs text-[var(--app-hint)]">
                Up to {FEEDBACK_MAX_ATTACHMENTS} files,{" "}
                {ATTACHMENT_TOTAL_CAP_MB} MB total
              </span>
            </div>
            {attachments.length > 0 && (
              <ul
                className="flex flex-col gap-1"
                data-testid="feedback-attachment-list"
              >
                {attachments.map(a => (
                  <li
                    key={a.id}
                    data-testid="feedback-attachment"
                    className="flex items-center justify-between gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-xs"
                  >
                    <span
                      className="truncate text-[var(--app-fg)]"
                      title={a.filename}
                    >
                      {a.filename}
                    </span>
                    <Button
                      type="button"
                      variant="ghostStatic"
                      onClick={() => removeAttachment(a.id)}
                      aria-label={`Remove ${a.filename}`}
                      data-testid="feedback-attachment-remove"
                      className="h-auto shrink-0 rounded px-1 font-normal text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                    >
                      ✕
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Read-only preview — the EXACT payload that will be sent (R2). */}
          <details className="text-xs">
            <summary className="cursor-pointer select-none text-[var(--app-hint)]">
              {composing
                ? "Composing diagnostics…"
                : "Preview the exact data that will be sent"}
            </summary>
            <pre
              data-testid="feedback-preview"
              className="mt-2 max-h-48 w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-[length:var(--text-caption)] leading-tight text-[var(--app-hint)]"
            >
              {JSON.stringify(previewPayload, null, 2)}
            </pre>
          </details>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="h-auto rounded-md border border-[var(--app-border)] px-3 py-1.5 text-sm font-normal text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={handleSubmit}
              data-testid="feedback-submit"
              className="h-auto rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-black hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submit.isPending ? "Sending…" : "Send feedback"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
