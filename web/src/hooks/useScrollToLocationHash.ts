// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { useLocation } from "@tanstack/react-router";

/**
 * Scroll the element whose `id` matches the current URL hash into view.
 *
 * Used by the Settings pages that host folded-in sections (Preferences, Keys):
 * the sidebar's nested rows navigate with `navigate({ to, hash })`, and the
 * target page calls this hook so the anchored section scrolls into view on
 * mount AND when the hash changes while the page is already mounted (tapping a
 * different sub-row of the same parent).
 *
 * `scrollIntoView` resolves against the nearest scrollable ancestor, so this
 * works inside the pages' own `overflow-y-auto` containers without any ref
 * plumbing. A hash with no matching element is a silent no-op.
 *
 * The scroll re-fires over a short settle window because async-loaded content
 * ABOVE the anchor (query results resolving after mount) reflows the page and
 * undoes the first scroll — verified on /settings/keys#backup-key, where the
 * API-key list resolving stranded the anchor back at the top.
 */
export function useScrollToLocationHash(): void {
  const hash = useLocation({ select: l => l.hash });

  useEffect(() => {
    if (typeof hash !== "string" || hash === "") return;
    const scroll = () =>
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    scroll();
    const timers = [150, 400, 800].map(ms => window.setTimeout(scroll, ms));
    return () => timers.forEach(t => window.clearTimeout(t));
  }, [hash]);
}
