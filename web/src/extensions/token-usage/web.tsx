// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web entry point for `builtin.token-usage` (issue #1285, Sub-Issue U of epic
 * #1264). Resolved lazily by the loader via `manifest.entryPoints.web()` and
 * invoked once during `loadWebExtensions` (`web/src/ext/loader.ts`), BEFORE
 * `bootstrap()` — so the host is fully populated before `<SessionChat />` reads
 * `getSessionDetailInfoFields()` to decide whether to render the info bar.
 *
 * This is the FIRST consumer of `host.sessionDetail.addInfoField`. Sub-Issue C
 * (#1267) shipped the slot renderer `<SessionDetailInfoFields />` unmounted and
 * explicitly deferred the mount decision to Sub-Issues T/U; this issue makes
 * the call and mounts it in `SessionChat.tsx` between the session header and
 * the message thread.
 */
import type { WebRegister } from "@hapi/protocol/ext";
import { TokenUsageField } from "./TokenUsageField";

/**
 * Registers the compact token-usage indicator in the session-detail info-field
 * slot. Exactly one `addInfoField` call (R4).
 *
 * `order: 100` leaves deliberate room on both sides: below 100 for
 * higher-priority indicators, above 100 for later additions — sibling demo
 * #1284 (`builtin.session-notes`) is expected to take `order: 200`. If two
 * fields ever collide on the same order value, the host's sort is a stable
 * deterministic id-tiebreak, so the ordering stays reproducible either way.
 *
 * `TokenUsageField` is imported directly rather than via `React.lazy`: the
 * component is a few hundred bytes of formatting logic over hooks the host page
 * already loads, so a separate chunk would cost a request without saving
 * meaningful bytes. The slot renderer wraps every field in `<Suspense>`
 * regardless, so switching to a lazy import later needs no host change.
 */
export const register: WebRegister = host => {
  host.sessionDetail.addInfoField({
    id: "builtin.token-usage",
    label: "Token usage",
    order: 100,
    render: TokenUsageField,
  });
};
