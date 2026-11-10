// SPDX-License-Identifier: AGPL-3.0-only

/**
 * #6454: the note a Disconnect confirm adds when the session has open pins.
 * Nothing at zero or unknown (`openPinCount` is absent while the Pins gate is
 * closed or the session's node is older: unknown, not zero). The count can
 * include mirrored `prompt:` pins, which close when the session stops; they do
 * wait on the operator while the dialog is open, so the count is honest, and
 * the promise is scoped to "the pins it asked".
 */
export function openPinsArchiveNote(
  count: number | null | undefined,
  options: { several?: boolean } = {}
): string {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
    return "";
  }
  const pins = `${count} open ${count === 1 ? "pin" : "pins"}`;
  return options.several
    ? `They have ${pins} waiting on you. Answers to the pins they asked can still be sent: Submit offers to resume a session, or to send them to its Project Manager when one runs on this node`
    : `It has ${pins} waiting on you. Answers to the pins it asked can still be sent: Submit offers to resume it, or to send them to its Project Manager when one runs on this node`;
}

/** The open pins across `sessions`; undefined when none of them knows its count. */
export function sumOpenPins(
  sessions: readonly { openPinCount?: number | null }[]
): number | undefined {
  let known = false;
  let total = 0;
  for (const session of sessions) {
    if (typeof session.openPinCount === "number") {
      known = true;
      total += session.openPinCount;
    }
  }
  return known ? total : undefined;
}

/** A confirm's description with the note appended, when there is one. */
export function withOpenPinsNote(description: string, note: string): string {
  return note ? `${description} ${note}` : description;
}
