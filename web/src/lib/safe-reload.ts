// SPDX-License-Identifier: AGPL-3.0-only
import { errorReporter } from "./error-reporter";

/**
 * Visibility-guarded page reload — the SINGLE choke point every programmatic
 * reload routes through (issue #1793, R2).
 *
 * Why this exists: on iOS a backgrounded/frozen PWA tab that reloads around the
 * resume boundary lands on the bare `#1E0A3E` shell — the HTML/PWA canvas with
 * no React tree re-mounted. Deferring every programmatic reload until the
 * document is foreground-stable removes that blank-shell class entirely: a
 * reload that would have fired while hidden is held until the next
 * `visibilitychange` → `visible`.
 *
 * If the document is already visible, it reloads immediately. Otherwise it arms
 * a one-shot `visibilitychange` listener. Idempotent: a second call while a
 * deferred reload is already armed is a no-op, so two reload requests before
 * foreground collapse into a single reload (no stacked listeners / double
 * reload).
 *
 * @param reason short cause string (e.g. "sw-update", "chunk-load") — recorded
 *   with the reload telemetry (R5b) and useful when reading `page-reload` rows.
 */
let armed = false;

export function reloadWhenVisible(reason: string): void {
  const doReload = () => {
    // R5(b): record every programmatic reload with its reason — via the
    // DURABLE pre-reload path: report()'s 2s debounce dies with the page, so
    // a plain report() here was always lost. reportBeforeReload() persists to
    // the localStorage outbox synchronously; the post-reload bootstrap drain
    // delivers it (originalTimestamp = now). No-ops before React mounts
    // (errorReporter uninitialized) — the bootstrap-independent beacon in
    // index.html (Task 6) covers the pre-mount blank-shell case.
    errorReporter.reportBeforeReload({
      message: `Programmatic reload: ${reason}`,
      category: "page-reload",
      severity: "info",
      context: reason,
    });
    window.location.reload();
  };

  if (document.visibilityState === "visible") {
    doReload();
    return;
  }

  // Hidden: defer. Guard against double-arming so concurrent callers (e.g. an
  // SW update and a chunk-load in the same hidden window) yield ONE reload.
  if (armed) return;
  armed = true;

  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onVisible);
    armed = false;
    doReload();
  };
  document.addEventListener("visibilitychange", onVisible);
}
