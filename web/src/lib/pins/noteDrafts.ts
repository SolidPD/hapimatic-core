// SPDX-License-Identifier: AGPL-3.0-only
import { flushStaging } from "@/lib/pins/staging";

/**
 * #6768: the words still in open note fields. A note field stages its text
 * about 300 ms after typing stops, on blur, and when a composition ends, so a
 * keystroke never re-renders every copy of the pin. Words typed inside a
 * composition that has not ended are staged by none of those, so every mounted
 * field also registers here: the Submit dialog flushes them before it reads
 * staging (R2), and a hidden page flushes them and writes staging to storage
 * (R4), because iOS can close a backgrounded PWA without unmounting it.
 *
 * React-free and Zod-free, like `staging.ts`: the chat's Submit strip pulls it
 * into the main bundle.
 */

const flushers = new Set<() => void>();
let lifecycleInstalled = false;

/** Add a field's flush; the returned function removes it. */
export function registerNoteDraft(flush: () => void): () => void {
  installNoteDraftLifecycle();
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

/**
 * Stage what every open note field holds. A field that throws does not keep
 * the others' words from staging; its error is thrown once they are done.
 */
export function flushNoteDrafts(): void {
  let failure: { error: unknown } | null = null;
  // A copy: a flush may close its field, which unregisters it.
  for (const flush of [...flushers]) {
    try {
      flush();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

function onPageHidden(): void {
  try {
    flushNoteDrafts();
  } finally {
    // Staging's own page-hide listener may have run first; this writes the
    // notes just staged.
    flushStaging();
  }
}

/** Once per page: flush on `pagehide` and on a `visibilitychange` to hidden. */
export function installNoteDraftLifecycle(): void {
  if (lifecycleInstalled || typeof window === "undefined") return;
  lifecycleInstalled = true;
  window.addEventListener("pagehide", onPageHidden);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onPageHidden();
  });
}

/** Test-only: forget every registered field (the page listeners stay). */
export function __resetNoteDrafts(): void {
  flushers.clear();
}
