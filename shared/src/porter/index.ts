// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Barrel for the Configuration Porter manifest schema
 * (`@hapi/protocol/porter`, epic #2339, issue #2340).
 *
 * `export *` (not `export type *`) because every module carries RUNTIME exports —
 * `version.ts` exports the version/format constants, `manifest.ts` exports the
 * Zod schemas, the `parsePorterManifest` validator, and the pure helpers
 * (`collectSecretFieldNames`, `toSettingsHooksBlock`, `normalizeHookCommand`, …)
 * alongside their inferred types, and `extractionPrompt.ts` exports the
 * `buildExtractionPrompt` generator (#2342) plus its recipient guard and the
 * `SECRET_HANDLING_PROHIBITION` marker. `exportNaming.ts` exports the export-dir
 * + archive-naming surface (#3239) — the constants and `sh`-fragment builder the
 * prompt's Step 11 interpolates and #3245's `buildExportScript` reuses.
 */
export * from "./version";
// #3448 (Sub C, K7): the multi-source discovery table (source ids, labels,
// dedupe precedence, candidate config paths, `SourceRecordSchema`). Exported
// BEFORE `./manifest` so a reader of the barrel meets the source table first;
// `manifest.ts` imports the id set + record schema from it (no cycle — this
// module imports only `zod`).
export * from "./sources";
export * from "./manifest";
export * from "./exportNaming";
export * from "./extractionPrompt";
export * from "./exportShared";
// #4173: the rule for the top-level script an executable setting runs (shared
// by the exporters, the prompt's Step 11 block, the importer and the review).
export * from "./settingsScripts";
// #4188: the one bash symbolic-link walk the include loop and the
// settings-script lines both call.
export * from "./linkWalkShell";
// #4164: the bash CLAUDE.md include loop the bash exporter and the extraction
// prompt's Step 11 check block both run.
export * from "./claudeMdIncludeShell";
// #4173: the bash settings-script lines the bash exporter and the Step 11
// block both run.
export * from "./settingsScriptShell";
// #4172: the credential-name prune the bash exporter and the prompt's Step 11
// block both run.
export * from "./credentialNamesShell";
export * from "./exportScript";
// #3447 (Sub B, K7): the PowerShell twin emitter + the hoisted cross-emitter
// constants. `exportScriptPowerShell` re-exports ONLY `buildExportScriptPowerShell`
// (it imports `ExportScriptInput`/`SECRETS_MEMBER_*` as types, never re-exports
// them), so `export *` here does not collide with `./exportScript` (TS2308).
export * from "./exportScriptPowerShell";
export * from "./token";
// #4533: the exposure-gate wire contract (`porter_withheld` code + status shape).
export * from "./exposure";
