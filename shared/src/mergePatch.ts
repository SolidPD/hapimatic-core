// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RFC 7396 JSON Merge Patch (#6526). A patch names only what changes: a member
 * set to `null` is removed, a member that is an object merges into the
 * target's member of the same name, and any other member replaces it. A
 * target field the patch does not name is kept, which is what lets a node edit
 * a federation setting without dropping a field it cannot read (the server
 * applies the patch to the stored raw value, `settingsSyncService.applyPatch`).
 *
 * The browser uses the same function to show a queued edit before the server
 * confirms it (`useFederationSettings.mergeValue`), so the shown value and the
 * stored value are computed the same way.
 *
 * Pure: no I/O, and neither argument is mutated. One deliberate departure from
 * the RFC: a patch member named `__proto__` is skipped, because assigning it
 * would change the result's prototype instead of setting a field.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Apply `patch` to `target` (RFC 7396 §2) and return the result. */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = isPlainObject(target)
    ? { ...target }
    : {};
  for (const [name, value] of Object.entries(patch)) {
    if (name === "__proto__") continue;
    if (value === null) delete result[name];
    else result[name] = applyMergePatch(result[name], value);
  }
  return result;
}
