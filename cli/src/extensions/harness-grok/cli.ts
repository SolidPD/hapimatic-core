// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `catalog.harness-grok` CLI entry point (issue #3120). Resolved by the loader via
 * `manifest.entryPoints.cli()`, which invokes `register` — contributing Grok Build to the
 * catalog via `host.harness.register`.
 */
import type { CliExtensionHost, CliRegister } from "@hapi/protocol/ext";
import { capabilityManifest, driverBinding, harnessId, recipe } from "./recipe";

export const register: CliRegister = (host: CliExtensionHost): void => {
  host.harness.register(harnessId, {
    id: harnessId,
    installRecipe: recipe,
    capabilityManifest,
    driverBinding,
  });
};
