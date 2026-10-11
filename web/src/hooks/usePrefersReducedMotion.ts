// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from "react";

/**
 * Whether the user has asked the OS to reduce motion
 * (`prefers-reduced-motion: reduce`), read live so a change in Settings takes
 * effect without a reload (#4776). Read synchronously during render, so the
 * first commit already takes the right branch — a reduced-motion user never
 * gets a frame of animation.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function canMatchMedia(): boolean {
  return (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
  );
}

function subscribe(callback: () => void): () => void {
  if (!canMatchMedia()) return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  return canMatchMedia() && window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
