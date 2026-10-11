// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #4568 (F1): `hapi api-key-helper` — the `apiKeyHelper` Claude Code runs
 * for an API-key session.
 *
 * An API-key session used to hand its key to the SDK child as
 * `ANTHROPIC_API_KEY`. Every process that child starts inherits its
 * environment — hooks, the Bash tool, stdio MCP servers — so any `env` print
 * wrote the client's key into the transcript. Claude Code reads an
 * `apiKeyHelper`'s stdout for its own requests only; measured on Claude Code
 * 2.1.280, the key then appears in no hook or Bash environment, it outranks
 * `CLAUDE_CODE_OAUTH_TOKEN` and the `/login` credentials, and a helper that
 * exits non-zero or prints nothing makes Claude Code send an EMPTY credential
 * (a 401), never a fallback to a login.
 *
 * Contract: stdout carries exactly the key and nothing else (exit 0). On any
 * refusal, stdout stays empty, stderr gets a message that names the key by
 * label / mask only, and the exit code is non-zero. The vault is read by id at
 * every call and the mask recorded at spawn is re-checked, so a key replaced
 * under the same id is never billed as the replacement. Claude Code caches the
 * key the helper last returned and keeps using it until a request is rejected,
 * so removing a key from the vault does not stop a running session from
 * billing it — the same lifetime the earlier env delivery had.
 */

import { readSettings } from "@/persistence";
import {
  readVaultApiKey,
  type VaultKeyEntry,
} from "@/daemon/sessionSpawnerHelpers";

export interface ApiKeyHelperIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Defaults to the node vault (`readSettings().apiKeys`). */
  readApiKeys?: () => Promise<VaultKeyEntry[] | undefined>;
}

export interface ApiKeyHelperArgs {
  apiKeyId?: string;
  masked?: string;
}

/** Parse `--id <vault id> [--mask <recorded mask>]`. Unknown flags are ignored. */
export function parseApiKeyHelperArgs(args: string[]): ApiKeyHelperArgs {
  const parsed: ApiKeyHelperArgs = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--id" && value !== undefined) {
      parsed.apiKeyId = value;
      i++;
    } else if (flag === "--mask" && value !== undefined) {
      parsed.masked = value;
      i++;
    }
  }
  return parsed;
}

/** Run the helper. Returns the process exit code; writes only through `io`. */
export async function runApiKeyHelper(
  args: string[],
  io: ApiKeyHelperIo
): Promise<number> {
  const { apiKeyId, masked } = parseApiKeyHelperArgs(args);
  if (!apiKeyId) {
    io.stderr("api-key-helper: --id <vault key id> is required\n");
    return 2;
  }
  let apiKeys: VaultKeyEntry[] | undefined;
  try {
    apiKeys = await (
      io.readApiKeys ?? (async () => (await readSettings()).apiKeys)
    )();
  } catch {
    io.stderr("api-key-helper: could not read this node's key vault\n");
    return 1;
  }
  const result = readVaultApiKey({ apiKeyId, expectedMasked: masked, apiKeys });
  if (!result.ok) {
    io.stderr(`api-key-helper: ${result.message}\n`);
    return 1;
  }
  io.stdout(result.key);
  return 0;
}
