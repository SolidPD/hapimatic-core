// SPDX-License-Identifier: AGPL-3.0-only

// ─── Web Desktop Proxy Protocol ─────────────────────────────
//
// Close codes the per-VM desktop proxy (server/src/web/desktopProxy.ts) sends on
// the browser's raw WebSocket at /api/sessions/:id/desktop, read by the web
// viewer (web/src/components/DesktopView.tsx). 4000–4999 is the application
// range (RFC 6455 §7.4.2).

/**
 * The desktop stack could not be started: `systemctl start` failed, the unit
 * stopped being active while the proxy waited for it, or it never began
 * accepting connections before the readiness deadline (#6214). The close reason
 * is `desktop_start_failed` or `desktop_start_timeout`.
 */
export const DESKTOP_CLOSE_START_FAILED = 4001;
