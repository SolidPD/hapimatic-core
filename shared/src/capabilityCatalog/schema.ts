// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Capability-catalog zod v4 schema + `defineCapability` (issue #3741, Task 3 /
 * R1, R2, R6, R8, R9).
 *
 * Built with `z.strictObject` (unknown keys rejected): #3752 feeds untrusted
 * extension JSON through this schema and the repo's security-shaped schemas are
 * deliberately strict (`harnessManifest.ts`, `systemJobs.ts`). `shared/CLAUDE.md`'s
 * standing "always add `.passthrough()`" rule is for forward-compatible external
 * upstream payloads and does NOT apply here (ER 2026-09-16 3741-10).
 *
 * Emits NO JSON Schema (R7 / KD-4): a wire-schema export is deliberately dropped
 * for want of any consumer (#3743's generator and #3752's loader both validate
 * with the ZOD schema below). If B/C/K later need one, emit it THEN with an input
 * IO mode and `.regex()`-expressible checks (a `.superRefine` id-prefix rule
 * cannot survive into JSON Schema).
 */
import { z } from "zod";
import { RiskTierSchema } from "../riskTier";
import { DOMAIN_SLUGS } from "./domains";
import type { CatalogEntry } from "./types";

/**
 * Plain-text allowlist (R6) applied to EVERY string the entry carries. Rejects
 * control characters, `<`, `>`, and markdown-link syntax `](` in a SINGLE regex
 * so the constraint survives into a JSON-Schema `pattern` if a consumer later
 * emits one — a `.refine()` predicate would silently drop out (R7 / KD-4), which
 * is why R6 mandates `.regex()` rather than the repo's `.refine()`-based
 * `noControlChars` helper.
 *
 *   ^(?![\s\S]*\]\()          — no `](` (markdown link) anywhere in the string
 *   [^\u0000-\u001f\u007f<>]*$ — every char is printable and not `<` or `>`
 */
const PLAIN_TEXT_RE = /^(?![\s\S]*\]\()[^\u0000-\u001f\u007f<>]*$/;

/**
 * Strict slug shape for `id` (R6): dotted, lowercase-alphanumeric, hyphen-joined
 * segments — e.g. `session-lifecycle.spawn`, `ui.new-session`. No leading/trailing
 * or doubled separators, no uppercase, no other punctuation.
 */
const ID_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

/**
 * Strict identifier shape for `owner` (R6): a handle / team / `org/team` slug —
 * `@MattStarfield`, `platform-team`, `matt.starfield`, `org/team`. No spaces.
 */
const OWNER_RE = /^[a-zA-Z0-9@][a-zA-Z0-9._/-]*$/;

/** A plain-text string field: max length + the R6 allowlist, both field-named. */
function plainText(field: string, max: number) {
  return z
    .string()
    .max(max, `${field} exceeds ${max} characters`)
    .regex(
      PLAIN_TEXT_RE,
      `${field} must be plain text (no control characters, '<', '>', or markdown-link '](')`
    );
}

/**
 * Invocation discriminated union — one strict arm per surface, each carrying only
 * the coordinate(s) that surface needs; every string member hardened to ≤200 (R6).
 */
const invocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("rest"),
    method: plainText("invocation.method", 200),
    path: plainText("invocation.path", 200),
  }),
  z.strictObject({
    kind: z.literal("rpc"),
    method: plainText("invocation.method", 200),
  }),
  z.strictObject({
    kind: z.literal("mcp"),
    tool: plainText("invocation.tool", 200),
  }),
  z.strictObject({
    kind: z.literal("cli"),
    command: plainText("invocation.command", 200),
  }),
  z.strictObject({
    kind: z.literal("ui"),
    location: plainText("invocation.location", 200),
  }),
]);

/**
 * Declarative availability predicate (R5). Every axis optional EXCEPT `scope`,
 * which is REQUIRED with NO `.default()` (R9 / ER D4) — a default would be
 * fail-open, silently disclosing the operator surface to a tenant session.
 */
const availabilitySchema = z.strictObject({
  launcherKind: plainText("availability.launcherKind", 64).optional(),
  agentId: plainText("availability.agentId", 64).optional(),
  nodeCapability: plainText("availability.nodeCapability", 120).optional(),
  accountBound: z.boolean().optional(),
  scope: z.enum(["operator", "user"]),
  minVersion: plainText("availability.minVersion", 32).optional(),
  mountedWhen: plainText("availability.mountedWhen", 120).optional(),
});

/**
 * The canonical catalog-entry schema. `domain` is `z.enum(DOMAIN_SLUGS)` and
 * `riskTier` is the imported canonical `RiskTierSchema` (never a re-spelled
 * `z.enum([...])`). Machine hints take their documented defaults (R9); the
 * id-prefix rule (R2) is a `.superRefine` naming both `id` and `domain`.
 */
export const catalogEntrySchema = z
  .strictObject({
    id: plainText("id", 128).regex(
      ID_RE,
      "id must be a dotted lowercase slug, e.g. 'domain.name'"
    ),
    domain: z.enum(DOMAIN_SLUGS),
    surface: z.enum(["rpc", "rest", "mcp", "cli", "ui"]),
    description: plainText("description", 200),
    whenToUse: plainText("whenToUse", 160),
    invocation: invocationSchema,
    // `hmac` (issue #3746 F.1): the GitHub-webhook route's request-body signature
    // mode — kept in lockstep with the `Auth` type in types.ts.
    auth: z.enum(["jwt", "cli-token", "federation-token", "none", "hmac"]),
    riskTier: RiskTierSchema,
    availability: availabilitySchema,
    probe: z.enum(["safe", "skip"]).default("safe"),
    telemetry: z.enum(["sampled", "off"]).default("sampled"),
    trusted: z.boolean().default(true),
    owner: plainText("owner", 120)
      .regex(OWNER_RE, "owner must be an identifier/slug (no spaces)")
      .optional(),
    example: plainText("example", 600).optional(),
    since: plainText("since", 32).optional(),
  })
  .superRefine((entry, ctx) => {
    const prefix = entry.id.split(".")[0];
    if (prefix !== entry.domain) {
      ctx.addIssue({
        code: "custom",
        message: `id "${entry.id}" must be prefixed with its domain: the segment before the first "." ("${prefix}") does not equal domain "${entry.domain}"`,
        path: ["id"],
      });
    }
  });

/**
 * Identity helper (R8). Validates `entry` against `catalogEntrySchema` on EVERY
 * call, UNCONDITIONALLY — no `NODE_ENV` / `import.meta` guard (ER D13a / KD-5),
 * and this module NEVER reads `process.env` (`shared/` ships to the browser and
 * documents a no-`process.env` contract). Returns the ORIGINAL literal `entry`
 * (a passthrough, NOT the parse result) so Sub-Issue C's AST generator extracts
 * the untouched object (KD-3). Corollary: a consumer validating UNTRUSTED input
 * (#3752) must use `catalogEntrySchema.parse(x)`'s RESULT — strict-mode key
 * stripping never reaches this passthrough return.
 */
export function defineCapability(entry: CatalogEntry): CatalogEntry {
  catalogEntrySchema.parse(entry);
  return entry;
}
