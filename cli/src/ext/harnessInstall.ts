// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Catalog-recipe install execution (issue #3120, Task 4). The generic, data-driven engine
 * behind `hapi ext <install|version|uninstall>` for a catalog CLI harness:
 *
 *   - INSTALL is data-driven on `method`/`spec` with SCHEMA-BACKED integrity (ruling 1B-17):
 *     npm installs pass `--ignore-scripts` (postinstall is the live supply-chain exposure);
 *     a `curl` artifact is verify-after-fetch against the recipe's `sha256` (a mismatch aborts
 *     loudly — nothing is placed, V7).
 *   - VERSION delegates to the recipe's `versionProbe` closure, which routes through the
 *     {@link HarnessUpdateRegistry} port (R2/V2).
 *   - UNINSTALL delegates to the recipe's `uninstall` closure.
 *
 * All subprocesses run via `spawnSync` with an EXPLICIT argv array (no shell, no string
 * interpolation) — the safe pattern `cli/src/ext/manage.ts` uses.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  HarnessInstallRecipe,
  HarnessRecipeContext,
} from "@hapi/protocol";
import { createHarnessUpdateRegistry } from "@/ext/harnessUpdateRegistry";

/** Injectable seams for testing the install/version/uninstall paths without real I/O. */
export interface RecipeExecOpts {
  /** Subprocess runner (argv array → result). Defaults to `spawnSync`. */
  run?: (argv: string[]) => { code: number; stdout: string; stderr: string };
  /** HTTP fetch (curl leg). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const defaultRun = (
  argv: string[]
): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

/** Build the execution context recipe closures receive (carries the update-registry port). */
export function makeRecipeContext(
  opts: RecipeExecOpts = {}
): HarnessRecipeContext {
  return { registry: createHarnessUpdateRegistry(opts.run) };
}

/** `true` when a curl spec points at a multi-file archive (tarball/zip) rather than one binary. */
function isArchive(spec: string): boolean {
  return /\.(tar\.gz|tgz|tar|zip)$/i.test(spec);
}

/**
 * Execute a catalog recipe's INSTALL. `id` is the OPEN harness id, used only for a
 * single-file curl artifact's placement destination (`~/.local/bin/<id>`).
 */
export async function executeRecipeInstall(
  id: string,
  recipe: HarnessInstallRecipe,
  opts: RecipeExecOpts = {}
): Promise<void> {
  const run = opts.run ?? defaultRun;
  switch (recipe.method) {
    case "npm": {
      // `--ignore-scripts` by default: postinstall scripts are the live supply-chain exposure
      // (1B-17). A recipe opts back in with `allowScripts: true` ONLY when the npm package must
      // run its postinstall to fetch a platform binary (Crush/Grok/Cline) — "where the CLI
      // tolerates it"; the version pin + #3131 scan are the compensating controls.
      const npmArgs = ["npm", "install", "-g", recipe.spec];
      if (!recipe.allowScripts) npmArgs.push("--ignore-scripts");
      const { code, stderr } = run(npmArgs);
      if (code !== 0) {
        throw new Error(
          `npm install '${recipe.spec}' failed: ${stderr.trim()}`
        );
      }
      return;
    }
    case "brew": {
      const { code, stderr } = run(["brew", "install", recipe.spec]);
      if (code !== 0) {
        throw new Error(
          `brew install '${recipe.spec}' failed: ${stderr.trim()}`
        );
      }
      return;
    }
    case "curl": {
      const fetchImpl = opts.fetchImpl ?? fetch;
      const res = await fetchImpl(recipe.spec);
      if (!res.ok) {
        throw new Error(
          `fetch failed for '${recipe.spec}': HTTP ${res.status}`
        );
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      // VERIFY-AFTER-FETCH (V7 / 1B-17): the recipe's sha256 is schema-required for curl.
      const digest = createHash("sha256").update(bytes).digest("hex");
      const expected = (recipe.sha256 ?? "").toLowerCase();
      if (!expected || digest !== expected) {
        throw new Error(
          `integrity check FAILED for '${recipe.spec}': expected sha256 ${recipe.sha256 ?? "(none)"}, ` +
            `got ${digest}. Refusing to install.`
        );
      }
      // Verified. A multi-file/arch-specific package (e.g. Cursor's Node tarball) needs a
      // bespoke unpack — a documented OR2 follow-up. The recipe's REAL pinned hash keeps the
      // integrity gate genuine regardless. A single-file binary IS placed here.
      if (isArchive(recipe.spec)) {
        throw new Error(
          `curl artifact for '${recipe.spec}' verified (sha256 ok) but automated unpacking of a ` +
            `multi-file archive is not yet supported (follow-up). Install '${id}' manually for now.`
        );
      }
      const binDir = join(homedir(), ".local", "bin");
      mkdirSync(binDir, { recursive: true });
      const dest = join(binDir, id);
      writeFileSync(dest, bytes);
      chmodSync(dest, 0o755);
      return;
    }
  }
}

/**
 * Uninstall an npm-global package. Recipe `uninstall` closures for npm recipes delegate here
 * so the recipe files stay free of `child_process`. `pkg` is the package WITHOUT the version
 * (e.g. `@charmland/crush`).
 */
export async function npmUninstallGlobal(
  pkg: string,
  opts: RecipeExecOpts = {}
): Promise<void> {
  const run = opts.run ?? defaultRun;
  const { code, stderr } = run(["npm", "uninstall", "-g", pkg]);
  if (code !== 0) {
    throw new Error(`npm uninstall -g '${pkg}' failed: ${stderr.trim()}`);
  }
}

/** Uninstall a Homebrew formula (recipe `uninstall` delegate for brew recipes). */
export async function brewUninstall(
  formula: string,
  opts: RecipeExecOpts = {}
): Promise<void> {
  const run = opts.run ?? defaultRun;
  const { code, stderr } = run(["brew", "uninstall", formula]);
  if (code !== 0) {
    throw new Error(`brew uninstall '${formula}' failed: ${stderr.trim()}`);
  }
}

/** Remove a binary previously placed at `~/.local/bin/<binName>` (curl recipe uninstall delegate). */
export function removeLocalBin(binName: string): void {
  rmSync(join(homedir(), ".local", "bin", binName), { force: true });
}

/** Probe the INSTALLED version of a recipe's harness (via the registry port); `null` if absent. */
export async function probeRecipeVersion(
  recipe: HarnessInstallRecipe,
  opts: RecipeExecOpts = {}
): Promise<string | null> {
  return recipe.versionProbe(makeRecipeContext(opts));
}

/** Uninstall a recipe's harness (delegates to the recipe's own uninstall closure). */
export async function uninstallRecipe(
  recipe: HarnessInstallRecipe,
  opts: RecipeExecOpts = {}
): Promise<void> {
  return recipe.uninstall(makeRecipeContext(opts));
}
