// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import type { ApiClient } from "@/api/client";
import { SessionChat } from "@/components/SessionChat";
import { LoadingState } from "@/components/LoadingState";
import { useSession } from "@/hooks/queries/useSession";
import { useMessages } from "@/hooks/queries/useMessages";
import { useParentMessages } from "@/hooks/queries/useParentMessages";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import { useSlashCommands } from "@/hooks/queries/useSlashCommands";
import { useSendMessage } from "@/hooks/mutations/useSendMessage";
import { useSessionActions } from "@/hooks/mutations/useSessionActions";
import { useNeedsReview } from "@/hooks/useNeedsReview";
import { getSessionTitle } from "@/lib/sessionHelpers";
import { Button } from "@/components/ui/button";

/**
 * Renders a session chat view inside a split pane.
 *
 * Mirrors the data-fetching and rendering logic of SessionPage (router.tsx)
 * but without page-level concerns (useDocumentTitle, useEmojiFavicon, useParams).
 * Receives sessionId as a prop instead of reading from the URL.
 */
export function SplitPaneSessionView(props: {
  sessionId: string;
  api: ApiClient;
  onBack: () => void;
}): React.ReactElement {
  const { sessionId, api, onBack } = props;

  const {
    session,
    messageCount,
    isLoading: sessionLoading,
    refetch: refetchSession,
  } = useSession(api, sessionId, true);
  const { localNode } = useFederatedSessions(api);
  const {
    messages,
    warning: messagesWarning,
    isLoading: messagesLoading,
    isLoadingMore: messagesLoadingMore,
    hasMore: messagesHasMore,
    loadMore: loadMoreMessages,
    refetch: refetchMessages,
  } = useMessages(api, sessionId);
  const { parentMessages, isLoading: parentMessagesLoading } =
    useParentMessages(api, session?.parentSessionId);
  const { sendMessage, retryMessage, isSending } = useSendMessage(
    api,
    sessionId
  );

  const { markAsSeen, checkNeedsReview } = useNeedsReview();
  const { setNeedsReviewOverride } = useSessionActions(api, sessionId ?? null);

  const needsReview = session
    ? checkNeedsReview(
        session.id,
        session.updatedAt,
        session.active,
        session.thinking,
        session.needsReviewOverride as "read" | "unread" | null | undefined
      )
    : false;

  const onComposeFocus = useCallback(() => {
    if (session) {
      markAsSeen(session.id, session.updatedAt);
      if (session.needsReviewOverride) {
        void setNeedsReviewOverride(null);
      }
    }
  }, [session, markAsSeen, setNeedsReviewOverride]);

  const agentType = session?.metadata?.flavor ?? "claude";
  const { getSuggestions: getSlashSuggestions } = useSlashCommands(
    api,
    sessionId,
    agentType
  );

  const onToggleReadStatus = useCallback(
    (action: "read" | "unread") => {
      if (session) {
        void setNeedsReviewOverride(action);
      }
    },
    [session, setNeedsReviewOverride]
  );

  const refreshSelectedSession = useCallback(() => {
    void refetchSession();
    void refetchMessages();
  }, [refetchMessages, refetchSession]);

  if (!session) {
    if (sessionLoading) {
      return (
        <div className="flex-1 flex items-center justify-center p-4">
          <LoadingState label="Loading session…" className="text-sm" />
        </div>
      );
    }
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3">
        <p className="text-sm text-[var(--app-fg)]/60">Session not found</p>
        <button /* design-tokens-allow: bare text link (text-link style, hover:underline, no box); Button chrome breaks the inline link - L2 exception (#3404) */
          type="button"
          onClick={onBack}
          className="text-sm text-[var(--app-link)] hover:underline"
        >
          Back to sessions
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Pane-level back button — returns to session list in this pane */}
      <div className="flex items-center px-2 py-1 bg-[var(--app-bg)] border-b border-[var(--app-border)]">
        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          className="h-auto p-1 rounded-full font-normal hover:bg-[var(--app-secondary-bg)]"
          title="Back to session list"
          aria-label="Back to session list"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Button>
        <span className="ml-1 text-xs text-[var(--app-hint)] truncate">
          {session.emoji ? `${session.emoji} ` : ""}
          {getSessionTitle(session)}
        </span>
      </div>
      <SessionChat
        api={api}
        session={session}
        // #3638 (X5): in a split pane, full-screen hides ONLY pane-local chrome
        // (ViewPicker/SessionHeader/info strip); the shared app bar is never
        // hidden, so SessionChat must NOT set the lifted app-bar context here.
        inSplitPane
        messages={messages}
        parentMessages={parentMessages}
        isLoadingParentMessages={parentMessagesLoading}
        messagesWarning={messagesWarning}
        hasMoreMessages={messagesHasMore}
        isLoadingMessages={messagesLoading}
        isLoadingMoreMessages={messagesLoadingMore}
        isSending={isSending}
        onBack={onBack}
        onRefresh={refreshSelectedSession}
        onLoadMore={loadMoreMessages}
        onSend={sendMessage}
        onRetryMessage={retryMessage}
        autocompleteSuggestions={getSlashSuggestions}
        onComposeFocus={onComposeFocus}
        needsReview={needsReview}
        onToggleReadStatus={onToggleReadStatus}
        serverMessageCount={messageCount}
        nodeId={session.nodeId ?? localNode?.nodeId}
        nodeLabel={session.nodeLabel ?? localNode?.nodeLabel}
        nodeUrl={session.nodeUrl}
        nodeStatus={session.nodeStatus}
      />
    </div>
  );
}
