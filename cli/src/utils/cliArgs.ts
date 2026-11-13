// SPDX-License-Identifier: AGPL-3.0-only
import { basename } from "node:path";

function resolveRawArgv(): string[] {
  const bunArgv = globalThis.Bun?.argv;
  if (Array.isArray(bunArgv) && bunArgv.length > 0) {
    return bunArgv;
  }
  return process.argv;
}

/** The runtime facts the prefix strip reads; injectable so the shapes can be tested. */
export type CliRuntime = {
  /** `process.execPath`: the bun binary in a source run, the binary file when compiled. */
  execPath: string;
  /** `Bun.main`: the entrypoint (`/$bunfs/root/<name>` when compiled); "" under Node. */
  bunMain: string;
};

const SCRIPT_PATH = /\.(c|m)?(ts|js)$/;

/**
 * The user's arguments: `rawArgv` without its runtime prefix (hapimatic-private#5348).
 *
 * Only the prefix is removed: the runtime token (`bun`, the exec path or its basename)
 * and AT MOST one entrypoint after it (`Bun.main`, or a script path under Node, where
 * `Bun.main` is empty); or a leading `Bun.main` alone. A `--` is never removed or moved.
 * On bun 1.4.4 a compiled binary's argv is `["bun", "/$bunfs/root/<name>", …]` with any
 * user `--` passed through (even directly after the entrypoint), and a source run never
 * receives a wrapper `--` (bun strips one directly after the script), so every `--` that
 * reaches here is the user's. Consuming it gave `hapi -- --yolo` a bypass session.
 *
 * A shape it does not recognise is returned unchanged, never refused:
 * `configuration.ts` calls `getCliArgs()` while the module loads.
 */
export function normalizeCliArgs(
  rawArgv: string[],
  runtime: CliRuntime = {
    execPath: process.execPath,
    bunMain: globalThis.Bun?.main ?? "",
  }
): string[] {
  if (!Array.isArray(rawArgv) || rawArgv.length === 0) {
    return [];
  }
  const { execPath, bunMain } = runtime;
  const first = rawArgv[0];
  let start = 0;
  if (first === "bun" || first === execPath || first === basename(execPath)) {
    start = 1;
    const entry = rawArgv[1] ?? "";
    const isEntrypoint = bunMain ? entry === bunMain : SCRIPT_PATH.test(entry);
    if (isEntrypoint) {
      start = 2;
    }
  } else if (bunMain && first === bunMain) {
    start = 1;
  }
  return rawArgv.slice(start);
}

export function getCliArgs(): string[] {
  return normalizeCliArgs(resolveRawArgv());
}
