// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import { configuration } from "@/configuration";
import { runtimeAssetsKey } from "@/runtime/assetsKey";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Bun embeds compiled code in a virtual filesystem: /$bunfs/ (Linux/macOS) or /~BUN/ (Windows) */
const bunMain = globalThis.Bun?.main ?? "";
const isCompiled = bunMain.includes("$bunfs") || bunMain.includes("/~BUN/");

export function projectPath(): string {
  return resolve(__dirname, "..");
}

/** `<HAPI_HOME>/runtime` — the parent of every runtime-asset directory. */
export function runtimeAssetsBasePath(): string {
  return join(configuration.happyHomeDir, "runtime");
}

/**
 * Where the compiled binary's embedded tools are extracted:
 * `<HAPI_HOME>/runtime/<digest of the embedded assets>` (#4594, D-4594-2 A).
 * A source run uses the checkout's own cli/ directory.
 */
export function runtimePath(): string {
  if (!isCompiled) {
    return projectPath();
  }

  return join(runtimeAssetsBasePath(), runtimeAssetsKey());
}

export function isBunCompiled(): boolean {
  return isCompiled;
}
