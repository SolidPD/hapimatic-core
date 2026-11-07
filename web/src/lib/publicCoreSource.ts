// SPDX-License-Identifier: AGPL-3.0-only
/**
 * §13 Corresponding-Source offer (issues #3869 R2, #4676). The value and the link rule live in
 * `shared/src/publicCoreSource.ts` (issue #6219), so the server's node docs index and every
 * session's docs pointer use the same URL as the About page. This file keeps the web import path
 * (`@/lib/publicCoreSource`) unchanged.
 *
 * The re-export names the package subpath (`@hapi/protocol/publicCoreSource`), never the
 * `@hapi/protocol` barrel, so importing this module still loads a single import-free file.
 */
export {
  PUBLIC_CORE_REPO_URL,
  correspondingSourceHref,
} from "@hapi/protocol/publicCoreSource";
