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
 *
 * Issue #5127: a key homed on another federation node is bound by a qualified
 * ref (`<uuid>@<homeNodeId>`). Its secret is not in this vault, so the helper
 * asks this host's own server for it (`fetchSharedApiKeySecret`, which asks the
 * home), naming the session it serves (`--session`). A bare id keeps the vault
 * path above, unchanged.
 */

import { parseApiKeyRef } from "@hapi/protocol/apiKeyRef";
import { readSettings } from "@/persistence";
import { fetchSharedApiKeySecret } from "@/apiKeys/sharedKeyClient";
import {
  readVaultApiKey,
  type VaultKeyEntry,
} from "@/daemon/sessionSpawnerHelpers";

export interface ApiKeyHelperIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Defaults to the node vault (`readSettings().apiKeys`). */
  readApiKeys?: () => Promise<VaultKeyEntry[] | undefined>;
  /** Defaults to `fetchSharedApiKeySecret` (#5127, a key on another node). */
  fetchSharedSecret?: typeof fetchSharedApiKeySecret;
}

export interface ApiKeyHelperArgs {
  apiKeyId?: string;
  masked?: string;
  sessionId?: string;
}

/**
 * Parse `--id <vault id or ref> [--mask <recorded mask>] [--session <id>]`.
 * Unknown flags are ignored.
 */
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
    } else if (flag === "--session" && value !== undefined) {
      parsed.sessionId = value;
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
  const { apiKeyId, masked, sessionId } = parseApiKeyHelperArgs(args);
  if (!apiKeyId) {
    io.stderr("api-key-helper: --id <vault key id> is required\n");
    return 2;
  }
  const ref = parseApiKeyRef(apiKeyId);
  if (ref?.homeNodeId) {
    return runSharedApiKeyHelper(apiKeyId, masked, sessionId, io);
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

/**
 * #5127: the secret of a key homed on another node, through this host's own
 * server. The server's refusal message names the key by label or mask and the
 * home node; nothing else reaches stderr.
 */
async function runSharedApiKeyHelper(
  ref: string,
  masked: string | undefined,
  sessionId: string | undefined,
  io: ApiKeyHelperIo
): Promise<number> {
  if (!sessionId || !masked) {
    io.stderr(
      "api-key-helper: a key from another node needs --session <id> and --mask <mask>\n"
    );
    return 2;
  }
  const result = await (io.fetchSharedSecret ?? fetchSharedApiKeySecret)({
    ref,
    expectedMasked: masked,
    sessionId,
  });
  if (!result.ok) {
    io.stderr(`api-key-helper: ${result.message}\n`);
    return 1;
  }
  io.stdout(result.apiKey);
  return 0;
}
