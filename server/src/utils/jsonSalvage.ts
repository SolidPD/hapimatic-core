// SPDX-License-Identifier: AGPL-3.0-only

// Shared JSON salvage for context columns that must always hold valid JSON:
// `notification.context` (issue #5696) and `error_logs.context` (issue #5734).

/** The marker a salvaged context carries when its source did not serialize. */
export const SERIALIZATION_ERROR_KEY = "contextSerializationError";

/** `JSON.stringify(value)`, or `null` when it throws or yields no string. */
export function stringifyOrNull(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

/**
 * The fields whose own values serialize; a BigInt or circular field is dropped.
 * Never throws: an object whose keys cannot be listed yields no fields.
 */
export function salvageFields(
  context: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(context);
  } catch {
    return out;
  }
  for (const key of keys) {
    try {
      const value = context[key];
      if (stringifyOrNull(value) !== null) out[key] = value;
    } catch {
      // A throwing getter is a field that does not serialize.
    }
  }
  return out;
}

/**
 * `JSON.stringify(context)` when it serializes. Otherwise the fields that do,
 * plus `contextSerializationError: true`. Never throws and never caps length:
 * an object whose keys cannot even be listed yields the marker alone.
 */
export function serializeOrSalvage(context: Record<string, unknown>): string {
  const serialized = stringifyOrNull(context);
  if (serialized !== null) return serialized;
  try {
    return JSON.stringify({
      ...salvageFields(context),
      [SERIALIZATION_ERROR_KEY]: true,
    });
  } catch {
    return JSON.stringify({ [SERIALIZATION_ERROR_KEY]: true });
  }
}
