// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ApiError, type ApiClient } from "@/api/client";
import type { SupportChannelInfo, SupportEscalationPreview } from "@/types/api";
import { PUBLIC_CORE_REPO_URL } from "@/lib/publicCoreSource";

/** Where the "open an issue" link points: the operator's URL, else the public Core repo's. */
export function supportIssueUrl(channel: SupportChannelInfo | null): string {
  if (channel?.issueUrl) return channel.issueUrl;
  return PUBLIC_CORE_REPO_URL ? `${PUBLIC_CORE_REPO_URL}/issues/new` : "";
}

interface SupportEscalationModalProps {
  open: boolean;
  onClose: () => void;
  api: ApiClient;
  channel: SupportChannelInfo | null;
  /** The channel request failed: show the open-an-issue path, not a spinner. */
  channelError?: boolean;
  /** The support session to escalate from; null when there is none yet. */
  sessionId: string | null;
  /** Offered when there is no support session yet (self-help first, R5). */
  onAskAssistant?: () => void;
  /** The login username (≡ account email) a reply goes to; null when unknown. */
  replyEmail: string | null;
}

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; delivered: boolean }
  | { kind: "error"; message: string };

const ACTION_CLASS =
  "h-auto rounded-md border border-[var(--app-border)] px-3 py-1.5 text-sm font-normal text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]";
const PRIMARY_CLASS =
  "h-auto rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-black hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40";

function IssueLink(props: { channel: SupportChannelInfo | null }) {
  const href = supportIssueUrl(props.channel);
  if (!href) {
    return (
      <p className="text-sm text-[var(--app-hint)]">
        Open an issue on GitHub with the steps that led to the problem.
      </p>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="support-issue-link"
      className="text-sm font-medium text-[var(--brand-accent)] underline"
    >
      Open an issue on GitHub
    </a>
  );
}

/**
 * SupportEscalationModal — the "Contact a human" lifeline (issue #4371 R3/R6).
 *
 *  - channel `none` (a self-hosted Core install): the GitHub-issue link instead
 *    of a Send button, so the lifeline never fails
 *  - the channel request failed, or a preview or send failed: the same link,
 *    so no error state is a dead end
 *  - no support session yet: self-help first (R5) — offer the assistant, and
 *    the issue link as the fallback
 *  - otherwise: the redacted bundle, verbatim and read-only, exactly as it
 *    will be sent, plus the hours text and Send. Send carries the preview's
 *    sha256; when the conversation moved on, the server refuses and the modal
 *    loads the new preview for the user to review.
 */
export function SupportEscalationModal(props: SupportEscalationModalProps) {
  const {
    open,
    onClose,
    api,
    channel,
    channelError,
    sessionId,
    onAskAssistant,
    replyEmail,
  } = props;
  const [preview, setPreview] = useState<SupportEscalationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [send, setSend] = useState<SendState>({ kind: "idle" });

  const canSend = Boolean(channel && channel.kind !== "none" && sessionId);

  // Read the client through a ref: a JWT refresh builds a new ApiClient, and
  // re-running the open effect for it would reset a sent modal back to Send.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const loadPreview = useCallback(async () => {
    if (!sessionId) return;
    setPreviewError(null);
    try {
      setPreview(await apiRef.current.previewSupportEscalation(sessionId));
    } catch {
      setPreview(null);
      setPreviewError("Could not build the preview. Try again in a moment.");
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    setSend({ kind: "idle" });
    setNotice(null);
    setPreview(null);
    if (canSend) void loadPreview();
  }, [open, canSend, loadPreview]);

  const handleSend = async () => {
    if (!sessionId || !preview) return;
    setSend({ kind: "sending" });
    setNotice(null);
    try {
      const result = await api.sendSupportEscalation(
        sessionId,
        preview.hash,
        replyEmail
      );
      setSend({ kind: "sent", delivered: result.delivered });
    } catch (err) {
      if (err instanceof ApiError && err.code === "bundle_changed") {
        setSend({ kind: "idle" });
        setNotice(
          "Your conversation changed since this preview. Review the updated text below, then send."
        );
        await loadPreview();
        return;
      }
      setSend({
        kind: "error",
        message: "Sending failed. Try again, or open an issue instead.",
      });
    }
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
          <DialogTitle>Contact a human</DialogTitle>
          <DialogDescription>
            {canSend
              ? "This is exactly what will be sent. Tokens and keys have been removed."
              : "A person can help when the assistant cannot."}
          </DialogDescription>
        </DialogHeader>

        <div
          className="mt-3 flex flex-col gap-4"
          data-testid="support-escalation-modal"
        >
          {channel?.hoursText ? (
            <p
              data-testid="support-hours-text"
              className="text-sm text-[var(--app-hint)]"
            >
              {channel.hoursText}
            </p>
          ) : null}

          {!channel ? (
            channelError ? (
              <div
                data-testid="support-channel-error"
                className="flex flex-col gap-2"
              >
                <p className="text-sm text-[var(--app-fg)]">
                  The support settings could not be loaded. Open an issue, with
                  the steps that led to the problem.
                </p>
                <IssueLink channel={null} />
              </div>
            ) : (
              <p className="text-sm text-[var(--app-hint)]">Loading…</p>
            )
          ) : channel.kind === "none" ? (
            <div
              data-testid="support-no-channel"
              className="flex flex-col gap-2"
            >
              <p className="text-sm text-[var(--app-fg)]">
                This install has no support team configured. Open an issue, with
                the steps that led to the problem.
              </p>
              <IssueLink channel={channel} />
            </div>
          ) : !sessionId ? (
            <div
              data-testid="support-no-session"
              className="flex flex-col gap-3"
            >
              <p className="text-sm text-[var(--app-fg)]">
                Start with the assistant: most questions are answered straight
                away. If it cannot help, use Contact a human from the support
                session, and your conversation goes along so you do not have to
                repeat yourself.
              </p>
              {onAskAssistant ? (
                <div>
                  <Button
                    type="button"
                    onClick={onAskAssistant}
                    className={PRIMARY_CLASS}
                  >
                    Ask the assistant
                  </Button>
                </div>
              ) : null}
              <IssueLink channel={channel} />
            </div>
          ) : send.kind === "sent" ? (
            <div className="flex flex-col gap-2">
              <p
                data-testid="support-sent"
                className="text-sm text-[var(--app-fg)]"
              >
                {send.delivered
                  ? replyEmail
                    ? `Sent. A person will reply to ${replyEmail}.`
                    : "Sent. A person will look at it."
                  : "Not delivered: your conversation could not be sent right now. A record of the attempt is saved on this install. Close this and try again in a moment, or open an issue."}
              </p>
              {send.delivered ? null : <IssueLink channel={channel} />}
            </div>
          ) : (
            <>
              {notice ? (
                <p
                  data-testid="support-preview-notice"
                  className="text-sm text-[var(--app-fg)]"
                >
                  {notice}
                </p>
              ) : null}
              {previewError ? (
                <div className="flex flex-col gap-2">
                  <p
                    data-testid="support-preview-error"
                    className="text-sm text-[var(--app-hint)]"
                  >
                    {previewError}
                  </p>
                  <IssueLink channel={channel} />
                </div>
              ) : (
                <pre
                  data-testid="support-preview"
                  className="max-h-64 w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-[length:var(--text-caption)] leading-tight text-[var(--app-hint)]"
                >
                  {preview ? preview.bundle : "Building the preview…"}
                </pre>
              )}
              <p className="text-sm text-[var(--app-hint)]">
                {replyEmail
                  ? `A reply goes to ${replyEmail}.`
                  : "Add a way to reach you to the conversation before you send."}
              </p>
              {send.kind === "error" ? (
                <div className="flex flex-col gap-2">
                  <p
                    data-testid="support-send-error"
                    className="text-sm text-[var(--app-hint)]"
                  >
                    {send.message}
                  </p>
                  <IssueLink channel={channel} />
                </div>
              ) : null}
            </>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className={ACTION_CLASS}
            >
              {send.kind === "sent" ? "Close" : "Cancel"}
            </Button>
            {canSend && send.kind !== "sent" ? (
              <Button
                type="button"
                disabled={!preview || send.kind === "sending"}
                onClick={() => void handleSend()}
                data-testid="support-send"
                className={PRIMARY_CLASS}
              >
                {send.kind === "sending" ? "Sending…" : "Send"}
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
