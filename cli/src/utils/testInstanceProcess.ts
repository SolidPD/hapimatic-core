// SPDX-License-Identifier: AGPL-3.0-only
import { serverPortFromUrl } from "@hapi/protocol/instanceKind";
import {
  readInstanceKind,
  type InstanceKindReading,
} from "@hapi/protocol/instanceKindReader";
import { configuration } from "@/configuration";

let reading: InstanceKindReading | undefined;

/**
 * This process's instance-kind reading, made ONCE per process (issue #6756, TC1; a leaf
 * since #6977, so a module outside `claude/` can ask). The session wrapper runs in the
 * instance's environment; a tmux-persisted worker gets `HAPI_HOME` on the forward channel
 * (#1575), so it reads the instance's `instance-kind` file. A daemon has a fuller reading
 * (`ctx.instanceKind`: it adds the systemd unit) and passes that one instead.
 */
export function processInstanceKind(): InstanceKindReading {
  reading ??= readInstanceKind({
    dataDir: configuration.happyHomeDir,
    serverPort: serverPortFromUrl(configuration.serverUrl),
  });
  return reading;
}

/** Whether this process runs on a test instance (issue #6756, TC1). */
export function isTestInstanceProcess(): boolean {
  return processInstanceKind().kind === "test";
}
