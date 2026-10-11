// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from "react";
import { MessagePrimitive, useAssistantState } from "@assistant-ui/react";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { LazyRainbowText } from "@/components/LazyRainbowText";
import { useHappyChatContext } from "@/components/AssistantChat/context";
import type { HappyChatMessageMetadata } from "@/lib/assistant-runtime";
import { MessageStatusIndicator } from "@/components/AssistantChat/messages/MessageStatusIndicator";
import { CliOutputBlock } from "@/components/CliOutputBlock";
import { CopyButton } from "@/components/ui/CopyButton";
import { useToast } from "@/components/Toast";
import { formatMessageTimestamp } from "@/utils/formatMessageTimestamp";
import { parseAttachedFiles } from "@/lib/parseAttachedFiles";
import { ImageFullscreenModal } from "@/components/ImageFullscreenModal";
import { PdfViewerModal } from "@/components/PdfViewerModal";
import { TextFileViewerModal } from "@/components/TextFileViewerModal";
import { usePdfThumbnail } from "@/hooks/usePdfThumbnail";
import { getFileCategory } from "@/lib/file-types";
import { messagePreview } from "@/chat/messagePreview";
import { CompactChevron } from "@/components/AssistantChat/messages/CompactChevron";
import { BookmarkGutter } from "@/components/AssistantChat/messages/BookmarkGutter";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { UserMarkerChip } from "@/components/UserMarkerChip";
import {
  leadingHtmlCommentMarker,
  stripLeadingHtmlComments,
} from "@/lib/htmlCommentMarker";

const USER_MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks];

function PdfThumbnailButton({
  src,
  filename,
}: {
  src: string;
  filename: string;
}) {
  const thumbnail = usePdfThumbnail(src);
  const [viewerOpen, setViewerOpen] = useState(false);
  return (
    <>
      <button /* design-tokens-allow: image/thumbnail-card viewer wrapper - D2 E2 exception (#3357) */
        type="button"
        onClick={() => setViewerOpen(true)}
        className="rounded-lg overflow-hidden cursor-pointer"
        aria-label={`View ${filename}`}
      >
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={`${filename} page 1`}
            className="h-16 w-16 object-cover rounded-lg border border-white/10"
          />
        ) : (
          <div className="h-16 w-16 rounded-lg bg-red-500/10 flex flex-col items-center justify-center text-red-400 border border-white/5">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="text-[8px] mt-0.5 font-bold">PDF</span>
          </div>
        )}
      </button>
      <PdfViewerModal
        src={src}
        filename={filename}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
      />
    </>
  );
}

function TextFileThumbnailButton({
  src,
  filename,
}: {
  src: string;
  filename: string;
}) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).toUpperCase()
    : "TXT";
  return (
    <>
      <button /* design-tokens-allow: image/thumbnail-card viewer wrapper - D2 E2 exception (#3357) */
        type="button"
        onClick={() => setViewerOpen(true)}
        className="rounded-lg overflow-hidden cursor-pointer"
        aria-label={`View ${filename}`}
      >
        <div className="h-16 w-16 rounded-lg bg-[var(--app-link)]/10 flex flex-col items-center justify-center text-[var(--app-link)] border border-[var(--app-link)]/20">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="text-[8px] mt-0.5 font-bold">{ext}</span>
        </div>
      </button>
      <TextFileViewerModal
        src={src}
        filename={filename}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
      />
    </>
  );
}

function AttachedFileThumbnails({
  sessionId,
  files,
}: {
  sessionId: string;
  files: { path: string; filename: string; isImage: boolean }[];
}) {
  const ctx = useHappyChatContext();
  const [fullscreenSrc, setFullscreenSrc] = useState<string | null>(null);

  const categorized = files.map(file => ({
    ...file,
    category: getFileCategory(file.filename),
    src: ctx.api.getUploadFileUrl(sessionId, file.filename),
  }));

  const previewable = categorized.filter(
    f => f.category === "image" || f.category === "pdf" || f.category === "text"
  );
  if (previewable.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {previewable.map(file => {
          if (file.category === "image") {
            return (
              <button /* design-tokens-allow: image viewer wrapper - D2 E2 exception (#3357) */
                key={file.path}
                type="button"
                onClick={() => setFullscreenSrc(file.src)}
                className="rounded-lg overflow-hidden cursor-pointer"
                aria-label={`View ${file.filename} fullscreen`}
              >
                <img
                  src={file.src}
                  alt={file.filename}
                  className="h-16 w-16 object-cover rounded-lg"
                  loading="lazy"
                />
              </button>
            );
          }
          if (file.category === "pdf") {
            return (
              <PdfThumbnailButton
                key={file.path}
                src={file.src}
                filename={file.filename}
              />
            );
          }
          return (
            <TextFileThumbnailButton
              key={file.path}
              src={file.src}
              filename={file.filename}
            />
          );
        })}
      </div>
      {fullscreenSrc && (
        <ImageFullscreenModal
          src={fullscreenSrc}
          alt="Attached image"
          open={true}
          onOpenChange={open => {
            if (!open) setFullscreenSrc(null);
          }}
        />
      )}
    </>
  );
}

export function HappyUserMessage() {
  const ctx = useHappyChatContext();
  // #2990 (S3): manual collapse for user messages. Runtime-only, default expanded
  // (epic D5), LOCAL state (ruling d3 — orthogonal to the attachment viewers'
  // own `viewerOpen` state, which lives in the thumbnail sub-components). Declared
  // above every early return so hook order is stable; the id is the stable
  // `user:${block.id}` so collapse resets on thread reload (R3).
  const [collapsed, setCollapsed] = useState(false);
  const role = useAssistantState(({ message }) => message.role);
  const messageId = useAssistantState(({ message }) => message.id);
  const text = useAssistantState(({ message }) => {
    if (message.role !== "user") return "";
    return message.content.find(part => part.type === "text")?.text ?? "";
  });
  const status = useAssistantState(({ message }) => {
    if (message.role !== "user") return undefined;
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    return custom?.status;
  });
  // #3579 (R2): the gate-denial outcome carried on a "blocked" bubble — its title
  // is shown as a one-line caption; the full explanation + recovery chip live on
  // the durable in-thread notice.
  const denial = useAssistantState(({ message }) => {
    if (message.role !== "user") return undefined;
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    return custom?.denial;
  });
  const localId = useAssistantState(({ message }) => {
    if (message.role !== "user") return null;
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    return custom?.localId ?? null;
  });
  const isCliOutput = useAssistantState(({ message }) => {
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    return custom?.kind === "cli-output";
  });
  const cliText = useAssistantState(({ message }) => {
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    if (custom?.kind !== "cli-output") return "";
    return message.content.find(part => part.type === "text")?.text ?? "";
  });
  const createdAt = useAssistantState(({ message }) => message.createdAt);
  const isInherited = useAssistantState(({ message }) => {
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    return custom?.isInherited === true;
  });
  const isTaskNotification = useAssistantState(({ message }) => {
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    return custom?.isTaskNotification === true;
  });

  const { showToast } = useToast();

  const parsed = useMemo(() => parseAttachedFiles(text), [text]);
  const hasAttachedFiles = parsed.files.length > 0;
  const bodyText = hasAttachedFiles ? parsed.textBeforeAttachments : text;
  // #4089: a turn that starts with a machine marker (a loop-cron tick, a PM
  // relay) shows a label chip in place of the marker line, in the bubble and in
  // the collapse preview. Display-only: the copy button still copies `text`.
  const strippedText = stripLeadingHtmlComments(bodyText);
  const displayText = strippedText ?? bodyText;
  const marker =
    strippedText !== null ? leadingHtmlCommentMarker(bodyText) : null;

  if (role !== "user") return null;
  const canRetry =
    status === "failed" &&
    typeof localId === "string" &&
    Boolean(ctx.onRetryMessage);
  const onRetry = canRetry ? () => ctx.onRetryMessage!(localId) : undefined;

  const inheritedClass = isInherited ? " opacity-50" : "";
  const userBubbleClass =
    "w-fit min-w-0 max-w-[92%] ml-auto rounded-xl bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)] shadow-sm";

  // #2990 (S3, R2/R10): the collapse preview comes from `displayText` — the text
  // the bubble actually renders (before the 📎 attachment block, per
  // parseAttachedFiles) — NOT the raw text. An attachment-only message falls back
  // to a "📎 N attachment(s)" label. Show the affordance whenever there is a body
  // (text or attachments) to reclaim.
  const showUserCollapse = displayText.trim().length > 0 || hasAttachedFiles;
  const userPreview =
    displayText.trim().length > 0
      ? messagePreview(displayText)
      : hasAttachedFiles
        ? `📎 ${parsed.files.length} attachment${
            parsed.files.length === 1 ? "" : "s"
          }`
        : "";

  if (isCliOutput) {
    return (
      <MessagePrimitive.Root
        data-message-role="user"
        data-message-id={messageId}
        className={`py-1 flex min-w-0 max-w-full overflow-x-hidden${inheritedClass}`}
      >
        <BookmarkGutter messageId={messageId} />
        <div className="flex-1 min-w-0">
          <div className="ml-auto w-full max-w-[92%]">
            <CliOutputBlock text={cliText} />
          </div>
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (isTaskNotification) {
    return (
      <MessagePrimitive.Root
        data-message-role="user"
        data-message-id={messageId}
        className="py-1 flex min-w-0 max-w-full overflow-x-hidden"
      >
        <BookmarkGutter messageId={messageId} />
        <div className="flex-1 min-w-0">
          <details className="opacity-40 hover:opacity-60 transition-opacity text-xs ml-auto w-fit max-w-[92%]">
            <summary className="cursor-pointer select-none text-[var(--app-hint)] py-0.5 text-right">
              Background agent notification
            </summary>
            <div className="mt-1 rounded-lg bg-[var(--app-secondary-bg)]/50 px-3 py-2 text-[var(--app-fg)]/60 text-xs">
              {displayText}
            </div>
          </details>
        </div>
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root
      data-message-role="user"
      data-message-id={messageId}
      className={`group py-1 flex${inheritedClass}`}
    >
      <BookmarkGutter messageId={messageId} />
      {/* #3017 round-2 feedback: `data-cat="user"` sits on the WHOLE section
          container so the right-edge category border spans the heading, the
          bubble, and the footer — everything the heading would collapse. */}
      <div
        className="flex-1 min-w-0 flex flex-col items-end"
        {...(showUserCollapse ? { "data-cat": "user" } : {})}
      >
        {/* #2990 (S3): manual collapse affordance — same CompactChevron idiom as the
          response (epic ruling b2), right-aligned to the bubble. Real <button> with
          `aria-expanded` (Task 5). */}
        {showUserCollapse ? (
          <div className="ml-auto w-full max-w-[92%]">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCollapsed(c => !c)}
              aria-expanded={!collapsed}
              aria-label={
                collapsed ? "Expand user message" : "Collapse user message"
              }
              className={cn(
                "ml-auto flex h-auto min-w-0 max-w-full items-center justify-start gap-2 rounded px-1 py-0.5",
                "text-left text-xs font-normal text-[var(--app-hint)] transition-colors",
                "cursor-pointer hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]",
                collapsed ? "" : "opacity-40 hover:opacity-100"
              )}
            >
              {/* #3017 round-2 feedback: the user row is right-justified, so
                  its chevron sits to the RIGHT of the label (mirror of the
                  left-justified System row's chevron-first order). */}
              {collapsed ? (
                <span className="min-w-0 flex-1 truncate">{userPreview}</span>
              ) : null}
              <span className="shrink-0 font-medium">User</span>
              <CompactChevron open={!collapsed} />
            </Button>
          </div>
        ) : null}
        {/* #2990 (S3, R6/OR3): collapse hides the bubble, its attachments AND the
          copy/timestamp footer; copy still copies the full text on expand. */}
        {!collapsed ? (
          <>
            <div className={userBubbleClass}>
              <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                  {marker ? <UserMarkerChip marker={marker} /> : null}
                  <LazyRainbowText
                    text={displayText}
                    remarkPlugins={USER_MARKDOWN_PLUGINS}
                    className="[&>p+p]:mt-3"
                  />
                </div>
                {status ? (
                  <div className="shrink-0 self-end pb-0.5">
                    <MessageStatusIndicator status={status} onRetry={onRetry} />
                  </div>
                ) : null}
              </div>
              {hasAttachedFiles && (
                <AttachedFileThumbnails
                  sessionId={ctx.sessionId}
                  files={parsed.files}
                />
              )}
            </div>
            {status === "blocked" && denial ? (
              <div
                className="ml-auto mt-1 w-fit max-w-[92%] text-right text-xs text-[var(--app-hint)]"
                data-testid="user-blocked-caption"
              >
                {denial.title}
              </div>
            ) : null}
            <div className="flex items-center justify-end gap-2 mt-1 mr-1 opacity-40 hover:opacity-100 transition-opacity">
              <span className="text-[11px] text-[var(--app-hint)]">
                {formatMessageTimestamp(createdAt)}
              </span>
              <CopyButton
                text={text}
                aria-label="Copy message"
                title="Copy message"
                onCopied={ok => ok && showToast("Copied!")}
              />
            </div>
          </>
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
}
