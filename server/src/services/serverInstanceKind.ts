// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  TEST_STORE_BOOKKEEPING_FILES,
  TEST_STORE_MARKER,
  describeInstanceKind,
  type InstanceKind,
} from "@hapi/protocol/instanceKind";
import {
  readInstanceKind,
  type InstanceKindReading,
} from "@hapi/protocol/instanceKindReader";

/**
 * Issue #6756 (TC1): the server's instance kind, read ONCE at boot (`buildWebApp`) from
 * the data dir its configuration resolved and its web port. The server passes no unit
 * name: its other signals cover the worktree server unit (every worktree launch sets
 * `HAPI_WT_OWNER_WORKTREE`).
 *
 * On a TEST instance the server imports no OpenAI account from the machine-global folders
 * or the host `~/.codex` login and shows no OpenAI row built from them (R4), refuses an
 * OpenAI login start (R17), and lists none of an inherited store's accounts (R13).
 *
 * Each consumer takes the kind through an injected option whose default is
 * {@link getServerInstanceKind}. Until the boot sets it, that default is `real`, so a
 * test that never sets it keeps today's behaviour whatever its `/tmp` home looks like.
 */

/** #6756 (R17, ER-D3): the refusal of an OpenAI login start on a test instance. */
export const OPENAI_LOGIN_TEST_INSTANCE_CODE =
  "openai_login_unavailable_on_test_instance";
export const OPENAI_LOGIN_TEST_INSTANCE_MESSAGE =
  "OpenAI sign-in is off on a test instance (#6756): use a test fixture";

/**
 * #6756 (round 3, E1): the refusal of an Anthropic login start on a test instance whose
 * store predates this work. The sign-in would be saved, then hidden by every reader.
 */
export const ANTHROPIC_LOGIN_INHERITED_STORE_CODE =
  "anthropic_login_unavailable_on_inherited_test_store";
export const ANTHROPIC_LOGIN_INHERITED_STORE_MESSAGE =
  "Anthropic sign-in is off on this test instance (#6756): its account store predates the test-store marker, so a new sign-in would be saved and then hidden";

let bootReading: InstanceKindReading | null = null;

/** Read and remember the server's kind; returns the reading for the boot log. */
export function initServerInstanceKind(opts: {
  dataDir: string;
  serverPort: number;
}): InstanceKindReading {
  bootReading = readInstanceKind({
    dataDir: opts.dataDir,
    serverPort: opts.serverPort,
  });
  return bootReading;
}

/** The kind the boot read; `real` before the boot ran (tests). */
export function getServerInstanceKind(): InstanceKind {
  return bootReading?.kind ?? "real";
}

/** The boot reading's log line body, or `null` before the boot ran. */
export function describeServerInstanceKind(): string | null {
  return bootReading ? describeInstanceKind(bootReading) : null;
}

/** Test seam: forget the boot reading. */
export function resetServerInstanceKindForTests(): void {
  bootReading = null;
}

/**
 * R13 (ER-D1): true when this test instance's `accounts/` holds any `*.json` other than a
 * daemon bookkeeping file and no test-store marker, i.e. a store that predates this work. Read per request (a directory
 * listing, no file contents); the records stay on disk untouched. A listing that fails
 * with anything but ENOENT counts as inherited (nothing proves the store the instance's
 * own).
 */
export function isInheritedTestStore(accountsDir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(accountsDir);
  } catch (error) {
    return (error as { code?: unknown } | null)?.code !== "ENOENT";
  }
  if (names.includes(TEST_STORE_MARKER)) return false;
  // A daemon's own bookkeeping file is never evidence of an older store.
  return names.some(
    name =>
      name.endsWith(".json") && !TEST_STORE_BOOKKEEPING_FILES.includes(name)
  );
}

/**
 * R13 (ER-D1): true on a test instance whose store predates this work. The one rule the
 * account routes and the Anthropic login starts (local and peer) share.
 */
export function isInheritedStoreOn(
  kind: InstanceKind,
  accountsDir: string
): boolean {
  return kind === "test" && isInheritedTestStore(accountsDir);
}

/**
 * #6756 (R4): where the OpenAI part of the provider import reads. A test instance reads
 * neither the machine-global folders nor the host `~/.codex` login (`null` skips each);
 * a real or dev instance keeps today's sources (ER-D4).
 */
export function providerImportSources(kind: InstanceKind): {
  accountConfigsDir: string | null;
  hostCodexHome: string | null;
} {
  if (kind === "test") return { accountConfigsDir: null, hostCodexHome: null };
  return {
    accountConfigsDir: join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "hapimatic",
      "account-configs"
    ),
    hostCodexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  };
}
