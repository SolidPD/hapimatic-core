// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — plugin install-execution gate (issue #2465, epic #2339
 * Sub G, Task 1 / R6).
 *
 * The porter import ({@link ../porter/importArchive.commitImport}) can optionally
 * *execute* the recorded plugin manifest on the destination —
 * `claude plugin marketplace add` + `claude plugin install` — rather than merely
 * emitting the manual remediation #2343 already produces. Executing third-party
 * marketplace installs is the porter's only network-install-execution surface
 * (arbitrary third-party code with the instance user's privileges), so it ships
 * **gated OFF** and is the last dimension to be enabled.
 *
 * Default **OFF** (KD-5, mirroring the OmniBox sandbox posture, #1734
 * `cli/src/configuration.ts` `omniboxSandboxEnabled`): flip ON only after the
 * #2345 validation pass. When OFF, behavior is **byte-identical to #2343 alone**
 * — the plugin remediation command list is emitted and NOTHING is installed
 * (the `pluginInstall` field is ABSENT from the `ImportResult`, per expert-review
 * ruling D-2). Truthy-enable, NOT inverted: an absent/blank env keeps the gate
 * OFF so existing imports are unaffected until it is explicitly set.
 *
 * The gate lives in a dedicated server config module (NOT `cli/src/configuration.ts`
 * — the import runs server-side; and NOT `server/src/config/settings.ts`, which is
 * the settings.json persistence layer with zero env parsing). The truthy-enable
 * idiom mirrors `server/src/index.ts:399-400` (`HAPI_FS_EXTENSIONS`) and
 * `server/src/config/contextWatermarkConfig.ts` — the established server-side
 * `["true","1","yes"].includes(...)` pattern, read at call time.
 */

/** The env var that opts INTO plugin install execution. Default OFF when unset. */
export const PORTER_PLUGIN_INSTALL_ENV = "HAPI_PORTER_PLUGIN_INSTALL" as const;

/**
 * True when plugin install execution is explicitly enabled via
 * {@link PORTER_PLUGIN_INSTALL_ENV}. Truthy values are `1` / `true` / `yes`
 * (case-insensitive); ANY other value (including unset, empty, `0`, `false`,
 * `no`, or an unrecognized string) resolves to `false` — the default-OFF posture.
 *
 * Read at call time (not memoized) so a test or an operator flip takes effect
 * without a module reload, matching the `index.ts` `HAPI_FS_EXTENSIONS` idiom.
 */
export function porterPluginInstallEnabled(): boolean {
  return ["true", "1", "yes"].includes(
    process.env[PORTER_PLUGIN_INSTALL_ENV]?.toLowerCase() ?? ""
  );
}
