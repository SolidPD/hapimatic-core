// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { cn } from "@/lib/utils";
import { githubAvatarUrl } from "@/lib/githubConnections";

/**
 * A linked GitHub account's avatar (issue #4793, D-4793-8): GitHub's public `<login>.png`, the
 * picture the user sees on GitHub itself, so a row is recognisable before its @login is read.
 *
 * It needs no token and no backend field. The image loads from github.com with no referrer, so
 * GitHub learns an avatar was viewed but not from which instance. When it cannot load (offline,
 * blocked, unknown login) the initials of the login stand in, on the same circle, so the row
 * keeps its shape.
 */
export function GitHubAccountAvatar(props: {
  login: string;
  /** Diameter in px: 40 in Settings, 32 in the Create page picker. */
  size?: 32 | 40;
  className?: string;
}) {
  const { login, size = 40, className } = props;
  const [failed, setFailed] = useState(false);
  const box = size === 32 ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm";
  if (failed) {
    return (
      <span
        aria-hidden="true"
        data-testid="github-avatar-initials"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--app-subtle-bg)] font-semibold text-[var(--app-fg)]",
          box,
          className
        )}
      >
        {initialsOf(login)}
      </span>
    );
  }
  return (
    <img
      src={githubAvatarUrl(login, size * 2)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn(
        "shrink-0 rounded-full bg-[var(--app-subtle-bg)]",
        box,
        className
      )}
    />
  );
}

/** Two letters from a login: the first letters of its first two parts, else its first two. */
export function initialsOf(login: string): string {
  const parts = login.split(/[-_.]+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? parts[0][0] + parts[1][0] : login.slice(0, 2);
  return letters.toUpperCase();
}
