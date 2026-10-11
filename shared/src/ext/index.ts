// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Barrel for the Hapimatic extension API (`@hapi/protocol/ext`).
 *
 * `export *` (not `export type *`) because `version.ts` and `types.ts` carry
 * runtime exports (`PLUGIN_API_VERSION`, `validateExtensionConfig`,
 * `safeValidateExtensionConfig`) alongside the type-only contribution shapes.
 */
export * from "./version";
export * from "./capabilities";
export * from "./contributions";
export * from "./hosts";
export * from "./types";
export * from "./fsManifest";
export * from "./registry";
