// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionOfflineBar — the slim muted-red offline notice (issue #3272; operator
 * ruling 2026-08-25). Replaces the old grey `p-3` bubble at the top of the chat
 * transcript. Sized to the VM-update bar (`UpdateAvailableBadge`: `px-3 py-1
 * text-xs`) so the two system bars share one height, colored with the existing
 * error badge tokens (muted red — never a hardcoded color).
 *
 * Placement is the consumer's job: directly below the Session Details section
 * when expanded, or directly below the Session Basic Info Bar when collapsed —
 * both live inside `SessionHeader`, so "immediately after the header" satisfies
 * the ruling by construction. The view pages (Files / Terminal / Desktop / PTY)
 * reuse it with their own copy.
 */
export function SessionOfflineBar(props: { message?: string }) {
  const message =
    props.message ?? "Session is offline. Messages will be queued.";
  return (
    <div
      role="status"
      data-testid="session-offline-bar"
      className="mx-auto w-full max-w-content bg-[var(--app-badge-error-bg)] px-3 py-1 text-center text-xs font-semibold text-[var(--app-badge-error-text)]"
    >
      {message}
    </div>
  );
}
