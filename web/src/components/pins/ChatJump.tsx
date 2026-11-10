// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import type { Bookmark, DecryptedMessage } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { usePinRecord } from "@/hooks/queries/usePins";
import { useChatJump, type ChatJumpTarget } from "@/hooks/useChatJump";

/** `at=pin:<key>` names a pin; any other value is a bookmark id. */
export const PIN_JUMP_PREFIX = "pin:";

export type ChatJumpProps = {
  api: ApiClient | null;
  sessionId: string;
  /** The route's `?at=` value. */
  at: string;
  viewportRef: React.RefObject<HTMLElement | null>;
  messages: readonly DecryptedMessage[];
  bookmarks: readonly Bookmark[];
  bookmarksLoading: boolean;
  loadMore: () => Promise<unknown>;
  hasMore: boolean;
  isLoadingMore: boolean;
  onDone: () => void;
};

/**
 * #6453 (R11, R12): the chat's `?at=` jump. Lazy-loaded into the Pins chunk,
 * because reading a pin's record loads the pin schemas, which the main bundle
 * keeps out (the PWA precache limit, vite.config.ts). Mounted only while `?at=`
 * is set, and renders nothing.
 */
export default function ChatJump(props: ChatJumpProps) {
  const { api, sessionId } = props;
  // #6453 (IR-4): a raw search value can arrive as an array or an object (a
  // repeated or JSON-shaped `?at=`); only text names a spot, so anything else
  // reads as an unknown bookmark and the jump just clears the link.
  const at = typeof props.at === "string" ? props.at : "";
  const pinKey = at.startsWith(PIN_JUMP_PREFIX)
    ? at.slice(PIN_JUMP_PREFIX.length)
    : null;
  const record = usePinRecord(api, sessionId, pinKey ?? "", pinKey !== null);
  const target = useMemo<ChatJumpTarget>(() => {
    if (pinKey === null) return { kind: "bookmark", id: at };
    if (record.data?.kind === "ready")
      return { kind: "pin", pin: record.data.pin };
    // Missing, unavailable or failed: nothing to jump to.
    if (record.data || record.isError || !api)
      return { kind: "pin", pin: null };
    return { kind: "pin", pin: undefined };
  }, [pinKey, at, record.data, record.isError, api]);

  useChatJump(props.viewportRef, {
    jumpKey: `${sessionId}\u0000${at}`,
    target,
    messages: props.messages,
    bookmarks: props.bookmarks,
    bookmarksLoading: props.bookmarksLoading,
    loadMore: props.loadMore,
    hasMore: props.hasMore,
    isLoadingMore: props.isLoadingMore,
    onDone: props.onDone,
  });
  return null;
}
