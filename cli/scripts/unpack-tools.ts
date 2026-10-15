/**
 * `bun run tools:unpack`: extracts difftastic and ripgrep into cli/tools/unpacked
 * for a source checkout (the cli tests run it first). Readiness is the compiled
 * binary's own size-manifest check (#5103), so a partial extraction left by a
 * killed run is extracted again (#5125).
 *
 * Imports the extraction module relatively: it has no `@/` imports, so this script
 * never loads `@/configuration`, which creates HAPI_HOME on import.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureToolsUnpacked,
  getPlatformDir,
} from "../src/runtime/toolExtraction";

/** cli/: the root of tools/archives, tools/unpacked and .runtime-manifest.json. */
const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (import.meta.main) {
  try {
    const platformDir = getPlatformDir();
    const { alreadyUnpacked } = ensureToolsUnpacked(cliRoot, reason => {
      console.log(`Unpacking tools for ${platformDir} (${reason})...`);
    });
    if (alreadyUnpacked) {
      console.log(`Tools already unpacked for ${platformDir}`);
    } else {
      console.log(
        `Tools unpacked successfully to ${join(cliRoot, "tools", "unpacked")}`
      );
    }
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to unpack tools:", message);
    process.exit(1);
  }
}
