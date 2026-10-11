// SPDX-License-Identifier: AGPL-3.0-only
export function safeJsonParse(value: string | null): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
