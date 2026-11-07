// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { ImageWithFullscreen } from "@/components/ImageWithFullscreen";
import { useToast } from "@/components/Toast";
import type { ApiClient } from "@/api/client";
import type {
  FeedbackCategory,
  FeedbackMetadata,
  SessionResponse,
} from "@/types/api";
import {
  composeFeedbackMetadata,
  toSubmitterEmail,
} from "@/lib/feedbackMetadata";
import { useSubmitFeedback } from "@/hooks/mutations/useSubmitFeedback";
import {
  planAttachmentAdditions,
  readFileAsBase64,
  toFeedbackAttachments,
  type PendingFeedbackAttachment,
} from "@/lib/feedbackAttachments";
import { useFeedbackDraftAssist } from "@/hooks/useFeedbackDraftAssist";
import { captureViewportPng } from "@/lib/captureScreenshot";
import { errorReporter } from "@/lib/error-reporter";
import { queryKeys } from "@/lib/query-keys";
import {
  endFeedbackOpenTrace,
  isFeedbackOpenTraceActive,
  markFeedbackOpenPhase,
  reportIncompleteFeedbackOpenTrace,
  startFeedbackOpenTrace,
} from "@/lib/feedbackOpenTrace";

const ATTACHMENT_TOTAL_CAP_MB =
  FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024;

/**
 * Delay before reporting an open trace an earlier page left behind (#6190).
 * Defensive: in the app `errorReporter.initialize` has already run by the time
 * this form mounts (it renders only once signed in), but a report sent before
 * it is a no-op, and the delay also keeps the report off the launch path.
 */
export const FEEDBACK_TRACE_REPORT_DELAY_MS = 2_000;

/**
 * Run `callback` after the next paint (the frame, then a task), so work started
 * on open never delays the form's first frame (#6190). Returns a cancel function.
 */
function afterNextPaint(callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (typeof requestAnimationFrame !== "function") {
    timer = setTimeout(callback, 0);
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(callback, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
  };
}

/**
 * Image types every supported browser can draw in an `<img>`, so they get a
 * thumbnail (issue #2895 R5). HEIC/HEIF pass the upload allowlist but most
 * non-Safari browsers cannot render them; those rows get no thumbnail (the
 * filename, remove button and picture warning still show).
 */
const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// No "reload" advice: a reload throws away the typed description.
const SCREENSHOT_FAILED_MESSAGE =
  "Couldn't capture a screenshot. You can still send your feedback without it.";

const SENT_WITHOUT_SCREENSHOT_MESSAGE =
  "Feedback sent — thank you! The screenshot was still being captured, so it wasn't included.";

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
  const queryClient = useQueryClient();
  const submit = useSubmitFeedback(api);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [metadata, setMetadata] = useState<FeedbackMetadata | null>(null);
  // Starts as the login's email (if any) and updates when the compose resolves;
  // only an email address, never a raw login handle the server would refuse
  // (#2951 L3).
  const [submitterEmail, setSubmitterEmail] = useState<string | null>(() =>
    toSubmitterEmail(loginUsername)
  );
  const [composing, setComposing] = useState(false);
  const [attachments, setAttachments] = useState<PendingFeedbackAttachment[]>(
    []
  );
  // The authoritative attachment list for async adds (issue #2895). A file read
  // or a screenshot finishes after an await, so planning against the render's
  // `attachments` closure could pass the count/size caps twice for two
  // overlapping adds. Every write goes through `replaceAttachments`.
  const attachmentsRef = useRef<PendingFeedbackAttachment[]>([]);
  // Bumped each time the modal closes. An add that started before the close
  // drops its result, so a late screenshot never lands in the next feedback.
  const generationRef = useRef(0);
  const capturingRef = useRef(false);
  const [capturing, setCapturing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Monotonic local id source. NOT crypto.randomUUID() — that requires a secure
  // context, but the primary deployment is plain-HTTP over the Tailscale IP.
  const attachmentIdRef = useRef(0);

  const replaceAttachments = useCallback(
    (next: PendingFeedbackAttachment[]) => {
      attachmentsRef.current = next;
      setAttachments(next);
    },
    []
  );

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

  // #6190: report, once, an open trace an earlier page left behind (the form
  // never closed there, e.g. the app froze and was force-quit).
  useEffect(() => {
    const timer = setTimeout(
      () => reportIncompleteFeedbackOpenTrace(),
      FEEDBACK_TRACE_REPORT_DELAY_MS
    );
    return () => {
      clearTimeout(timer);
      // Unmounted while open: not a frozen page, so leave no trace behind.
      endFeedbackOpenTrace();
    };
  }, []);

  // #6190: trace this open. The footer button starts the trace on tap; start
  // here when the form was opened another way.
  useLayoutEffect(() => {
    if (!open) return;
    if (!isFeedbackOpenTraceActive()) {
      startFeedbackOpenTrace({
        appVersion,
        viewport:
          typeof window !== "undefined"
            ? `${window.innerWidth}x${window.innerHeight}`
            : undefined,
        inSession: Boolean(sessionId),
      });
    }
    markFeedbackOpenPhase("mounted");
    // Only the open transition starts a trace; the other values are read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Compose the privacy-safe metadata preview whenever the modal opens. #6190:
  // only after the form's first paint, so opening never waits on it; the reads
  // run in parallel, each with a deadline, so the preview always settles.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setComposing(true);
    setMetadata(null);
    const cancelPaintWait = afterNextPaint(() => {
      if (cancelled) return;
      markFeedbackOpenPhase("painted");
      markFeedbackOpenPhase("compose-start");
      composeFeedbackMetadata({
        api,
        route,
        sessionId,
        appVersion,
        loginUsername,
        // #6190: a slow session read falls back to the copy the app holds.
        getCachedSession: () =>
          sessionId
            ? queryClient.getQueryData<SessionResponse>(
                queryKeys.session(sessionId)
              )?.session
            : undefined,
        onReadSettled: (read, ok) => {
          if (!cancelled) {
            markFeedbackOpenPhase(
              ok ? (`${read}-settled` as const) : (`${read}-failed` as const)
            );
          }
        },
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
          if (cancelled) return;
          setComposing(false);
          markFeedbackOpenPhase("composed");
        });
    });
    return () => {
      cancelled = true;
      cancelPaintWait();
    };
  }, [open, api, route, sessionId, appVersion, loginUsername, queryClient]);

  // Reset the form when the modal closes.
  useEffect(() => {
    if (!open) {
      // #6190: a clean close deletes the open trace.
      endFeedbackOpenTrace();
      generationRef.current += 1;
      // A capture still running belongs to the closed form; the next opening
      // must not inherit its busy button.
      capturingRef.current = false;
      setCapturing(false);
      setDescription("");
      setCategory("bug");
      replaceAttachments([]);
      resetAssist();
    }
  }, [open, resetAssist, replaceAttachments]);

  const trimmed = description.trim();
  // Send stays enabled while a screenshot is capturing, because a capture
  // never blocks text-only feedback (R4); a send mid-capture says so instead.
  const canSubmit =
    trimmed.length > 0 && metadata !== null && !submit.isPending;

  const handleSubmit = useCallback(() => {
    if (!trimmed || !metadata) return;
    // The payload is the list as it is now; a capture still running is left
    // out, and its late result is dropped when the form closes.
    const screenshotLeftOut = capturingRef.current;
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
          showToast(
            screenshotLeftOut
              ? SENT_WITHOUT_SCREENSHOT_MESSAGE
              : "Feedback sent — thank you!",
            { type: "success" }
          );
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

  // Validate a batch (extension + count + size, all from File metadata — no
  // bytes read yet), surface any rejections, then read only the accepted files
  // to base64 and append them. Reused validation keeps parity with the prompt
  // attachment feature; the server re-validates regardless. Shared by the file
  // picker and the screenshot action (a `FileList` cannot be constructed).
  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const generation = generationRef.current;
      const { planned, errors } = planAttachmentAdditions(
        attachmentsRef.current,
        files
      );
      if (errors.length > 0) {
        showToast(errors.join("\n"), { type: "error" });
      }
      if (planned.length === 0) return;
      let read: PendingFeedbackAttachment[];
      try {
        read = await Promise.all(
          planned.map(async p => ({
            id: `att-${attachmentIdRef.current++}`,
            filename: p.filename,
            mimeType: p.mimeType,
            size: p.size,
            data: await readFileAsBase64(files[p.sourceIndex]),
          }))
        );
      } catch {
        if (generation === generationRef.current) {
          showToast("Couldn't read a selected file. Please try again.", {
            type: "error",
          });
        }
        return;
      }
      // The modal closed (and reset) during the read: drop the result.
      if (generation !== generationRef.current) return;
      // Re-check the caps and names against the list as it is now, because
      // another add may have committed while these bytes were read.
      const current = attachmentsRef.current;
      const recheck = planAttachmentAdditions(
        current,
        read.map(a => ({ name: a.filename, type: a.mimeType, size: a.size }))
      );
      if (recheck.errors.length > 0) {
        showToast(recheck.errors.join("\n"), { type: "error" });
      }
      if (recheck.planned.length === 0) return;
      replaceAttachments([
        ...current,
        ...recheck.planned.map(p => ({
          ...read[p.sourceIndex],
          filename: p.filename,
        })),
      ]);
    },
    [showToast, replaceAttachments]
  );

  const handleFilesSelected = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return Promise.resolve();
      return addFiles(Array.from(fileList));
    },
    [addFiles]
  );

  // Issue #2895: a one-tap PNG of the app behind this form. The dialog portals
  // to <body>, outside #root, so the form is not in its own picture. Capture
  // only ever runs from this explicit tap, and the result joins the attachment
  // list (thumbnail + remove) like any picked file — never sent unseen (R3).
  const handleCaptureScreenshot = useCallback(async () => {
    if (capturingRef.current) return;
    const root = document.getElementById("root");
    if (!root) {
      showToast(SCREENSHOT_FAILED_MESSAGE, { type: "error" });
      return;
    }
    // A full list or a spent byte budget would reject the picture anyway; say
    // so before capturing. One byte, so a budget at exactly the cap fails here.
    const preflight = planAttachmentAdditions(attachmentsRef.current, [
      { name: "screenshot.png", type: "image/png", size: 1 },
    ]);
    if (preflight.planned.length === 0) {
      showToast(preflight.errors.join("\n"), { type: "error" });
      return;
    }
    const generation = generationRef.current;
    capturingRef.current = true;
    setCapturing(true);
    try {
      const used = attachmentsRef.current.reduce((sum, a) => sum + a.size, 0);
      const file = await captureViewportPng(root, {
        maxBytes: FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES - used,
      });
      if (generation !== generationRef.current) return;
      await addFiles([file]);
    } catch (err) {
      if (generation === generationRef.current) {
        // Logged as well as toasted, so a browser where capture always fails
        // shows up in the error log instead of only in users' toasts.
        errorReporter.report({
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? (err.stack ?? null) : null,
          category: "feedback-screenshot-failure",
          severity: "warn",
        });
        showToast(SCREENSHOT_FAILED_MESSAGE, { type: "error" });
      }
    } finally {
      // After a close, the reset already cleared the busy state, and a capture
      // started in the reopened form owns it now.
      if (generation === generationRef.current) {
        capturingRef.current = false;
        setCapturing(false);
      }
    }
  }, [addFiles, showToast]);

  const removeAttachment = useCallback(
    (id: string) => {
      replaceAttachments(attachmentsRef.current.filter(a => a.id !== id));
    },
    [replaceAttachments]
  );

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
          <DialogDescription data-testid="feedback-consent">
            Your message plus the safe diagnostics previewed below are emailed
            to the maintainer. Attached files and screenshots are sent as-is and
            are not scrubbed.
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
                  onClick={() => {
                    markFeedbackOpenPhase("assist-requested");
                    assist.requestDraft(description, category);
                  }}
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
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleCaptureScreenshot()}
                disabled={capturing}
                aria-busy={capturing}
                title="Attach a picture of the screen behind this form"
                data-testid="feedback-screenshot-button"
                className="h-auto rounded-md border border-[var(--app-border)] px-3 py-1.5 text-sm font-normal text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {capturing ? "Capturing…" : "Attach screenshot"}
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
                    className="flex flex-col gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      {/* The image preview IS the consent for a picture
                          (#2665 R11, #2895 R5): the user sees the exact
                          pixels before sending; tap to enlarge. */}
                      {PREVIEWABLE_IMAGE_TYPES.has(a.mimeType) ? (
                        <ImageWithFullscreen
                          src={`data:${a.mimeType};base64,${a.data}`}
                          alt={`Preview of ${a.filename}`}
                          className="h-12 w-12 shrink-0 rounded border border-[var(--app-border)] object-cover"
                        />
                      ) : null}
                      <span
                        className="min-w-0 flex-1 truncate text-[var(--app-fg)]"
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
                    </div>
                    {a.mimeType.startsWith("image/") ? (
                      <p
                        data-testid="feedback-attachment-image-warning"
                        className="text-[var(--app-hint)]"
                      >
                        This picture may show conversation content, code,
                        terminal output, and account details
                      </p>
                    ) : null}
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
