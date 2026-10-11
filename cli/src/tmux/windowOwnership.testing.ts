// SPDX-License-Identifier: AGPL-3.0-only
/**
 * TEST-ONLY producer of an {@link OwnedWindowTarget} (issue #4218 G1).
 *
 * Tests that drive a `TmuxManager` mutator directly (a window they created on
 * their own unique socket) wrap the raw target with {@link ownedTargetForTest}.
 * `ownedTargetGuard.test.ts` allows this module to be imported ONLY from
 * `*.test.ts` files, and allows its cast — production code must use a named
 * producer in `windowOwnership.ts`. A test that asserts OWNERSHIP behavior uses
 * the real producers instead.
 */

import type { OwnedWindowTarget } from "./windowOwnership";

export function ownedTargetForTest(target: string | number): OwnedWindowTarget {
  return target as OwnedWindowTarget;
}
