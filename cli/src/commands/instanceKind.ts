// SPDX-License-Identifier: AGPL-3.0-only
import {
  INSTANCE_KIND_CLASSIFIER_SENTINEL,
  describeInstanceKind,
  serverPortFromUrl,
  type InstanceKind,
  type InstanceKindSignal,
} from "@hapi/protocol/instanceKind";
import {
  readInstanceKind,
  type InstanceKindReading,
} from "@hapi/protocol/instanceKindReader";
import { configuration } from "@/configuration";
import { readOwnUnitName } from "@/daemon/instanceKindBoot";
import type { CommandDefinition } from "./types";

/**
 * `hapi instance-kind [--json]` (issue #6756, ER-D2): print how the instance-kind
 * classifier reads this process's own environment, and exit 0. It reads the data dir
 * the configuration resolved, the server port, the process's systemd unit and the two
 * environment variables; it writes nothing. `scripts/hapi-worktree.sh` may run it as a
 * second check on a binary that already carries the classifier's sentinel; a binary
 * without the sentinel is never run (an older one would treat the unknown subcommand as
 * a Claude launch).
 */

/** The classifier contract this binary implements, read from its sentinel. */
export const INSTANCE_KIND_CLASSIFIER_VERSION = Number(
  INSTANCE_KIND_CLASSIFIER_SENTINEL.slice(
    INSTANCE_KIND_CLASSIFIER_SENTINEL.lastIndexOf(":") + 1
  )
);

export interface InstanceKindJson {
  kind: InstanceKind;
  signals: InstanceKindSignal[];
  classifier: number;
}

export function instanceKindJson(
  reading: InstanceKindReading
): InstanceKindJson {
  return {
    kind: reading.kind,
    signals: reading.signals,
    classifier: INSTANCE_KIND_CLASSIFIER_VERSION,
  };
}

export interface InstanceKindCommandDeps {
  read: () => InstanceKindReading;
  print: (line: string) => void;
}

/** Run the command; returns the exit code (always 0: a reading never fails). */
export function runInstanceKindCommand(
  args: readonly string[],
  deps: InstanceKindCommandDeps
): number {
  const reading = deps.read();
  if (args.includes("--json")) {
    deps.print(JSON.stringify(instanceKindJson(reading)));
  } else {
    deps.print(describeInstanceKind(reading));
    for (const what of reading.unreadable) {
      deps.print(`could not read the ${what}; counted as absent`);
    }
  }
  return 0;
}

export const instanceKindCommand: CommandDefinition = {
  name: "instance-kind",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    const code = runInstanceKindCommand(commandArgs, {
      read: () =>
        readInstanceKind({
          dataDir: configuration.happyHomeDir,
          serverPort: serverPortFromUrl(configuration.serverUrl),
          unitName: readOwnUnitName(),
        }),
      print: line => console.log(line),
    });
    process.exit(code);
  },
};
