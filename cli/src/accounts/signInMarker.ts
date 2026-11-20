// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6837 (R6, R7): the one reader of the Provider Accounts sign-in marker rule.
 *
 * A Provider Accounts sign-in leaves `.hapimatic-sign-in.json` in the account's
 * folder, naming the sha256 fingerprint of the refresh token that sign-in produced
 * (`server/src/services/isolatedCredentialsSync.ts` `writeSignInMarker`). A folder
 * token proves it is NOT a copy of the `~/.claude` login chain only when that
 * marker names it: a token that merely differs from the host's may be an older
 * token of the same chain (#6800 round 2, `shared/src/accounts.ts`
 * `SIGN_IN_MARKER_FILE`). Boot adoption (`accountStore.ts`) and the shared-chain
 * detector's identity pass (`hostChainQuarantine.ts`) both apply this rule.
 * `tokenRefreshService.ts` `clearStaleUnrefreshableFlags` applies the same rule
 * with its own copy (left there because issue #6801 edits that file).
 *
 * Leaf module: it imports no `@/accounts/*` module, so `accountStore.ts` (which
 * `machineRotator.ts` and `accountConfigDir.ts` import) can import it without a
 * cycle. Nothing here throws, and no token value leaves it.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSignInMarker,
  SIGN_IN_MARKER_FILE,
} from "@hapi/protocol/accounts";

/**
 * The refresh-token fingerprint the sign-in marker in `folderDir` names, or null
 * when there is no marker, it cannot be read, or it is not a well-formed
 * version-1 marker. Never throws.
 */
export async function readSignInMarkerIn(
  folderDir: string
): Promise<string | null> {
  try {
    return parseSignInMarker(
      await readFile(join(folderDir, SIGN_IN_MARKER_FILE), "utf-8")
    );
  } catch {
    return null;
  }
}

/**
 * True only when both values are non-empty and the marker's fingerprint is the
 * sha256 of `refreshToken`, i.e. a Provider Accounts sign-in produced exactly
 * this token.
 */
export function signInMarkerNamesToken(
  markerFingerprint: string | null,
  refreshToken: string | null | undefined
): boolean {
  if (!markerFingerprint || !refreshToken) return false;
  return (
    markerFingerprint ===
    createHash("sha256").update(refreshToken).digest("hex")
  );
}
