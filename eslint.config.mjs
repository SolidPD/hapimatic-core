import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
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
