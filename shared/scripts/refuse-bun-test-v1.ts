// Issue #5194: bun's `vi` shim (bun 1.4.0) lacks vi.resetModules / vi.doUnmock, and `bun test`
// writes its own snapshot keys into the vitest-owned .snap files, so refuse it here.
throw new Error(
  "shared/ tests run under vitest: run `bun run test` (vitest run) here, not `bun test` (#5194)."
);
