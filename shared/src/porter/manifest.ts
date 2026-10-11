// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the portable-configuration manifest schema
 * (epic #2339, Sub-Issue A, issue #2340).
 *
 * This is the contract every other porter sub-issue reads or writes:
 *   - #2342 (generator) produces an archive whose `manifest.json` validates here.
 *   - #2343 (server/Bun import endpoint) parses an archive against this schema.
 *   - #2344 (web/browser Admin page) validates a manifest CLIENT-SIDE.
 *
 * Because #2344 imports it into the browser bundle, this module is kept
 * ZOD-ONLY and Node-free (R7) — no `node:fs`/`node:path`/`node:os`. The
 * filesystem SCAN that produces an archive lives in the CLI/server (Bun)
 * packages, never here. Precedent + constraint: `shared/src/ext/fsManifest.ts`.
 *
 * Portable-surface authority (R2, R6): the enumerations below are DERIVED from
 * this repo's existing, verified authority — `USER_SCOPE_CONFIG_DIMS` and its
 * per-dimension docblock in `@hapi/protocol/accountConfigDims`
 * (`shared/src/accountConfigDims.ts`, lifted there by #3246; verified against
 * Claude Code's own config-root resolution during #1562) — not invented here.
 */
import { z } from "zod";

import {
  ARCHIVE_FORMAT,
  PORTER_SCHEMA_VERSION,
  SUPPORTED_PORTER_SCHEMA_VERSIONS,
  type SupportedPorterSchemaVersion,
} from "./version";
// #3448 (Sub C, K10): the multi-source discovery table — the source-id enum for
// the optional per-entry `source?` tag and the `sources[]` metadata record shape.
// `sources.ts` imports only `zod`, so this stays a one-way dependency (no cycle).
import { PORTER_SOURCE_IDS, SourceRecordSchema } from "./sources";

// Re-export the container/version constants so a single import of
// `@hapi/protocol/porter` gives a consumer everything it needs.
export {
  ARCHIVE_FORMAT,
  PORTER_SCHEMA_VERSION,
  SUPPORTED_PORTER_SCHEMA_VERSIONS,
};

/* ────────────────────────────────────────────────────────────────────────
 * Task 2 — Portable surface enumeration + deliberate exclusions (R2, R6)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The filesystem config dimensions the manifest carries as archive members.
 * A SUBSET of `USER_SCOPE_CONFIG_DIMS`
 * (`@hapi/protocol/accountConfigDims`) — the plainly-configuration
 * dimensions, minus `plugins`/`projects` (both non-portable, see
 * {@link NON_PORTABLE_DIMENSIONS}) and minus `settings.json` handled as the
 * bounded {@link PortableSettingsSchema} object rather than a raw file.
 *
 * NOTE: `hooks`, `mcpServers`, and the plugin descriptor are deliberately NOT
 * here — they are structured manifest members (extracted data), not
 * `~/.claude/<dim>` directories. See their schemas below.
 */
export const PORTABLE_DIMENSIONS = [
  "skills",
  "agents",
  "commands",
  "rules",
  "output-styles",
  "CLAUDE.md",
  "settings.json",
] as const;

/** A portable filesystem dimension name. */
export type PortableDimension = (typeof PORTABLE_DIMENSIONS)[number];

/**
 * Configuration surfaces that are deliberately NOT portable, each with the
 * reason it is excluded (R6). The reasons are quoted verbatim from the verified
 * authority so the archive-layout doc (`config-porter-archive.md`, Task 7) and
 * this schema cite ONE source. Widening portability by removing an entry here
 * requires re-verifying the cited claim.
 */
export const NON_PORTABLE_DIMENSIONS = [
  {
    surface: "projects/",
    reason:
      "Session transcripts, not configuration. accountConfigDir.ts:238-240 " +
      "describes it as the shared host transcript tree — it is history, is " +
      "unbounded in size, and is private.",
  },
  {
    surface: ".credentials.json",
    reason:
      "OAuth credentials. accountConfigDir.ts:225-228: deliberately absent " +
      "from the dims list because native writes the bound account's identity " +
      "+ rotated token to it.",
  },
  {
    surface: ".claude.json (whole file)",
    reason:
      "accountConfigDir.ts:225-228: symlinking .claude.json would overwrite " +
      "the host's oauthAccount — catastrophic. MCP servers live INSIDE this " +
      "file, so the manifest extracts the MCP section as first-class data " +
      "(see McpServerEntrySchema) and never carries the file.",
  },
  {
    surface: "plugins/ (payload bytes)",
    reason:
      "Installed plugin bundles are third-party content with their own " +
      "provenance; the manifest carries a plugin DESCRIPTOR " +
      "(PluginDescriptorSchema) — marketplaces + name@marketplace identifiers " +
      "— not the bytes. Reconstituting the bytes is install execution, owned " +
      "by Sub-Issue G (#2465).",
  },
] as const;

/** A deliberately non-portable surface name. */
export type NonPortableSurface =
  (typeof NON_PORTABLE_DIMENSIONS)[number]["surface"];

/* ────────────────────────────────────────────────────────────────────────
 * Shared config-member shapes
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A named config member carried as an archive path — one skill/agent/command/
 * rule/output-style. `path` is the archive-relative location (e.g.
 * `"skills/issue-worker"`); `name` is the dimension entry name. Strip mode
 * (`z.object`, not `z.strictObject`) so a forward-compatible archive carrying an
 * extra field still parses.
 */
export const ConfigEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  /**
   * #3448 (Sub C, D3(a)): optional provenance tag naming which source this entry
   * came from. Strip-mode + `.optional()`, so a pre-C archive (no tag) still
   * parses; a missing tag is read as `"claude-code"` downstream. Metadata only —
   * the entry is imported from the top-level array regardless of `source`.
   */
  source: z.enum(PORTER_SOURCE_IDS).optional(),
});
export type ConfigEntry = z.infer<typeof ConfigEntrySchema>;

/**
 * The `CLAUDE.md` member. `CLAUDE.md` routinely `@`-includes sibling files
 * (`@RULES.md`, `@TOOLS.md`, …) that belong to no dimension — a `CLAUDE.md`
 * carried WITHOUT them imports as a file referencing missing includes (the same
 * dead-reference failure R4 guards against for hooks). So the member carries the
 * file PLUS its `@`-included siblings (config by construction).
 */
export const ClaudeMdMemberSchema = z.object({
  path: z.string().min(1),
  /** Archive-relative paths of the `@`-included sibling files. */
  includes: z.array(z.string().min(1)).default([]),
});
export type ClaudeMdMember = z.infer<typeof ClaudeMdMemberSchema>;

/**
 * Kebab-case name shape for plugin names AND marketplace names. Rejects a
 * leading `-`, whitespace, an embedded `@`, and uppercase — the argv-injection
 * vectors (epic #2339 F-2, #2465 expert review). Downstream consumers interpolate
 * these fields into `claude plugin install <name>@<marketplace>` argv (#2465) and
 * into an emitted remediation command list (#2343); a leading-dash `name` is
 * parsed as a FLAG by commander (a help-triggering token can even exit 0 and be
 * recorded as a false "installed"). This schema is the single owner of the
 * contract, so #2343/#2465 import {@link PLUGIN_NAME_PATTERN} rather than
 * re-deriving it.
 */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const kebabName = z
  .string()
  .regex(
    PLUGIN_NAME_PATTERN,
    "must be lowercase kebab-case (no leading dash, whitespace, or @)"
  );

/**
 * True when `ref` is git-commit-SHA-shaped (7-40 hex chars). A `#<ref>` pin
 * suffix on a marketplace source may name a branch/tag REF but NOT a SHA
 * (#2465 F-10 — marketplace sources support a ref, not a sha).
 */
function looksLikeSha(ref: string): boolean {
  return /^[0-9a-fA-F]{7,40}$/.test(ref);
}

/**
 * Validate a marketplace `source`: an `owner/repo` shorthand OR a git URL
 * (`https://`, `http://`, `git://`, `ssh://`, or scp-like `git@host:path`), with
 * an OPTIONAL `#<ref>` pin suffix. A branch/tag ref is allowed; a
 * commit-SHA-shaped ref, an empty ref, whitespace, and a leading `-` are all
 * rejected (epic #2339 F-2 / F-10). Exported so #2343/#2465 validate identically
 * against this single-owner contract.
 */
export function isValidMarketplaceSource(source: string): boolean {
  if (source.length === 0 || /\s/.test(source)) return false;
  let base = source;
  const hashIdx = source.indexOf("#");
  if (hashIdx !== -1) {
    base = source.slice(0, hashIdx);
    const ref = source.slice(hashIdx + 1);
    if (ref.length === 0 || ref.includes("#") || looksLikeSha(ref))
      return false;
  }
  const ownerRepo = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const gitUrl = /^(?:https?|git|ssh):\/\/[^\s#]+$/;
  const scpLike = /^git@[^\s:#]+:[^\s#]+$/;
  return ownerRepo.test(base) || gitUrl.test(base) || scpLike.test(base);
}

const marketplaceSource = z
  .string()
  .refine(
    isValidMarketplaceSource,
    "must be owner/repo or a git URL, optionally with a #<ref> pin (ref yes, sha no)"
  );

/**
 * Plugin DESCRIPTOR — marketplaces + installed-plugin identifiers, NO payload
 * bytes (see {@link NON_PORTABLE_DIMENSIONS} `plugins/`). Populated from
 * `~/.claude/plugins/known_marketplaces.json` + `installed_plugins.json`.
 * Reconstitution (`claude plugin marketplace add` + `claude plugin install`) is
 * install execution — Sub-Issue G (#2465), not this schema.
 *
 * Name/source shapes are CONSTRAINED (not bare `z.string().min(1)`) because the
 * archive is hostile input (R5 designs for third-party producers) and these
 * fields reach argv downstream — epic #2339 F-2, the single-owner tightening.
 */
export const PluginDescriptorSchema = z.object({
  marketplaces: z.array(
    z.object({ name: kebabName, source: marketplaceSource })
  ),
  plugins: z.array(
    z.object({
      name: kebabName,
      marketplace: kebabName,
      version: z.string().optional(),
    })
  ),
});
export type PluginDescriptor = z.infer<typeof PluginDescriptorSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Task 3 — MCP servers with a separable secret unit (R3)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One MCP server definition — NON-SECRET fields only. MCP servers live inside
 * `~/.claude.json` (`cli/src/claude/utils/projectMcpConfig.ts:1-45`,
 * `server/src/sync/mcpConfigStore.ts:4-6`), the one file that must never be
 * ported wholesale — so the manifest carries them as extracted structured data.
 *
 * `envNames` / `headerNames` carry the KEY NAMES whose values are secret; the
 * values live in a separate archive member ({@link McpSecretBundleSchema}).
 * `transport` is an open string (stdio/sse/http/websocket and future kinds)
 * rather than a closed enum, to match the forward-compatible strip-mode design.
 *
 * CAVEAT (epic #2339 F8): `args` and `url` remain plain fields, but real MCP
 * configs pass tokens as CLI args (`--api-key <tok>`) or tokenized URLs — do NOT
 * assume they are secret-free. The `url` half is now addressed by a canonical
 * secret slot (#2793): a credential-bearing `url` VALUE moves into the secret
 * bundle under {@link URL_SECRET_SLOT} and the entry's {@link McpServerEntry.urlName}
 * names that slot, so the plaintext `url` is omitted and the import side (#2638)
 * reconstitutes it from `secrets[serverName][urlName]`. The `args` half is now
 * addressed by the same mechanism (#2809): a credential-bearing `args` ELEMENT
 * moves into the secret bundle under {@link argsSecretSlot} (`__args_<index>__`)
 * and the entry's {@link McpServerEntry.argsNames} names that slot, so the
 * plaintext element is replaced by an empty-string placeholder and the import
 * side reconstitutes it at its recorded index.
 */
export const McpServerEntrySchema = z
  .object({
    name: z.string().min(1),
    transport: z.string().min(1),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().min(1).optional(),
    /**
     * Names the secret-bundle key (canonically {@link URL_SECRET_SLOT} = `"__url__"`)
     * whose value is this server's FULL credential-bearing `url`. When present, the
     * plaintext `url` above is omitted from the manifest and the import side
     * reconstitutes it from `secrets[serverName][urlName]` (#2793 emits; #2638
     * consumes). A non-credential `url` carries no `urlName`.
     */
    urlName: z.string().min(1).optional(),
    /**
     * Names the secret-bundle key(s) (canonically {@link argsSecretSlot}, e.g.
     * `"__args_3__"`) whose values are this server's FULL credential-bearing
     * `args` ELEMENTS. Each `{ index, name }` records WHICH array position is
     * secret; when present that `args[index]` is an empty-string placeholder in
     * the manifest and the import side reconstitutes it from
     * `secrets[serverName][name]` at that index (#2809 emits; #2809 consumes).
     * A non-credential `args` carries no `argsNames`.
     */
    argsNames: z
      .array(
        z.object({
          index: z.number().int().nonnegative(),
          name: z.string().min(1),
        })
      )
      .optional(),
    /** Key names of secret HTTP headers (values live in the secret bundle). */
    headerNames: z.array(z.string().min(1)).optional(),
    /** Key names of secret env vars (values live in the secret bundle). */
    envNames: z.array(z.string().min(1)).optional(),
    disabled: z.boolean().optional(),
    /**
     * #3448 (Sub C, D3(a)): optional provenance tag — which source (Claude Code /
     * Cursor / Claude Desktop) this server was discovered in. Strip-mode +
     * `.optional()`: a pre-C server drops it silently; a missing tag reads as
     * `"claude-code"` when the review panel groups by source. Metadata only — a
     * tagged server imports through the SAME definitions-only pipeline [D3(a)].
     */
    source: z.enum(PORTER_SOURCE_IDS).optional(),
  })
  /**
   * Index integrity for the args secret slots (#2809, resolves OR2). The schema
   * is the single validation owner: reject a duplicate `index`, an `index` past
   * the end of `args` (the placeholder element must exist at that position), and
   * a duplicate `name` — either within `argsNames` or colliding with the server's
   * `envNames` / `headerNames` / `urlName` (the per-server bundle is ONE flat
   * `name → value` map, so a shared name silently aliases two slots). The import
   * side keeps a defense-in-depth bounds check (buildMcpServerConfig is called
   * directly by tests/other callers that bypass this parse). Precedent:
   * `shared/src/sessionName.ts` uses `.superRefine` for cross-field validation.
   */
  .superRefine((entry, ctx) => {
    if (!entry.argsNames || entry.argsNames.length === 0) return;
    const argsLen = entry.args?.length ?? 0;
    const seenIndex = new Set<number>();
    const seenName = new Set<string>();
    const otherNames = new Set<string>([
      ...(entry.envNames ?? []),
      ...(entry.headerNames ?? []),
      ...(entry.urlName ? [entry.urlName] : []),
    ]);
    entry.argsNames.forEach((slot, i) => {
      if (slot.index >= argsLen) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["argsNames", i, "index"],
          message: `argsNames index ${slot.index} is out of range (args has ${argsLen} element(s))`,
        });
      }
      if (seenIndex.has(slot.index)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["argsNames", i, "index"],
          message: `duplicate argsNames index ${slot.index}`,
        });
      }
      seenIndex.add(slot.index);
      if (seenName.has(slot.name) || otherNames.has(slot.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["argsNames", i, "name"],
          message: `argsNames name "${slot.name}" collides with another secret slot name`,
        });
      }
      seenName.add(slot.name);
    });
  });
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

/** Archive member name for the PLAINTEXT secret bundle (pre-encryption). */
export const SECRETS_MEMBER_PLAINTEXT = "secrets.json" as const;
/** Archive member name for the ENCRYPTED secret bundle (#2341 `age` output). */
export const SECRETS_MEMBER_ENCRYPTED = "secrets.age" as const;

/**
 * Canonical secret-bundle key for a credential-bearing MCP server `url` (#2793).
 * The FULL url value lives at `secrets[serverName][URL_SECRET_SLOT]`; the manifest
 * entry's {@link McpServerEntry.urlName} names this slot so the import side (#2638)
 * reconstitutes `url` from it. Exported so the extraction prompt (#2342), the
 * schema, the tests, and the import side all share ONE literal instead of copies.
 */
export const URL_SECRET_SLOT = "__url__" as const;

/**
 * Canonical secret-bundle key PREFIX for a credential-bearing MCP server `args`
 * element (#2809, the args-side sibling of {@link URL_SECRET_SLOT}). A secret
 * `args[index]` moves to `secrets[serverName][__args_<index>__]`; the manifest
 * entry's {@link McpServerEntry.argsNames} names the slot(s), the plaintext
 * element is replaced by an empty-string placeholder, and the import side
 * reconstitutes it at that index. Exported so the extraction prompt (#2809), the
 * schema, the tests, and the import side all share ONE literal instead of copies.
 */
export const ARGS_SECRET_SLOT_PREFIX = "__args_" as const;

/**
 * The canonical args secret slot key for a given `args` index (index `3` →
 * `"__args_3__"`), mirroring {@link URL_SECRET_SLOT} for the positional `args`
 * case. Index-keyed because `args` is a positional array where more than one
 * element can be secret — a flat `argsName` string could not address which.
 */
export function argsSecretSlot(index: number): string {
  return `${ARGS_SECRET_SLOT_PREFIX}${index}__`;
}

/**
 * The secret bundle — a flat `serverName → { envOrHeaderKeyName: value }` map,
 * serialized to its OWN archive member ({@link SECRETS_MEMBER_PLAINTEXT}),
 * encrypted by #2341 to {@link SECRETS_MEMBER_ENCRYPTED}.
 *
 * This separability is what AC-3 demands and what lets the secret plaintext stay
 * OUT of model context: the bundle is a standalone member, so
 * `age -r <recipient> -o secrets.age secrets.json && rm -f secrets.json` runs as
 * a pure file→file shell command with no manifest parsing (`-r` = inline
 * recipient string; `-R` = recipients FILE — in-repo precedent uses `-r`).
 *
 * Zod v4: `z.record(keySchema, valueSchema)` is the two-arg form.
 */
export const McpSecretBundleSchema = z.record(
  z.string().min(1),
  z.record(z.string().min(1), z.string())
);
export type McpSecretBundle = z.infer<typeof McpSecretBundleSchema>;

/**
 * Pure helper: the secret KEY NAMES per server, so #2342's prompt generator can
 * tell the user's local Claude WHICH names to harvest without ever handling a
 * value. Returns only servers that declare at least one secret field name.
 *
 * The url secret slot ({@link McpServerEntry.urlName}, canonically
 * {@link URL_SECRET_SLOT}) is enumerated alongside env/header names (#2793) so a
 * single call names EVERY secret slot a server carries — the import side (#2638)
 * uses this as the one authority for its post-import secret-slot completeness
 * check (env values AND `__url__`), verified by key presence, never by value.
 */
export function collectSecretFieldNames(input: {
  mcpServers?: readonly McpServerEntry[];
}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const server of input.mcpServers ?? []) {
    const names = new Set<string>();
    for (const n of server.envNames ?? []) names.add(n);
    for (const n of server.headerNames ?? []) names.add(n);
    if (server.urlName) names.add(server.urlName);
    for (const a of server.argsNames ?? []) names.add(a.name);
    if (names.size > 0) out[server.name] = [...names];
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * Task 4 — Hooks as an indivisible two-half entry (R4, the load-bearing req)
 * ──────────────────────────────────────────────────────────────────────── */

/** The hook file half — its archive path and optional POSIX mode bits. */
export const HookFileSchema = z.object({
  path: z.string().min(1),
  mode: z.number().int().optional(),
});

/**
 * The hook `settings.json` registration half. `events` is a non-empty array of
 * OPEN strings (not a closed `z.enum`): the documented Claude Code lifecycle
 * event set is large and moves, so a closed list decays into false rejections.
 * Unknown events VALIDATE fine and are surfaced by {@link collectUnknownHookEvents}.
 * `matcher` is optional — matcher-less hooks are real.
 */
export const HookRegistrationSchema = z.object({
  events: z.array(z.string().min(1)).min(1),
  matcher: z.string().min(1).optional(),
  command: z.string().min(1),
  timeout: z.number().int().optional(),
});

/**
 * A hook entry — ONE object with BOTH halves REQUIRED. A file-without-
 * registration (dead code) or registration-without-file (dangling command) is
 * therefore UNREPRESENTABLE in the type and fails at parse, not at a downstream
 * lint — the distinction AC-4 asks for ("invalid per the schema, not merely
 * discouraged"). This mirrors the bidirectional drift class rp1-home#624's
 * registration validator exists to catch: file-without-registration AND
 * registration-without-file are both failure modes.
 */
export const HookEntrySchema = z.object({
  file: HookFileSchema,
  registration: HookRegistrationSchema,
});
export type HookEntry = z.infer<typeof HookEntrySchema>;

/**
 * Subdirectories under `hooks/` that hold shared utility modules a hook IMPORTS
 * (e.g. `from lib.header_match import ...`), NOT registered hooks (#2639 / F9).
 * These two subtrees are carried as DIRECTORY `hookSupport` entries
 * (`{name:"lib", path:"hooks/lib"}`), so the whole subtree lands PATH-PRESERVED
 * via the `planDimension` prefix-matcher.
 *
 * #3590: the export now archives the WHOLE `~/.claude/hooks/**` tree (minus the
 * exclusion sets below), not just these two subtrees — because on a
 * dispatcher-form host `settings.json` registers a single dispatcher while 100+
 * hooks load dynamically from a registry, so a registration-closure-only walk
 * shipped almost nothing (the P0 this issue fixes). Every hooks file that is NOT a
 * registered `hooks[]` script and NOT under these subtrees rides a PER-FILE
 * `hookSupport` entry (`{name:<basename>, path:"hooks/<rel>"}`); K1 keeps exactly
 * ONE manifest reference per staged file. The two directory entries here are still
 * emitted verbatim. The server-side validator's `NON_HOOK_DIRS` supersets the
 * exclusion set below.
 */
export const HOOK_SUPPORT_DIRS = ["lib", "_shared"] as const;
export type HookSupportDir = (typeof HOOK_SUPPORT_DIRS)[number];

/**
 * Subtrees + patterns pruned from the #3590 whole-`hooks/`-tree archive, ON TOP
 * OF {@link ARCHIVE_EXCLUSIONS} (`__pycache__/`, `*.log`, `state/`, `.git/`,
 * `node_modules/`, `cache/`). These are hooks-tree-specific noise a portable
 * archive must omit: the test suite (`tests/`), runtime sentinels + local caches
 * (`.sentinels/`, `.local/`, `.pytest_cache/`, `.ruff_cache/`), Claude-facing
 * working notes (`claudedocs/`), and editor backups (`*.bak-*`). Consumed by BOTH
 * emitters via `exportShared.HOOK_TREE_EXCLUSION_PATTERNS` so the bash and
 * PowerShell twins prune the same set — kept in lockstep because the per-entry
 * 10 MiB fail-closed cap ({@link ARCHIVE_LIMITS}) means a stray large `tests/`
 * fixture would reject the WHOLE archive. A trailing `/` marks a directory
 * pattern (stripped when rendered to a `tar --exclude` flag, exactly as
 * {@link ARCHIVE_EXCLUSIONS} is).
 */
export const HOOK_TREE_EXCLUSIONS = [
  "tests/",
  ".sentinels/",
  "claudedocs/",
  ".local/",
  ".pytest_cache/",
  ".ruff_cache/",
  "*.bak-*",
] as const;

/**
 * The hook lifecycle events this codebase actually registers
 * (`cli/src/claude/utils/generateHookSettings.ts:93-98`) plus the documented
 * Claude Code lifecycle event set. Used ONLY to flag unknown events as warnings
 * — never to reject them (`events` is an open string above).
 */
export const KNOWN_HOOK_EVENTS = [
  // Registered by this repo (generateHookSettings.ts:93-98).
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Notification",
  // Other documented Claude Code lifecycle events.
  "PreToolUse",
  "PostToolUse",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
] as const;

/** A hook event name known at authoring time. */
export type KnownHookEvent = (typeof KNOWN_HOOK_EVENTS)[number];

/**
 * The events across `entries` that are NOT in {@link KNOWN_HOOK_EVENTS},
 * deduplicated. The import report (#2343) and Admin UI (#2344) surface these as
 * warnings so an unrecognized-but-valid event is neither rejected nor silently
 * dropped.
 */
export function collectUnknownHookEvents(
  entries: readonly HookEntry[]
): string[] {
  const known = new Set<string>(KNOWN_HOOK_EVENTS);
  const unknown = new Set<string>();
  for (const e of entries) {
    for (const ev of e.registration.events) {
      if (!known.has(ev)) unknown.add(ev);
    }
  }
  return [...unknown];
}

/** One `settings.json` `hooks.<Event>[]` matcher block. */
export interface SettingsHookMatcher {
  matcher?: string;
  hooks: { type: "command"; command: string }[];
}

/**
 * Serialize hook entries back to the EXACT `settings.json` structure
 * `generateHookSettings.ts:64-75` writes:
 * `hooks: { <Event>: [{ matcher, hooks: [{ type: "command", command }] }] }`.
 * #2343's import path composes `settings.json` from this rather than
 * re-deriving the shape. A matcher-less registration omits the `matcher` key.
 */
export function toSettingsHooksBlock(
  entries: readonly HookEntry[]
): Record<string, SettingsHookMatcher[]> {
  const block: Record<string, SettingsHookMatcher[]> = {};
  for (const e of entries) {
    for (const ev of e.registration.events) {
      const matcherEntry: SettingsHookMatcher = {
        hooks: [{ type: "command", command: e.registration.command }],
      };
      if (e.registration.matcher !== undefined) {
        matcherEntry.matcher = e.registration.matcher;
      }
      (block[ev] ??= []).push(matcherEntry);
    }
  }
  return block;
}

/**
 * Canonical portable home token. A hook `command` embeds an absolute config-root
 * path (`python3 /home/<user>/.claude/hooks/foo.py`); normalizing the source
 * home to this token keeps the command from being dead-on-arrival where the
 * destination user's home differs (epic #2339 F3).
 */
export const PORTABLE_HOME_TOKEN = "$HOME" as const;

/**
 * Normalize a hook command's config-root prefix to {@link PORTABLE_HOME_TOKEN}
 * on EXPORT (#2342). Replaces an explicit `sourceHome` prefix when given, and
 * generically rewrites `/home/<user>/.claude` and `~/.claude` → `$HOME/.claude`.
 */
export function normalizeHookCommand(
  command: string,
  sourceHome?: string
): string {
  let out = command;
  if (sourceHome) {
    out = out
      .split(`${sourceHome}/.claude`)
      .join(`${PORTABLE_HOME_TOKEN}/.claude`);
  }
  out = out.replace(
    /\/home\/[^/\s]+\/\.claude/g,
    `${PORTABLE_HOME_TOKEN}/.claude`
  );
  out = out.replace(/(^|\s)~\/\.claude/g, `$1${PORTABLE_HOME_TOKEN}/.claude`);
  return out;
}

/**
 * Expand a normalized hook command's {@link PORTABLE_HOME_TOKEN} (and a literal
 * `~`) to the destination `destHome` on IMPORT (#2343), BEFORE its command-path
 * existence check.
 */
export function denormalizeHookCommand(
  command: string,
  destHome: string
): string {
  let out = command
    .split(`${PORTABLE_HOME_TOKEN}/.claude`)
    .join(`${destHome}/.claude`);
  out = out.replace(/(^|\s)~\/\.claude/g, `$1${destHome}/.claude`);
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * Task 5 — Bounded settings subset, archive limits, top-level manifest (R1,R2,R5)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The CLOSED, explicitly-enumerated portable `settings.json` subset (R2). Modeled
 * as a `z.object` of NAMED optional keys — NOT `z.record` — so "explicitly
 * enumerated rather than open-ended" is enforced by the type. Strip mode drops
 * any un-enumerated key at parse; import (#2343/#2342) must REPORT the dropped
 * keys (`skippedSettingsKeys`), never silently discard them.
 *
 * The allowlist is vetted against the ACTUAL reader of an imported
 * `settings.json` — Claude Code (installed v2.1.220) — not this repo (epic #2339
 * F6; a "only the keys THIS repo reads" list would port ~0% of a real user's
 * settings). Reader of each key:
 *   env, model, cleanupPeriodDays, outputStyle, permissions,
 *   enableAllProjectMcpServers, apiKeyHelper, forceLoginMethod → `claude`
 *   includeCoAuthoredBy, statusLine, claudeMdExcludes → `claude` (+ read by Hapimatic)
 *
 * `hooks` is deliberately EXCLUDED — hooks are carried by `hooks[]` (Task 4);
 * carrying them twice would be a drift source.
 *
 * `env` needs care: its values can embed secrets (API keys). The schema CANNOT
 * distinguish a secret string from a non-secret one, so this is an EXTRACTOR
 * contract (#2342): a secret-valued env key must be redacted-and-reported
 * (`skippedSettingsKeys`) rather than carried plaintext here.
 */
export const PortableSettingsSchema = z.object({
  env: z.record(z.string().min(1), z.string()).optional(),
  model: z.string().min(1).optional(),
  includeCoAuthoredBy: z.boolean().optional(),
  cleanupPeriodDays: z.number().int().optional(),
  outputStyle: z.string().min(1).optional(),
  statusLine: z.record(z.string(), z.unknown()).optional(),
  permissions: z.record(z.string(), z.unknown()).optional(),
  enableAllProjectMcpServers: z.boolean().optional(),
  apiKeyHelper: z.string().min(1).optional(),
  forceLoginMethod: z.string().min(1).optional(),
  claudeMdExcludes: z.array(z.string().min(1)).optional(),
});
export type PortableSettings = z.infer<typeof PortableSettingsSchema>;

/** The enumerated portable settings keys (for reporting skipped keys, #2342). */
export const PORTABLE_SETTINGS_KEYS = [
  "env",
  "model",
  "includeCoAuthoredBy",
  "cleanupPeriodDays",
  "outputStyle",
  "statusLine",
  "permissions",
  "enableAllProjectMcpServers",
  "apiKeyHelper",
  "forceLoginMethod",
  "claudeMdExcludes",
] as const;

/**
 * The subset of {@link PORTABLE_SETTINGS_KEYS} whose VALUES Claude Code executes as
 * shell commands (#2565, F5). The import review MUST surface these values (not just the
 * key names) so a hostile archive cannot slip a command past a values-blind review:
 *   apiKeyHelper — a shell command string Claude Code runs to obtain an API key.
 *   statusLine   — an object whose `command` member Claude Code executes.
 *
 * 🔴 A future portable key that carries an executed command MUST be added here, or the
 * import review is values-blind to it again.
 *
 * #4173: the top-level script one of these values runs (`$HOME/.claude/<name>`)
 * travels in the manifest's `settingsScripts` member (rule: `./settingsScripts`).
 */
export const EXECUTABLE_SETTINGS_KEYS = ["apiKeyHelper", "statusLine"] as const;
export type ExecutableSettingsKey = (typeof EXECUTABLE_SETTINGS_KEYS)[number];

/**
 * #4173: one carried settings script, `{ path: "settings-scripts/<name>" }`
 * (archive-relative). See `PorterManifestSchema.settingsScripts`.
 */
export const SettingsScriptEntrySchema = z.object({
  path: z.string().min(1),
});
export type SettingsScriptEntry = z.infer<typeof SettingsScriptEntrySchema>;

/**
 * Extraction/decompression limits an external producer must respect and #2343
 * enforces at extraction. Bound tar/decompression bombs that the compressed cap
 * alone does not catch. Exported as constants so #2343 imports them rather than
 * re-deriving.
 */
export const ARCHIVE_LIMITS = {
  /** Total uncompressed size ceiling. */
  maxTotalUncompressedBytes: 200 * 1024 * 1024,
  /** Per-entry uncompressed size ceiling. */
  maxEntryUncompressedBytes: 10 * 1024 * 1024,
  /** Entry-count ceiling. */
  maxEntries: 5000,
  /** Compressed archive size ceiling. */
  maxCompressedBytes: 25 * 1024 * 1024,
  /** Refuse if total-uncompressed ÷ compressed exceeds this ratio. */
  maxDecompressionRatio: 100,
} as const;

/**
 * Paths excluded from ANY conforming archive (noise, caches, VCS). Documented in
 * the archive-layout doc (Task 7) so an external producer omits them. These are
 * junk, pruned SILENTLY by `tar --exclude`; credential-bearing names are a
 * separate list, {@link ARCHIVE_CREDENTIAL_NAMES}, because they must be recorded
 * as omissions and matched in any case.
 */
export const ARCHIVE_EXCLUSIONS = [
  "__pycache__/",
  "*.log",
  "state/",
  ".git/",
  "node_modules/",
  "cache/",
] as const;

/**
 * File and folder names that carry credentials, so no archive may carry them
 * (issue #4172). The exporters prune them after staging and record an omission;
 * the importer skips a section member whose path has such a part, and refuses a
 * planned file of any other kind that has one.
 *
 * Kept apart from {@link ARCHIVE_EXCLUSIONS} on purpose: that list is junk that
 * `tar --exclude` drops silently and case-sensitively, while a credential name
 * must never ship under a case variant (`.ENV`) and must be reported, because a
 * leaked secret cannot be recalled but an over-pruned file is visible and easy
 * to re-create.
 *
 * Source: the machine-path component list in `server/src/utils/pathSecurity.ts`
 * minus `.config` (a generic folder, not a credential store), plus the `.env.*`
 * family ({@link ARCHIVE_CREDENTIAL_PREFIXES}) and `.envrc`, `.pgpass` and
 * `.credentials.json` (the PM's #4172 ruling). Lowercase, exact names.
 */
export const ARCHIVE_CREDENTIAL_NAMES = [
  ".env",
  ".envrc",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".credentials.json",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".bash_history",
  ".zsh_history",
] as const;

/** Name prefixes that also mark a credential file (`.env.local`, `.env.production`). */
export const ARCHIVE_CREDENTIAL_PREFIXES = [".env."] as const;

/**
 * The first part of `relPath` that is a credential-bearing name, as written, or
 * `null`. Splits on both `/` and `\` and compares in lowercase, so `a/.ENV` and
 * `a\.npmrc` both match. Pure, so the importer, the emitters' tests and the
 * extraction prompt all apply the same rule.
 */
export function credentialPathPart(relPath: string): string | null {
  for (const part of relPath.split(/[\\/]/)) {
    const lower = part.toLowerCase();
    if (
      (ARCHIVE_CREDENTIAL_NAMES as readonly string[]).includes(lower) ||
      ARCHIVE_CREDENTIAL_PREFIXES.some(prefix => lower.startsWith(prefix))
    ) {
      return part;
    }
  }
  return null;
}

/** One deliberately-omitted surface reported by the producer (R6 at runtime). */
export const OmissionSchema = z.object({
  surface: z.string().min(1),
  reason: z.string().min(1),
});
export type Omission = z.infer<typeof OmissionSchema>;

/**
 * The well-known omission marker a **definitions-only** (secrets-free) archive
 * carries in `manifest.omissions[]` to declare, in-band, that it deliberately
 * ships NO secrets (issue #3245). The script-driven default export
 * ({@link buildExportScript}) writes exactly this entry; the import side's
 * definitions-only tolerance ({@link isDefinitionsOnlyManifest}) matches it to
 * distinguish "deliberately secrets-free" from "declares secrets but the
 * encrypted member went missing" — the former proceeds, the latter still
 * hard-rejects. Free-form `{surface, reason}` per {@link OmissionSchema}, so no
 * schema change is needed to introduce it.
 */
export const DEFINITIONS_ONLY_SECRETS_OMISSION = {
  surface: "secrets",
  reason: "definitions-only",
} as const;

/**
 * True when a manifest is a **definitions-only** archive: it carries NO `secrets`
 * member AND declares the {@link DEFINITIONS_ONLY_SECRETS_OMISSION} marker
 * (issue #3245). This is the ONE authority both the export script (which writes
 * the marker) and the import tolerance (which reads it) cite, so the two cannot
 * drift. Pure — reads only manifest fields, no I/O; safe to bundle for the
 * browser (R7). A manifest that declares secret SLOTS but carries neither a
 * `secrets` member nor this marker is NOT definitions-only (it is a genuine
 * missing-secrets error and must still hard-reject at import).
 */
export function isDefinitionsOnlyManifest(manifest: {
  secrets?: unknown;
  omissions?: readonly { surface: string; reason: string }[];
}): boolean {
  if (manifest.secrets != null) return false;
  return (manifest.omissions ?? []).some(
    o =>
      o.surface === DEFINITIONS_ONLY_SECRETS_OMISSION.surface &&
      o.reason === DEFINITIONS_ONLY_SECRETS_OMISSION.reason
  );
}

/**
 * Reference to the secret archive member. `member` is one of the two known
 * member names; `encrypted` says whether it is the `age`-encrypted form;
 * `recipient` is the age recipient the bundle was encrypted to (#2341).
 */
export const SecretsMemberRefSchema = z.object({
  member: z.enum([SECRETS_MEMBER_PLAINTEXT, SECRETS_MEMBER_ENCRYPTED]),
  encrypted: z.boolean(),
  recipient: z.string().min(1).optional(),
});
export type SecretsMemberRef = z.infer<typeof SecretsMemberRefSchema>;

/**
 * The top-level porter manifest (`manifest.json`). `schemaVersion` is validated
 * BEFORE shape (see {@link parsePorterManifest}) so an unsupported version is
 * rejected whole (R1). Array/settings members default so a parsed manifest is
 * always fully populated. Strip mode (`z.object`) drops unknown top-level keys
 * for forward compatibility.
 */
export const PorterManifestSchema = z
  .object({
    schemaVersion: z.string().min(1),
    generatedAt: z.string().min(1),
    generator: z.object({
      name: z.string().min(1),
      version: z.string().min(1),
    }),
    /**
     * #3239 (E4): the source machine's name — an OPTIONAL provenance label. Because
     * the manifest is strip-mode `z.object` (see :728-729) and this field is
     * `.optional()`, a pre-#3239 archive that omits it still validates: a
     * backward-compatible add with NO `schemaVersion` bump, on the same
     * `claudeMd` / `plugins` / `secrets` `.optional()` precedent. The VALUE is
     * supplied by the source agent (via `$(hostname)` in the extraction prompt,
     * Step 9) — this schema stays Node-free (R7) and never reads `node:os` here.
     */
    sourceMachine: z.string().min(1).optional(),
    skills: z.array(ConfigEntrySchema).default([]),
    agents: z.array(ConfigEntrySchema).default([]),
    commands: z.array(ConfigEntrySchema).default([]),
    rules: z.array(ConfigEntrySchema).default([]),
    outputStyles: z.array(ConfigEntrySchema).default([]),
    claudeMd: ClaudeMdMemberSchema.optional(),
    settings: PortableSettingsSchema.default({}),
    mcpServers: z.array(McpServerEntrySchema).default([]),
    hooks: z.array(HookEntrySchema).default([]),
    /**
     * #2639 (F9): hook-support subtrees ({@link HOOK_SUPPORT_DIRS}) that hooks
     * import but that carry no registration. Dimension-shaped `{ name, path }`
     * entries (path is archive-relative, e.g. `hooks/lib`) so import lands the
     * whole subtree PATH-PRESERVED via the same `planDimension` prefix-matcher the
     * dimensions use. `.default([])` keeps a pre-#2639 archive (no member) valid —
     * no `schemaVersion` bump needed.
     */
    hookSupport: z.array(ConfigEntrySchema).default([]),
    /**
     * #4173: the top-level scripts the two {@link EXECUTABLE_SETTINGS_KEYS}
     * values run, each `{ path: "settings-scripts/<name>" }`. The importer
     * trusts only the imported setting VALUES, never this path: it writes a
     * listed member only at the exact `<config root>/<name>` an imported value
     * names. `.default([])` keeps a pre-#4173 archive valid, with no
     * `schemaVersion` bump (the `hookSupport` precedent).
     */
    settingsScripts: z.array(SettingsScriptEntrySchema).default([]),
    plugins: PluginDescriptorSchema.optional(),
    omissions: z.array(OmissionSchema).default([]),
    secrets: SecretsMemberRefSchema.optional(),
    /**
     * #3448 (Sub C, K10): per-source discovery metadata — one {@link SourceRecord}
     * per source the export probed (`{id, found, counts}`). METADATA ONLY: importable
     * entries are NEVER nested under `sources[]` — they stay in the top-level arrays
     * with an optional `source` tag, so an old instance that ignores `sources`
     * still imports the full entry set (nesting would silently import a subset — the
     * exact failure the version gate exists to prevent). `.optional()` + strip-mode:
     * a pre-C archive with no `sources` still validates, no `schemaVersion` bump
     * (`"1.0.0"` stays — strip mode already accepts the add) [K10, 1B#36].
     */
    sources: z.array(SourceRecordSchema).optional(),
  })
  /**
   * #3448 (Sub C, D4(a)): a manifest must not carry two `mcpServers` with the
   * same `name`. The export dedupes cross-source by precedence
   * (`unique_by(.name)`), so a well-formed archive never collides; this parse-time
   * refine is the defense-in-depth backstop — the exclusion key IS the bare name
   * (`commitSelection.ts`), and a duplicate would alias two servers to one
   * checkbox / one merge target. Runs on the parsed object (defaults applied), so
   * `mcpServers` is always an array here.
   */
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.mcpServers.forEach((server, i) => {
      if (seen.has(server.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mcpServers", i, "name"],
          message: `duplicate mcpServers name "${server.name}" (the export dedupes by precedence; a manifest must not carry two servers with the same name)`,
        });
      }
      seen.add(server.name);
    });
  });
export type PorterManifest = z.infer<typeof PorterManifestSchema>;

/** Type guard: is `v` a schema version this instance can import? */
export function isSupportedSchemaVersion(
  v: unknown
): v is SupportedPorterSchemaVersion {
  return (
    typeof v === "string" &&
    (SUPPORTED_PORTER_SCHEMA_VERSIONS as readonly string[]).includes(v)
  );
}

/** Discriminated result of {@link parsePorterManifest}. */
export type ParsePorterManifestResult =
  | { ok: true; manifest: PorterManifest }
  | { ok: false; kind: "version_mismatch"; error: string }
  | { ok: false; kind: "invalid"; error: string };

/**
 * Parse a raw (JSON-decoded) value into a {@link PorterManifest}. NEVER throws.
 *
 * VERSION CHECK PRECEDES SHAPE CHECK (R1): if `schemaVersion` is missing or
 * unsupported, returns `version_mismatch` and runs NO field validation — so an
 * unsupported archive is rejected whole rather than "partially applied". Only a
 * supported version proceeds to full schema validation.
 */
export function parsePorterManifest(input: unknown): ParsePorterManifestResult {
  const version =
    typeof input === "object" && input !== null && "schemaVersion" in input
      ? (input as { schemaVersion?: unknown }).schemaVersion
      : undefined;

  if (!isSupportedSchemaVersion(version)) {
    return {
      ok: false,
      kind: "version_mismatch",
      error: `Unsupported porter schemaVersion ${JSON.stringify(
        version
      )}; this instance supports ${SUPPORTED_PORTER_SCHEMA_VERSIONS.join(", ")}.`,
    };
  }

  const parsed = PorterManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue && issue.path.length ? issue.path.join(".") : "(root)";
    return {
      ok: false,
      kind: "invalid",
      error: `invalid porter manifest at ${at}: ${
        issue?.message ?? "schema validation failed"
      }`,
    };
  }
  return { ok: true, manifest: parsed.data };
}
