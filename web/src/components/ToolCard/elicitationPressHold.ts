// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The hold on the other MCP elicitation cards (#6606 round 5).
 *
 * When an answered card leaves a chat that sits at its end, the content above
 * it slides down by the card's height, and the second tap of a double tap
 * lands on whatever slid under the finger: another card's Decline, a box, Yes
 * or No, a select, a label's tap (the round-4 tester's double tap). So for a
 * short time after a card's answer lands, a press inside any OTHER card's
 * footer is ignored, and the time starts again when the answered card leaves.
 * A card that leaves while its answer is still in flight starts the hold when
 * it leaves (round 6: the server can take the answer before this page sees
 * the reply), and starts it again when the reply lands. A card leaving after
 * this page sent an answer for it holds the others whatever the reply was,
 * because a reply can fail although the server took the answer (round 7).
 * That is so even when another card's leave replaced its footer in between,
 * because the cards this page sent an answer for are kept here, by request
 * id, not in a footer (round 8).
 *
 * The hold is kept per card (round 8): a card is held while any OTHER card's
 * hold runs, never by its own, and one card's hold never ends or replaces
 * another's. A card's leave can tear another card's footer down and mount it
 * again in the same commit (why is not known). The leaving card's hold, which
 * exists only when this page sent an answer for the leaving card, then holds
 * the replaced card too; and when this page sent an answer for the replaced
 * card, its footer's going holds the others as well. The tool card's title
 * row is outside the footer, so a tap there still opens that card's read-only
 * "Full details" dialog (a named limit). An approval card (`PermissionFooter`:
 * a server's field-less confirm, a Codex command or patch) is held too, but
 * its own answer and leave start no hold (round 9, F1).
 *
 * It is timed from the answer landing and from the card's footer going (its
 * leave, or a remount another card's leave causes), never from the press: it
 * runs half a second from each, so the slide can come before the reply or
 * after it and the hold follows it either way. When the landing and the leave
 * come within half a second of each other it ends half a second after the
 * later; when they are further apart it is two half-second windows, and a
 * press between them is taken. A failed answer adds no hold of its own, and
 * while its card stays the card can be answered again; its footer's going
 * still holds the others (its leave, or such a remount). The clock is
 * `performance.now()`, which a wall-clock step cannot move. Each event of a
 * press is checked at its own time, so a press held from inside the hold to
 * after it acts on its release (a named limit).
 */

import type { SyntheticEvent } from "react";

/**
 * How long a press on another card is ignored, in ms. The tester's answer
 * landed about 20 ms after the first tap and the second taps came 60, 150 and
 * 300 ms after it, so up to about 280 ms after the answer; half a second
 * covers that with room for a slower double tap (500 ms is a common desktop
 * double-click time), and is still shorter than it takes to see the chat move
 * and choose another card on purpose.
 */
export const OTHER_CARD_HOLD_MS = 500;

/** When each card's hold started, by request id (round 8: one per card). */
const holds = new Map<string, number>();

function dropEndedHolds(now: number): void {
  for (const [requestId, at] of holds) {
    if (now - at >= OTHER_CARD_HOLD_MS) holds.delete(requestId);
  }
}

/** The card with this request id was answered, or has just left: hold the others. */
export function holdOtherCards(requestId: string): void {
  const now = performance.now();
  dropEndedHolds(now);
  holds.set(requestId, now);
}

/** Whether a press on the card with this request id is to be ignored now. */
export function otherCardHeld(requestId: string): boolean {
  dropEndedHolds(performance.now());
  for (const holder of holds.keys()) {
    if (holder !== requestId) return true;
  }
  return false;
}

/**
 * The capture handlers for the root of a card's footer: while another card
 * holds the card with this request id, a press's down, a touch's end (iOS
 * opens a select from it) and the click are cancelled, so the press never
 * reaches a control. An elicitation card's footer spreads them, and so does
 * an approval card's (`PermissionFooter`, round 9, F1): an approval card
 * honours a hold that another card started, though nothing it does starts
 * one.
 */
export function heldPressProps(requestId: string) {
  const ignore = (event: SyntheticEvent): void => {
    if (!otherCardHeld(requestId)) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  };
  return {
    onPointerDownCapture: ignore,
    onMouseDownCapture: ignore,
    onTouchEndCapture: ignore,
    onClickCapture: ignore,
  };
}

/**
 * The cards this page has sent an answer for, by request id, kept here and not
 * in a footer, because another card's leave can replace a footer (round 8,
 * F3); and how many footers are drawn for each card.
 */
const answeredHere = new Set<string>();
const footersDrawn = new Map<string, number>();

/** This page sent an answer for the card with this request id. */
export function cardAnswerSent(requestId: string): void {
  answeredHere.add(requestId);
}

/** A footer for the card with this request id was drawn. */
export function cardFooterDrawn(requestId: string): void {
  footersDrawn.set(requestId, (footersDrawn.get(requestId) ?? 0) + 1);
}

/**
 * A footer for the card with this request id is gone. If this page sent an
 * answer for the card, the others are held; once the commit is over, the card
 * is forgotten unless a footer for it was drawn again.
 */
export function cardFooterGone(requestId: string): void {
  const drawn = (footersDrawn.get(requestId) ?? 1) - 1;
  if (drawn > 0) footersDrawn.set(requestId, drawn);
  else footersDrawn.delete(requestId);
  queueMicrotask(() => {
    if (!footersDrawn.has(requestId)) kept.delete(requestId);
  });
  if (!answeredHere.has(requestId)) return;
  holdOtherCards(requestId);
  queueMicrotask(() => {
    if (!footersDrawn.has(requestId)) answeredHere.delete(requestId);
  });
}

/**
 * What a card holds while it is drawn, by request id (round 9, F2 and F6):
 * the values typed, the fields touched, the error of its last answer that
 * failed, and the answer this page has in flight or landed (D6). A footer
 * that another card's leave replaced starts from it: it is disabled while
 * that answer is in flight and after it landed, so a second tap on it sends
 * nothing; and when the old footer's answer fails after the replacement, its
 * buttons come back and its error shows on the new footer. It is kept only
 * while a footer for the card is drawn, and forgotten with the card: once no
 * footer for it is drawn when the commit is over, or on a release.
 */
export type KeptCard = {
  values?: Record<string, string[]>;
  touched?: ReadonlySet<string>;
  error?: string | null;
  sending?: "approve" | "decline" | null;
};
const kept = new Map<string, KeptCard>();
const keptWatchers = new Map<string, Set<() => void>>();
const NOTHING_KEPT: KeptCard = {};

/** What is kept for the card with this request id. */
export function keptCard(requestId: string): KeptCard {
  return kept.get(requestId) ?? NOTHING_KEPT;
}

/** Keeps a change for the card while a footer for it is drawn, and tells its footers. */
export function keepCard(requestId: string, change: KeptCard): void {
  if (!footersDrawn.has(requestId)) return;
  kept.set(requestId, { ...kept.get(requestId), ...change });
  for (const watcher of keptWatchers.get(requestId) ?? []) watcher();
}

/** Calls `watcher` on each change kept for the card; returns the unsubscribe. */
export function watchKeptCard(
  requestId: string,
  watcher: () => void
): () => void {
  const watchers = keptWatchers.get(requestId) ?? new Set<() => void>();
  keptWatchers.set(requestId, watchers);
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
    if (watchers.size === 0) keptWatchers.delete(requestId);
  };
}

/** The request ids something is kept or watched for (test-only). */
export function keptCardIds(): string[] {
  return [...new Set([...kept.keys(), ...keptWatchers.keys()])];
}

/** Ends every hold and forgets every card (each test starts with none). */
export function releaseOtherCardHold(): void {
  holds.clear();
  answeredHere.clear();
  kept.clear();
}
