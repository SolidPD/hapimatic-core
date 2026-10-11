# Contributing to Hapimatic

Thank you for your interest in contributing to Hapimatic's open core.

## Contributor License Agreement (required)

Hapimatic accepts outside contributions **only under a Contributor License Agreement (CLA)** —
individual and corporate. This is so the project retains the option to offer the core under a
commercial license in the future.

**The CLA-signing process is not live yet.** When it is, the CLA document and an automated
CLA-signing check will be linked here, and that check will be required on every pull request. Until
then, outside pull requests cannot be merged: we will keep them open or close them with a note, and
welcome them back once the check is live.

## How contributions become releases

This repository is a **generated export** of a canonical source tree, so the contribution flow is
slightly different from a typical repo:

1. Open a pull request here. It is reviewed in this repository.
2. Once approved (and CLA-signed), the change is integrated into the canonical source tree with your
   authorship preserved.
3. The change then appears in the **next release export** published to this repository and tagged
   `v<VERSION>`.

Because the repository is generated, **direct pushes to the default branch are overwritten by the
next export** — all changes must arrive as reviewed pull requests that are integrated upstream.

## Ground rules

- Keep pull requests focused and describe the motivation.
- Match the existing code style; run the build (`bun run build:single-exe`) before submitting.
- By contributing, you agree your contribution is licensed under the project's AGPL-3.0 license and
  covered by the CLA above.
