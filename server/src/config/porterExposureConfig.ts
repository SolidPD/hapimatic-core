// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — whole-feature exposure gate (issue #4533, epic #4290).
 *
 * Product-map decision 6 (`docs/hapimatic-product-map.md` §8.4) makes Porter
 * non-blocking for v1: its functionality is exposed only when its own
 * readiness/security gate passes, and is otherwise UNAVAILABLE — not merely
 * hidden. This switch is that gate's single server-side control. Terminology:
 * **enabled means exposed; the default (unset) means withheld.**
 *
 * Default **withheld**. Truthy-enable, NOT inverted: an absent/blank env keeps
 * Porter withheld, so every provisioned VM, golden-image clone and worktree
 * instance that never sets the env runs withheld. While withheld, the
 * composition-root gate (`server/src/web/middleware/porterExposure.ts`, mounted
 * in `buildWebApp.ts`) answers every `/api/porter/*` and `/p/*` request with
 * 404 `porter_withheld` before any Porter handler, sweep, staging write,
 * keypair generation or token mint runs.
 *
 * The operator flips it ON only after #4290's current-contract gate items are
 * CLOSED, recording the flip in `docs/internal/architecture/config-porter-exposure.md`.
 *
 * The idiom mirrors {@link ./porterPluginInstallConfig.porterPluginInstallEnabled}:
 * `["true","1","yes"]`, case-insensitive, read at call time.
 */

/** The env var that EXPOSES Porter. Porter is withheld when unset. */
export const PORTER_EXPOSURE_ENV = "HAPI_PORTER_EXPOSED" as const;

/**
 * True when Porter is explicitly exposed via {@link PORTER_EXPOSURE_ENV}.
 * Truthy values are `1` / `true` / `yes` (case-insensitive); ANY other value
 * (including unset, empty, `0`, `false`, `no`, a padded token, or an
 * unrecognized string) resolves to `false` — the default-withheld posture.
 *
 * Read at call time (not memoized) so the gate re-evaluates on every request
 * and a test or an operator flip takes effect without a module reload.
 */
export function porterExposed(): boolean {
  return ["true", "1", "yes"].includes(
    process.env[PORTER_EXPOSURE_ENV]?.toLowerCase() ?? ""
  );
}
