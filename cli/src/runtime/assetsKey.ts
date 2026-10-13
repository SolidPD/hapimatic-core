// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The key of the compiled binary's runtime-asset directory,
 * `<HAPI_HOME>/runtime/<key>` (issue #4594, D-4594-2 A).
 *
 * The key is a digest of the embedded assets the binary carries (the difftastic
 * and ripgrep archives plus their LICENSE files), computed by
 * cli/scripts/build-executable.ts and inlined with `bun build --define`. A release
 * that does not change the embedded tools therefore reuses the existing directory
 * (they have not changed since 2025-12-16, and one directory is ~173 MB), and a
 * release that does change them extracts a fresh one.
 */
import { createHash } from "node:crypto";
import { CLI_VERSION } from "../version";

/** Inlined by `bun build --define` (build-executable.ts); undeclared in source runs. */
declare const HAPI_RUNTIME_ASSETS_KEY: string | undefined;

/**
 * Hashed ahead of the files. Change it when the extracted layout changes, so a
 * build with a new layout never reuses a directory extracted by an older one.
 */
export const RUNTIME_ASSETS_LAYOUT = "hapi-runtime-assets-v1";

/** A build-time key: the first 12 hex digits of the digest. */
export const RUNTIME_ASSETS_KEY_PATTERN = /^[0-9a-f]{12}$/;

/**
 * The files embeddedAssets.bun.ts embeds for one target, as relative paths under
 * cli/ (= their paths inside the runtime directory). assetsKey.test.ts pins this
 * list to embeddedAssets.bun.ts, so the two cannot drift apart.
 */
export function runtimeAssetPaths(platformDir: string): string[] {
  return [
    "tools/archives/difftastic-LICENSE",
    "tools/archives/ripgrep-LICENSE",
    "tools/licenses/difftastic-LICENSE",
    "tools/licenses/ripgrep-LICENSE",
    `tools/archives/difftastic-${platformDir}.tar.gz`,
    `tools/archives/ripgrep-${platformDir}.tar.gz`,
  ];
}

/** The build-time key over the embedded files (order-independent). */
export function computeRuntimeAssetsKey(
  files: ReadonlyArray<{ relativePath: string; content: Uint8Array }>
): string {
  const hash = createHash("sha256");
  hash.update(RUNTIME_ASSETS_LAYOUT);
  const sorted = [...files].sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0
  );
  for (const file of sorted) {
    hash.update(`\0${file.relativePath}\0${file.content.length}\0`);
    hash.update(file.content);
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * The defined key when the build supplied a valid one; otherwise `v<version>`,
 * for a compiled build made without the define (correct, only churnier: one
 * directory per release, which pruning keeps bounded).
 */
export function resolveRuntimeAssetsKey(
  definedKey: unknown,
  cliVersion: string
): string {
  if (
    typeof definedKey === "string" &&
    RUNTIME_ASSETS_KEY_PATTERN.test(definedKey)
  ) {
    return definedKey;
  }
  return `v${cliVersion.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** This binary's runtime-asset directory key. */
export function runtimeAssetsKey(): string {
  return resolveRuntimeAssetsKey(
    typeof HAPI_RUNTIME_ASSETS_KEY === "string"
      ? HAPI_RUNTIME_ASSETS_KEY
      : undefined,
    CLI_VERSION
  );
}
