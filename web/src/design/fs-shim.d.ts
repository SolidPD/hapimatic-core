// SPDX-License-Identifier: AGPL-3.0-only
// Ambient shim for the single Node fs read used by tokens.test.ts.
//
// The web tsconfig scopes `types` to ["vite/client"], which excludes
// @types/node (app code is DOM-typed and must not gain Node globals). The
// design-token test needs to read tokens.css from disk to textually verify the
// runtime-swap chain (jsdom cannot resolve var() chains). This file is a
// SCRIPT (no top-level import/export), so `declare module` is a fresh ambient
// module declaration rather than an augmentation — that lets the test's
// `import { readFileSync } from "node:fs"` type-check without pulling all of
// @types/node into the web package's global scope. Vitest runs on Bun/Node,
// which provides the real implementation at runtime.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf-8"): string;
}
