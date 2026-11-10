// SPDX-License-Identifier: AGPL-3.0-only
import { PINS_DEFAULT_ENABLED } from "@hapi/protocol";
import { isEnvFlagTruthy } from "../provisioner/capability";

/**
 * The one Pins gate (issue #6447, epic #6446). Every pin route on every surface,
 * the `/api/version` flag, the session count, and the hub's bridge read this one
 * value. Sub-Issue L (#6458) turns Pins on by flipping `PINS_DEFAULT_ENABLED` in
 * `shared/src/pins.ts`, and this variable stays as the per-instance override.
 *
 * Env-only, in the house `isEnvFlagTruthy` parse (`1` / `true` / `yes`). The
 * variable set to anything else closes the gate, so `HAPI_PINS_ENABLED=0` is the
 * kill switch once the default is on. Server-side only: the web client and the
 * session process read the answer from `GET /api/version`, because the daemon
 * and the server are separate units with separate environments.
 */
export const PINS_ENV = "HAPI_PINS_ENABLED";

export function resolvePinsEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env[PINS_ENV];
  return raw === undefined ? PINS_DEFAULT_ENABLED : isEnvFlagTruthy(raw);
}
