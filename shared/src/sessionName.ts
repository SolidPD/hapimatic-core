// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session name validation for tmux compatibility
 *
 * Tmux window names have specific restrictions:
 * - Cannot contain colons (:) - used as delimiter in tmux target syntax
 * - Cannot start with a period (.) - reserved for hidden windows
 * - Cannot contain control characters (ASCII 0-31)
 * - Should be reasonably short (we limit to 100 chars for safety)
 */

import { z } from "zod";

export const SESSION_NAME_MAX_LENGTH = 100;

/**
 * Validates a session name for tmux compatibility.
 * Returns null if valid, or an error message if invalid.
 */
export function validateSessionName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return "Session name cannot be empty";
  }

  const trimmed = name.trim();

  if (trimmed.length > SESSION_NAME_MAX_LENGTH) {
    return `Session name must be ${SESSION_NAME_MAX_LENGTH} characters or less`;
  }

  if (trimmed.startsWith(".")) {
    return "Session name cannot start with a period";
  }

  if (trimmed.includes(":")) {
    return "Session name cannot contain colons (:)";
  }

  // Check for control characters (ASCII 0-31)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F]/.test(trimmed)) {
    return "Session name cannot contain control characters";
  }

  return null;
}

/**
 * Sanitizes a session name for tmux compatibility.
 * Removes or replaces invalid characters.
 */
export function sanitizeSessionName(name: string): string {
  let sanitized = name.trim();

  // Remove control characters
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x1F]/g, "");

  // Replace colons with dashes
  sanitized = sanitized.replace(/:/g, "-");

  // Remove leading periods
  while (sanitized.startsWith(".")) {
    sanitized = sanitized.slice(1);
  }

  // Truncate to max length
  if (sanitized.length > SESSION_NAME_MAX_LENGTH) {
    sanitized = sanitized.slice(0, SESSION_NAME_MAX_LENGTH);
  }

  return sanitized;
}

/**
 * Checks if a session name is valid for tmux.
 */
export function isValidSessionName(name: string): boolean {
  return validateSessionName(name) === null;
}

/**
 * Zod schema composing length + character validation for session names.
 * Server routes use this instead of re-declaring `z.string().min(1).max(255)`,
 * ensuring server-side validation matches the shared `validateSessionName()`
 * rules — including the specific error messages (issue #817).
 */
export const sessionNameSchema = z.string().superRefine((value, ctx) => {
  const error = validateSessionName(value);
  if (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  }
});

/**
 * Optional variant for spawn endpoints where the session name is optional
 * (defaults to the session ID when omitted).
 */
export const optionalSessionNameSchema = sessionNameSchema.optional();
