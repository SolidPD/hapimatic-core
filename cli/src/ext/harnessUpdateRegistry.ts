// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cli-side {@link HarnessUpdateRegistry} port implementation (issue #3120, R2 / KD4).
 *
 * Catalog recipes consume this port for version probe / pin / update. It REUSES #1769/
 * #1770's detection contract — a `{ cmd, versionRegex }` probe target mirrors
 * `HarnessDetectSchema` (`shared/src/harness.ts`), and the version is regex-extracted from
 * the probe command's output exactly as #1769's detection does. It is a STATELESS adapter,
 * NOT a second version store: #1769's persistent registry + `HarnessStore` live server-side,
 * and this adapter introduces no parallel `harnessRegistry`-like constant (the V2 grep).
 *
 * Commands are run via `node:child_process` `spawnSync` with an EXPLICIT argv array (never a
 * shell, never string interpolation) — the exact safe pattern `cli/src/ext/manage.ts`
 * `runProcess` uses, so it runs identically under the compiled Bun binary and Node/vitest.
 */
import { spawnSync } from "node:child_process";
import type {
  HarnessLatestSource,
  HarnessProbeTarget,
  HarnessUpdateRegistry,
} from "@hapi/protocol";
import { logger } from "@/ui/logger";

/** Runs a code-defined argv array (no shell). Returns exit code + captured stdout/stderr. */
export type CommandRunner = (argv: string[]) => {
  code: number;
  stdout: string;
  stderr: string;
};

const defaultRunner: CommandRunner = argv => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

/** Split a code-defined probe command line (e.g. `"crush --version"`) into an argv array. */
function toArgv(cmd: string): string[] {
  return cmd.trim().split(/\s+/);
}

/**
 * Build the cli-side update-registry port. `run` is injectable for tests (the default
 * shells out via `spawnSync` with an argv array).
 */
export function createHarnessUpdateRegistry(
  run: CommandRunner = defaultRunner
): HarnessUpdateRegistry {
  return {
    async probe(target: HarnessProbeTarget): Promise<string | null> {
      const { code, stdout, stderr } = run(toArgv(target.cmd));
      // A non-zero exit (or a missing binary → ENOENT → status null → 1) means "not
      // installed" — return null rather than throwing (catalog probing is
      // fallback-preserving, mirroring resolveCatalogManifest's non-throwing miss).
      if (code !== 0) return null;
      const match = new RegExp(target.versionRegex).exec(
        `${stdout}\n${stderr}`
      );
      if (!match) return null;
      return match[1] ?? match[0];
    },

    async pin(harnessId: string, version: string): Promise<void> {
      // Advisory only: #1769/#1770's persistence (`HarnessStore`) is server-side, and this
      // sub deliberately introduces no parallel store. Record the resolved pin to the log.
      logger.info(`[harness] pinned '${harnessId}' -> ${version}`);
    },

    async update(source: HarnessLatestSource): Promise<string> {
      if (source.method === "npm") {
        // Explicit argv — the ref is a positional argument, never interpolated into a shell.
        const { code, stdout } = run(["npm", "view", source.ref, "version"]);
        const version = stdout.trim();
        if (code === 0 && version) return version;
        throw new Error(
          `could not resolve latest npm version for '${source.ref}'`
        );
      }
      // brew/curl latest-resolution is not part of the MVP (install pins an exact version
      // and `probe` reports the installed one). A recipe can override with its own probe.
      throw new Error(
        `update() for method '${source.method}' is not supported yet (probe/pin cover the MVP)`
      );
    },
  };
}
