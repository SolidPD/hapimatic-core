// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — whole-feature exposure switch (issues #4533 and #5165,
 * epic #4290).
 *
 * Porter is **exposed by default** (Matt's ruling of 2026-10-14, #5165): every
 * instance built from this source — the public install, hosted VMs, operator
 * nodes, worktree and golden-image instances — serves the Porter with no
 * environment set. `HAPI_PORTER_EXPOSED=0` is the kill switch that withholds a
 * node: while withheld, the composition-root gate
 * (`server/src/web/middleware/porterExposure.ts`, mounted in `buildWebApp.ts`)
 * answers every `/api/porter/*` and `/p/*` request with 404 `porter_withheld`
 * before any Porter handler, sweep, staging write, keypair generation or token
 * mint runs.
 *
 * The predicate fails closed (#5165 D3): the value exposes only when it is
 * unset, empty, `1`, `true` or `yes` (case-insensitive). Every other value —
 * `0`, `false`, `no`, `off`, a padded token, a typo — withholds, so a mistyped
 * kill switch still withholds rather than exposing.
 *
 * Withholding a node, and the record of the default flip, are in
 * `docs/internal/architecture/config-porter-exposure.md`.
 *
 * Read at call time like {@link ./porterPluginInstallConfig.porterPluginInstallEnabled},
 * but with the opposite default: that switch stays default-OFF.
 */

/** The env var that withholds Porter when set to a value other than empty, `1`, `true` or `yes`. */
export const PORTER_EXPOSURE_ENV = "HAPI_PORTER_EXPOSED" as const;

/** Values that keep Porter exposed when the env var is set (case-insensitive). */
const EXPOSING_VALUES = ["", "1", "true", "yes"];

/**
 * True unless {@link PORTER_EXPOSURE_ENV} holds a withholding value. Unset,
 * empty, `1`, `true` and `yes` (case-insensitive) expose; ANY other value
 * (`0`, `false`, `no`, `off`, a padded `" 1"`, an unrecognized string)
 * withholds.
 *
 * Read at call time (not memoized) so the gate re-evaluates on every request
 * and a test or an operator change takes effect without a module reload.
 */
export function porterExposed(): boolean {
  const raw = process.env[PORTER_EXPOSURE_ENV];
  if (raw === undefined) return true;
  return EXPOSING_VALUES.includes(raw.toLowerCase());
}
