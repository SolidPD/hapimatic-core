// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Vendor chunk assignment for the web build's `manualChunks` (#3098).
 *
 * Modules are matched by PACKAGE NAME (the segment after the last
 * `node_modules/` in a resolved id), never by substring. Bun's isolated
 * install nests every package as
 * `node_modules/.bun/<name>@<version>[+<hash>]/node_modules/<pkg>/...` (a
 * scoped `@a/b` appears as `@a+b` in that first segment), so a substring
 * test such as `id.includes("/react/")` also matches `@assistant-ui/react`,
 * `@assistant-ui/tap/dist/react/...` and `zustand/esm/react/...`, and splits
 * a package across two chunks.
 *
 * Every group must be a package the entry chunk already loads statically and
 * that imports nothing loaded on demand. A manual chunk is one file: if the
 * entry imports it statically, everything assigned to it loads at startup. A
 * catch-all `vendor` chunk or a `@shikijs` match would assign lazily used code
 * (pdfjs, recharts, CodeMirror, the shiki grammars) to such a chunk directly.
 * Rollup also merges each returned module's static dependencies into its
 * chunk, which is how a shared helper lands in the wrong group (see
 * COMMONJS_HELPERS_ID). Anything not listed here returns `undefined`: there
 * is deliberately no catch-all.
 */

export const VENDOR_CHUNK_GROUPS = {
  "vendor-react": ["react", "react-dom", "scheduler"],
  "vendor-tanstack": [
    "@tanstack/router-core",
    "@tanstack/react-router",
    "@tanstack/query-core",
    "@tanstack/react-query",
    "@tanstack/history",
    "@tanstack/store",
    "@tanstack/react-store",
  ],
  "vendor-assistant-ui": [
    "@assistant-ui/react",
    "@assistant-ui/tap",
    "assistant-stream",
  ],
  "vendor-zod": ["zod"],
} as const satisfies Record<string, readonly string[]>;

export type VendorChunk = keyof typeof VENDOR_CHUNK_GROUPS;

const CHUNK_BY_PACKAGE: ReadonlyMap<string, VendorChunk> = new Map(
  (
    Object.entries(VENDOR_CHUNK_GROUPS) as [VendorChunk, readonly string[]][]
  ).flatMap(([chunk, packages]) => packages.map(pkg => [pkg, chunk] as const))
);

/**
 * Rollup's CommonJS interop helper, which every CommonJS package imports
 * (React included). Left to dependency merging it lands in whichever group
 * claims it first; on the first build that was `vendor-assistant-ui`, so
 * `vendor-react` imported it from there while `vendor-assistant-ui` imported
 * React: a two-way chunk cycle that blanked the app with "Cannot access …
 * before initialization". It belongs in vendor-react, which imports no other
 * chunk, so any chunk that needs the helper can import it from there without
 * closing a cycle.
 */
export const COMMONJS_HELPERS_ID = "\0commonjsHelpers.js";

const NODE_MODULES = "node_modules/";

/** The npm package a resolved module id belongs to, or null for app code. */
export function packageNameOf(id: string): string | null {
  const at = id.lastIndexOf(NODE_MODULES);
  if (at < 0) return null;
  const [first, second] = id.slice(at + NODE_MODULES.length).split("/");
  if (!first) return null;
  if (first.startsWith("@")) return second ? `${first}/${second}` : null;
  return first;
}

/** `build.rollupOptions.output.manualChunks` for the web build. */
export function vendorChunkFor(id: string): VendorChunk | undefined {
  if (id === COMMONJS_HELPERS_ID) return "vendor-react";
  const pkg = packageNameOf(id);
  return pkg === null ? undefined : CHUNK_BY_PACKAGE.get(pkg);
}

/**
 * The first static-import cycle between output chunks, as a list of file names
 * that starts and ends with the same chunk, or null when there is none. A
 * cycle means one chunk can run before a chunk it reads from has initialized,
 * and Rollup did not warn about the one this module once produced.
 */
export function findChunkCycle(
  imports: Readonly<Record<string, readonly string[]>>
): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (chunk: string): string[] | null => {
    if (state.get(chunk) === "done") return null;
    if (state.get(chunk) === "visiting") {
      return [...path.slice(path.indexOf(chunk)), chunk];
    }
    state.set(chunk, "visiting");
    path.push(chunk);
    for (const next of imports[chunk] ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(chunk, "done");
    return null;
  };
  for (const chunk of Object.keys(imports)) {
    const cycle = visit(chunk);
    if (cycle) return cycle;
  }
  return null;
}
