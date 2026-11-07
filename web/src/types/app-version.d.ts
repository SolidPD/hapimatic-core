// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The version this web bundle was built from (#3491) — the `VERSION` that
 * `server/src/version.generated.ts` holds, which is also what `/api/version`
 * serves. Substituted at build time by the `define` in `web/vite.config.ts`
 * (and by `web/vitest.config.ts` under test). Read it through
 * `getClientVersion()` in `@/lib/app-version`, never directly: the accessor
 * tolerates a runner that does not define it.
 */
declare const __APP_VERSION__: string;
