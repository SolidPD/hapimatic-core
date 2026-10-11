// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plugin API version for the Hapimatic extension system.
 *
 * This file is the canonical source for the version constant. Extension
 * manifests declare the `apiVersion` they target; downstream sub-issues (B/C/D)
 * and the loader (F) import `PLUGIN_API_VERSION` from here to check
 * compatibility.
 *
 * v0.1 is explicitly pre-stable (epic #1264): host interfaces may gain
 * contribution points additively without an API-version bump.
 */

/** The current Hapimatic plugin API version. Narrowed via `as const`. */
export const PLUGIN_API_VERSION = "0.1.0" as const;

/** Narrow literal type of {@link PLUGIN_API_VERSION} (`"0.1.0"`). */
export type PluginApiVersion = typeof PLUGIN_API_VERSION;
