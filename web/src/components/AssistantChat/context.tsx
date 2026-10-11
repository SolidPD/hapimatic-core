// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { ApiClient } from "@/api/client";
import type { ChatSectionsPreference } from "@hapi/protocol/schemas";
import type { SessionMetadataSummary } from "@/types/api";
import type { UseBookmarksResult } from "@/hooks/useBookmarks";

export type HappyChatContextValue = {
  api: ApiClient;
  sessionId: string;
  metadata: SessionMetadataSummary | null;
  disabled: boolean;
  onRefresh: () => void;
  onRetryMessage?: (localId: string) => void;
  // Message bookmarks (issue #983). A SINGLE per-session useBookmarks instance
  // owned by SessionChat and threaded down here, so the message gutter icons AND
  // the SessionChat bookmark-nav overlay share one reactive source of truth
  // (two independent useBookmarks instances would NOT sync within a tab —
  // localStorage's `storage` event is cross-tab only).
  bookmarks: UseBookmarksResult;
  // Chat sections matrix (#2988, epic #2987 Sub-Issue S1). The single channel
  // every deep message renderer reads to gate presentation, per category
  // (toolRuns + reasoning): each carries visibility + a default collapse state.
  // Rendering is derived via `getChatSectionRenderHints`; the migrated defaults
  // render identically to the retired chat-verbosity enum. Sourced ONCE in
  // the HappyThread provider from the server-authoritative `useChatSectionPrefs`,
  // so a preference change re-renders an open thread live (no reload). Gating is
  // presentation-only — the ChatBlock[] stream is never filtered.
  chatSections: ChatSectionsPreference;
  // #3333: prefill the composer draft + focus it WITHOUT sending — the seam the
  // approval card's Decline action uses ("Not approved — " prefill, mobile-Safari
  // focus). Reuses SessionChat's composer set/get/focus refs. Only prefills when
  // the composer draft is empty (never clobbers an in-progress draft). Optional so
  // non-SessionChat mounts (tests, standalone) degrade to a no-op.
  prefillComposer?: (text: string) => void;
};

const HappyChatContext = createContext<HappyChatContextValue | null>(null);

export function HappyChatProvider(props: {
  value: HappyChatContextValue;
  children: ReactNode;
}) {
  return (
    <HappyChatContext.Provider value={props.value}>
      {props.children}
    </HappyChatContext.Provider>
  );
}

export function useHappyChatContext(): HappyChatContextValue {
  const ctx = useContext(HappyChatContext);
  if (!ctx) {
    throw new Error("HappyChatContext is missing");
  }
  return ctx;
}
