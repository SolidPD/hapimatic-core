// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Represents the currently selected GitHub issue for a session
 */
export interface CurrentIssue {
  /** Issue number (e.g., 56) */
  number: number;
  /** Issue title */
  title: string;
  /** Full GitHub URL to the issue */
  url: string;
  /** Repository in owner/repo format (e.g., "MattStarfield/hapimatic-private") */
  repo: string;
  /** Issue state */
  state: "open" | "closed";
}

/**
 * Minimal issue data for storage (title can be refetched)
 */
export interface StoredIssue {
  number: number;
  title: string;
  repo: string;
}
