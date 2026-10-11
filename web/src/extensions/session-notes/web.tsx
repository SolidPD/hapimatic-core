// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web entry point for `builtin.session-notes` (issue #1284, Sub-Issue T of epic
 * #1264).
 *
 * Unlike every web extension shipped so far, this one contributes REAL SLOTS
 * rather than no-op registering around a static import. `builtin.error-log-viewer`
 * (#1279) and `builtin.git-rpc` (#1281) both register nothing because their UI is
 * a TanStack *route*, and TanStack infers valid paths from a static route tree at
 * module-eval — a dynamically-added route would leave the typed tree.
 *
 * Session-detail contributions have no such constraint: `SessionDetailTabs` and
 * `SessionDetailInfoFields` (`web/src/ext/slots.tsx`) read the host at RENDER
 * time, so a contribution registered during loader startup is picked up
 * naturally. This file is therefore the first real exercise of the v0.1 slot
 * system end-to-end.
 *
 * ## Why `React.lazy`
 *
 * Both components pull in TanStack Query hooks and the markdown renderer. Wrapping
 * them in `lazy()` keeps that out of the initial bundle — the chunk is fetched only
 * when a session detail view actually renders the slot. Both slot hosts already
 * wrap their render in `<Suspense fallback={null}>`, so no extra boundary is needed
 * here.
 */
import { lazy } from "react";
import type { WebRegister } from "@hapi/protocol/ext";

const NotesTab = lazy(() => import("./NotesTab"));
const NotesIndicator = lazy(() => import("./NotesIndicator"));

export const register: WebRegister = host => {
  host.sessionDetail.addTab({
    id: "builtin.session-notes.tab",
    label: "Notes",
    order: 100,
    render: NotesTab,
  });

  host.sessionDetail.addInfoField({
    id: "builtin.session-notes.indicator",
    label: "Notes",
    order: 100,
    render: NotesIndicator,
  });
};
