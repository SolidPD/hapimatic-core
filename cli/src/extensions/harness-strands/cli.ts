// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `catalog.harness-strands` CLI entry point (issue #5927). Resolved by the loader via
 * `manifest.entryPoints.cli()`, which invokes `register` — contributing the Strands Agents
 * CLI to the catalog via `host.harness.register`.
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
