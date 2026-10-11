// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Spawn Status Badge (issue #1565, Option B)
 *
 * Renders the server-authoritative spawn lifecycle of a session — "Spawning…"
 * (an early-return placeholder created by the local spawn route, before the
 * real session reports in) and "Spawn Failed" (a background spawn failure
 * surfaced via lifecycleState="failed"; the error is carried in the session's
 * summary text). The terminal "running" state renders nothing — it's a normal
 * live session. This is the WEB read-side of the uniform lifecycleState that the
 * CLI also polls (the read side did not exist before #1565).
 */

interface SpawnStatusBadgeProps {
  lifecycleState: string | undefined;
  className?: string;
}

export function SpawnStatusBadge({
  lifecycleState,
  className = "",
}: SpawnStatusBadgeProps) {
  if (lifecycleState === "spawning") {
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-md bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)] ${className}`}
      >
        <SpawningSpinner />
        Spawning…
      </span>
    );
  }

  if (lifecycleState === "failed") {
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-md bg-[var(--app-badge-error-bg)] text-[var(--app-badge-error-text)] ${className}`}
      >
        <WarningIcon />
        Spawn Failed
      </span>
    );
  }

  return null;
}

function SpawningSpinner() {
  return (
    <svg
      className="animate-spin h-3 w-3"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-3 w-3"
    >
      <path
        fillRule="evenodd"
        d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}
