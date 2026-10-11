// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from "node:os";

/**
 * Expand a leading `~` to a home directory (issue #3558).
 *
 * Exactly `~` becomes `home`, and `~/rest` becomes `${home}/rest`. Anything
 * else — `~user/...`, relative paths, absolute paths, the empty string — is
 * returned unchanged. These are the semantics the federation receivers already
 * used inline (list-directory, paths/exists, spawn); this helper is now their
 * single implementation.
 *
 * `home` defaults to this process's `homedir()`. Pass a node's advertised home
 * dir to expand a path for a DIFFERENT machine (the hub pre-expanding for a
 * federation peer).
 *
 * Not shared with `cli/`: that package cannot import `server/src/utils`, so
 * `cli/src/api/apiMachine.ts` and `cli/src/daemon/sessionSpawner.ts` keep
 * their own copies with identical semantics. `validateCreateDirectoryTarget`
 * (pathSecurity.ts) also keeps its inline copy — it is kept byte-for-byte
 * identical to its cli sibling.
 */
export function expandTilde(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  return p;
}

/** True when `p` is exactly `~` or starts with `~/` (the forms `expandTilde` rewrites). */
export function isTildePath(p: string): boolean {
  return p === "~" || p.startsWith("~/");
}
