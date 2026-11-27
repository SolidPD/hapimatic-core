// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An error's errno code (`ENOENT`, `EACCES`, `EISDIR`, …), else its class name
 * (`SyntaxError`), else its `typeof` — never its message (issue #4168, folded
 * into #4056). A `JSON.parse` message can quote file content: Bun echoes an
 * unquoted identifier in full, V8 a snippet. Files such as settings.json hold
 * tokens and keys, so a log line about one carries the path and this kind only.
 *
 * The server twin of `describeErrorKind` in `cli/src/persistence.ts` (#4155
 * R10); the server cannot import from the cli package.
 */
export function describeErrorKind(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return error instanceof Error ? error.name : typeof error;
}
