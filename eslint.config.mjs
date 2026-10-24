import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import regexp from "eslint-plugin-regexp";
import requireDialogDescriptionPolicy from "./scripts/eslint-rules/require-dialog-description-policy.mjs";
import noUncatalogedRoute from "./scripts/eslint-rules/no-uncataloged-route.mjs";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "**/node_modules/",
      "**/dist/",
      "**/build/",
      "website/",
      "docs/",
      "**/*.generated.*",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    files: [
      "web/src/**/*.{ts,tsx}",
      "server/src/**/*.{ts,tsx}",
      "cli/src/**/*.{ts,tsx}",
      "shared/**/*.{ts,tsx}",
      "gateway/src/**/*.{ts,tsx}",
    ],
    rules: {
      // Relaxed for forked codebase — upstream uses `any` extensively
      "@typescript-eslint/no-explicit-any": "warn",
      // Upstream has many unused params for interface compatibility
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Style preference — warn, not error
      "prefer-const": "warn",
      // Upstream patterns
      "no-empty": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      // Upstream uses obj.hasOwnProperty() pattern
      "no-prototype-builtins": "warn",
      // Upstream has ANSI escape code regex patterns
      "no-control-regex": "warn",
      // Upstream regex escaping
      "no-useless-escape": "warn",
    },
  },
  {
    // Super-linear regexes block the single-threaded server for seconds on a
    // long input (a `/\/+$/` trim took 13 s on 100 000 chars). CodeQL raised
    // nine of them on the public core as js/polynomial-redos (2026-10-18);
    // `shared/src/trimChars.ts` is the linear replacement for the trailing-
    // run case. Errors, not warnings, so a new one fails the PR.
    files: [
      "web/src/**/*.{ts,tsx}",
      "server/src/**/*.{ts,tsx}",
      "cli/src/**/*.{ts,tsx}",
      "shared/**/*.{ts,tsx}",
      "gateway/src/**/*.{ts,tsx}",
      "scripts/**/*.ts",
    ],
    // A test's regexes run over its own fixtures, so they are not an attack
    // surface (and trimChars.test.ts deliberately uses the slow forms as the
    // oracle it compares against).
    ignores: ["**/*.test.{ts,tsx}"],
    plugins: { regexp },
    rules: {
      "regexp/no-super-linear-move": "error",
      "regexp/no-super-linear-backtracking": "error",
    },
  },
  {
    // GRANDFATHERED: the 32 files that already violated the two rules when
    // they were introduced. Each site reads bounded or operator-controlled
    // input (verified 2026-10-18). Downgraded to `warn` so the rule can ship
    // as an error everywhere else; fix a file and REMOVE it from this list —
    // never add to it. Drain-down tracked in hapimatic-private#5441.
    files: [
      "cli/src/agent/projection/agentPlugins.ts",
      "cli/src/agent/projection/provenance.ts",
      "cli/src/claude/utils/rateLimitDetector.ts",
      "cli/src/commands/securityFailClosed.ts",
      "cli/src/commands/securitySeams.ts",
      "cli/src/companion/privateSshd.ts",
      "cli/src/daemon/sessionCapacity.ts",
      "cli/src/daemon/systemdInvariants.ts",
      "cli/src/daemon/worktree.ts",
      "gateway/src/lib/instanceClass.ts",
      "scripts/check-design-catalog-completeness.ts",
      "scripts/check-icon-col-registry.ts",
      "scripts/check-settings-scroll.ts",
      "scripts/generate-sbom-v1.ts",
      "scripts/generate-support-docs-bundle-v1.ts",
      "server/src/accounts/usageService.ts",
      "server/src/porter/hookRegistrationValidator.ts",
      "server/src/porter/tarArchive.ts",
      "server/src/provisioner/jobModel.ts",
      "server/src/provisioner/jobRunner.ts",
      "server/src/provisioner/logMasking.ts",
      "server/src/services/anthropicOauthLoginClient.ts",
      "server/src/systemJobs/osCronReader.ts",
      "server/src/utils/slashCommands.ts",
      "server/src/web/routes/cli.ts",
      "server/src/web/routes/impactArtifact.ts",
      "shared/src/companion.ts",
      "shared/src/mcpListParse.ts",
      "shared/src/messages.ts",
      "web/src/chat/messagePreview.ts",
      "web/src/components/vms/JobLogViewer.tsx",
      "web/src/lib/gitParsers.ts",
    ],
    rules: {
      "regexp/no-super-linear-move": "warn",
      "regexp/no-super-linear-backtracking": "warn",
    },
  },
  {
    // #5202 (U20): the Porter test fixtures live under `__tests__/`, which the
    // public-core export drops (`!*/__tests__/*` in
    // scripts/public-core-allowlist-v1.txt). A production module that imported
    // one would ship a dependency the exported tree does not contain, so only
    // tests and other fixtures may import from a `__tests__/` folder.
    files: ["server/src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/__tests__/**"],
              message: "test fixtures are test-only (#5202 U20)",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Issue #3049 — accessibility guard: every shared <DialogContent> opening in
    // production web/src must declare exactly one description policy (a non-empty
    // `description` prop, one <DialogDescription> descendant, or an explicit
    // `aria-describedby={undefined}` opt-out), preventing regressions into Radix's
    // "Missing Description for DialogContent" warning. Test/spec files are excluded;
    // direct DialogPrimitive.Content users are intentionally out of scope (D2.1).
    files: ["web/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.*", "**/*.spec.*"],
    plugins: {
      "local-a11y": {
        rules: {
          "require-dialog-description-policy": requireDialogDescriptionPolicy,
        },
      },
    },
    rules: {
      "local-a11y/require-dialog-description-policy": "error",
    },
  },
  {
    // Issue #3742 — every REST route on the capability surface must be annotated
    // with a `cataloged()` middleware, so the capability catalog stays in
    // lockstep with the routes it describes. Ships with a per-file grandfathering
    // baseline (`scripts/no-uncataloged-route-baseline.json`) that Sub-Issue F
    // (#3746) drained to `{}` at its CLOSING slice F.16 (#3837) — the rule now
    // runs at FULL STRENGTH over the widened D7 glob (ratchet-to-zero, R8/R10).
    // The `files` shapes cover every route-declaring file: the `routes/**` tree,
    // both extension forms (`extensions/**/routes/**`, `extensions/*/routes.ts`),
    // and — since #3743 D1 moved `createWebApp` out of `server/src/web/server.ts`
    // — the inline-route file `server/src/web/buildWebApp.ts` (#3837 3837-3);
    // `server.ts` is kept belt-and-braces though it now declares 0 routes. This
    // `files` list MUST match `RULE_GLOBS` in
    // `scripts/eslint-rules/update-no-uncataloged-route-baseline.mjs` and the
    // relevant-path predicate in `scripts/capability-catalog-precommit.ts`
    // exactly. `ignores` excludes test/spec files (their route calls must never
    // inflate the baseline) AND the never-COMPOSED `session-notes` extension
    // (its routes never load — absent from `extensions.generated.ts` — so they
    // are a file-level lint exclusion, NOT an infra PATH and NEVER cataloged;
    // #3837 3837-5 / KD-F16-3). Keep this `ignores` set in lockstep with the
    // updater's `overrideConfig` ignores (ruling D7).
    files: [
      "server/src/web/routes/**/*.ts",
      "server/src/extensions/**/routes/**/*.ts",
      "server/src/extensions/*/routes.ts",
      "server/src/web/server.ts",
      "server/src/web/buildWebApp.ts",
    ],
    ignores: [
      "**/*.test.*",
      "**/*.spec.*",
      "server/src/extensions/session-notes/**",
    ],
    plugins: {
      hapi: {
        rules: {
          "no-uncataloged-route": noUncatalogedRoute,
        },
      },
    },
    rules: {
      "hapi/no-uncataloged-route": "error",
    },
  },
  {
    // Epic 0 (#2077) god-file regrowth guardrail — error at 1,500 lines for
    // in-scope TS/TSX under the four lint roots. Goal: prevent NEW god-files,
    // not a big-bang purge — existing over-threshold files carry a file-level
    // `eslint-disable max-lines` comment referencing #2077.
    //
    // Design ruling (D3, #2077): error@1500 only — no warn@800 tier. The stock
    // `max-lines` rule takes a single severity + single `max`, and two overlapping
    // flat-config blocks do NOT stack (the later fully overrides the earlier), so
    // "warn@800 AND error@1500" is not co-expressible without a plugin/custom rule.
    // See claudedocs/architecture-hotspot-review.md (Epic 0 addendum).
    files: [
      "web/src/**/*.{ts,tsx}",
      "server/src/**/*.{ts,tsx}",
      "cli/src/**/*.{ts,tsx}",
      "shared/**/*.{ts,tsx}",
      "gateway/src/**/*.{ts,tsx}",
    ],
    // Exclude test/spec files; `**/*.generated.*` is already globally ignored above.
    ignores: ["**/*.test.*", "**/*.spec.*"],
    rules: {
      "max-lines": [
        "error",
        { max: 1500, skipBlankLines: false, skipComments: false },
      ],
    },
  }
);
