// SPDX-License-Identifier: AGPL-3.0-only
import { Suspense, type ReactElement, type ReactNode } from "react";
import { lazyWithLoadError } from "@/lib/lazyWithPreload";

type PinAnswersBodyProps = {
  text: string;
  /** What a copy from inside the message carries (#6662); defaults to `text`. */
  copyText?: string;
  fallback: ReactNode;
};

/** A compact body whose chunk cannot load stays the ordinary markdown. */
function PinAnswersBodyLoadError(props: PinAnswersBodyProps): ReactElement {
  return <>{props.fallback}</>;
}

// The parser loads Zod, so the compact body is its own chunk.
const LazyPinAnswersBody = lazyWithLoadError<PinAnswersBodyProps>(
  () => import("@/components/AssistantChat/messages/PinAnswersBody"),
  PinAnswersBodyLoadError
);

/** The fence opener `formatPinAnswersMessage` writes (#6450). */
const PIN_ANSWERS_OPENER = "```hapi_pin_answers";

/** A cheap check, before anything is parsed. */
export function looksLikePinAnswers(text: string): boolean {
  return text.includes(PIN_ANSWERS_OPENER);
}

/**
 * #6450 (R17): a sent `hapi_pin_answers` message stays compact in the chat: its
 * summary line and a collapsed "Answers (N)" disclosure, instead of a
 * full-height JSON block on a phone. Any other message renders `children` (the
 * ordinary markdown) unchanged, and so does this one until the parser loads or
 * if it cannot read the block.
 *
 * #6662: `copyText` is what a copy from inside the compact body carries, the
 * text the message's "Copy message" button copies. The markdown fallback is
 * copied natively.
 */
export function PinAnswersMessage(props: {
  text: string;
  copyText?: string;
  children: ReactNode;
}): ReactElement {
  if (!looksLikePinAnswers(props.text)) return <>{props.children}</>;
  return (
    <Suspense fallback={props.children}>
      <LazyPinAnswersBody
        text={props.text}
        copyText={props.copyText}
        fallback={props.children}
      />
    </Suspense>
  );
}
