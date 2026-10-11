// SPDX-License-Identifier: AGPL-3.0-only
// Disable Ink devtools in compiled binaries to avoid optional dependencies.
process.env.DEV = "false";

await import("./index");

export {};
