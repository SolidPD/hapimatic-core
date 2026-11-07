// SPDX-License-Identifier: AGPL-3.0-only
/**
 * TEST-ONLY (issue #6321): a scratch `HAPI_HOME` holding a node docs folder the
 * way #6219's server leaves it, a real `docs/` directory with its
 * `.docs-version` stamp, installed as `configuration.happyHomeDir` until
 * `restore()` runs. Only `*.test.ts` files import it.
 *
 * Every vitest run shares one `HAPI_HOME` across files (`vitest.config.ts`), so
 * a test that created `docs/` there could change another file's settings file
 * mid-run. Each test file runs in its own process, so swapping the
 * configuration singleton for a private home cannot race another file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_DOCS_DIR_NAME, NODE_DOCS_VERSION_FILE } from "@hapi/protocol";
import { configuration } from "@/configuration";

export interface NodeDocsHome {
  home: string;
  docsDir: string;
  /** Put the previous home back and delete the scratch home. */
  restore: () => void;
}

export function installNodeDocsHome(): NodeDocsHome {
  const home = mkdtempSync(join(tmpdir(), "hapi-6321-home-"));
  const docsDir = join(home, NODE_DOCS_DIR_NAME);
  mkdirSync(docsDir);
  writeFileSync(
    join(docsDir, NODE_DOCS_VERSION_FILE),
    "0.0.0-test+000000000000\n"
  );
  const config = configuration as unknown as { happyHomeDir: string };
  const saved = config.happyHomeDir;
  config.happyHomeDir = home;
  return {
    home,
    docsDir,
    restore: () => {
      config.happyHomeDir = saved;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
