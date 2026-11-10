// SPDX-License-Identifier: AGPL-3.0-only
import { Suspense, useEffect } from "react";
import type { ChatJumpProps } from "@/components/pins/ChatJump";
import { lazyWithLoadError } from "@/lib/lazyWithPreload";

/** A jump whose chunk cannot load clears `at`, leaving the chat where it is. */
function ChatJumpLoadError(props: ChatJumpProps): null {
  const { onDone } = props;
  useEffect(() => onDone(), [onDone]);
  return null;
}

// #6453: the `?at=` jump reads a pin's record, which loads the pin schemas, so
// it lives in the Pins chunk (the PWA precache limit, vite.config.ts).
const LazyChatJump = lazyWithLoadError<ChatJumpProps>(
  () => import("@/components/pins/ChatJump"),
  ChatJumpLoadError
);

/**
 * #6453 (R11, R12): the chat's `?at=` jump (main bundle). SessionChat mounts it
 * only while the routed page passes `at`; it renders nothing.
 */
export function ChatJumpMount(props: ChatJumpProps) {
  return (
    <Suspense fallback={null}>
      <LazyChatJump {...props} />
    </Suspense>
  );
}
