#!/usr/bin/env bun
/**
 * Generates version info from package.json to be embedded in the compiled binary.
 * Run this before building the executable.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function generateVersionInfo(): void {
  const rootDir = join(import.meta.dir, "..", "..");
  const packageJsonPath = join(rootDir, "package.json");
  const outputPath = join(import.meta.dir, "..", "src", "version.generated.ts");

  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

  const version = pkg.version || "unknown";
  const timestamp = pkg.versionTimestamp || new Date().toISOString();

  const content = `// AUTO-GENERATED - DO NOT EDIT
// Generated at build time from package.json

export const VERSION = '${version}'
export const VERSION_TIMESTAMP = '${timestamp}'
`;

  writeFileSync(outputPath, content);
  console.log(
    `[version-info] Generated version.generated.ts: v${version} (${timestamp})`
  );
}

if (import.meta.main) {
  generateVersionInfo();
}
