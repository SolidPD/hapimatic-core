// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the `tenant` export profile (issue #4373, R2).
 *
 * A hosted customer takes their own customizations to another machine (a local
 * Core install). The tenant profile is the definitions-only export (`full`, the
 * default, unchanged) PLUS the auto-memory Claude Code keeps beside each
 * project's transcripts, MINUS every plugin descriptor whose marketplace is the
 * licensed premium one. It is an allowlist: the surfaces are the same fixed set
 * the full export collects, so premium pack FILES (under `~/.claude/plugins/`)
 * and platform secrets never enter it, and memory adds only
 * `projects/<key>/memory/**`, never the transcripts beside it.
 *
 * Who picks the profile: neither export script knows where it will run. Both
 * are minted by the DESTINATION (the one-liner and the Download/Copy script), so
 * they read the source machine's own markers at run time and force `tenant` on
 * a tenant VM (K13, `../vmClass`), whatever profile was minted.
 *
 * NODE-FREE: constants and pure helpers only.
 */
import { z } from "zod";

/** The export profiles. `full` is the definitions-only export every Core has. */
export const PORTER_EXPORT_PROFILES = ["full", "tenant"] as const;
export type PorterExportProfile = (typeof PORTER_EXPORT_PROFILES)[number];
export const PorterExportProfileSchema = z.enum(PORTER_EXPORT_PROFILES);

/**
 * The licensed premium marketplace's names. Provisional until #3989 publishes
 * the marketplace identity: the L2 tier is `hapimatic-premium` (product map
 * decision 17; the K19 parity fixture
 * `infrastructure/cloud-vm/fixtures/l2_plugins.example.json`).
 */
export const PREMIUM_MARKETPLACE_NAMES: readonly string[] = [
  "hapimatic-premium",
];

/**
 * A marketplace `source` served by the hosted premium marketplace (#3989 D1:
 * `https://hapimatic.com/plugin-marketplace/marketplace.json`), on the apex or a
 * subdomain. Canonical regex source, the same in jq, grep -E and .NET.
 */
export const PREMIUM_MARKETPLACE_SOURCE_PATTERN =
  "^https?://([A-Za-z0-9-]+\\.)*hapimatic\\.com(:[0-9]+)?/plugin-marketplace/";

/** Is this marketplace the licensed premium one (by name or by its source)? */
export function isPremiumMarketplace(
  name: string,
  source?: string | null
): boolean {
  if (PREMIUM_MARKETPLACE_NAMES.includes(name)) return true;
  return (
    typeof source === "string" &&
    new RegExp(PREMIUM_MARKETPLACE_SOURCE_PATTERN, "i").test(source)
  );
}

/**
 * The omission a tenant export records when it drops premium descriptors, and
 * the reason the importer records when it skips one. A premium pack is
 * installed only through the entitlement-checked channel (#3991), never by an
 * import: on a Core install it runs only when an SPD administrator has
 * registered that instance and it activates online.
 */
export const PREMIUM_REQUIRES_ACTIVATION_REASON =
  "premium-requires-activation" as const;
export const TENANT_PREMIUM_OMISSION = {
  surface: "plugins",
  reason: PREMIUM_REQUIRES_ACTIVATION_REASON,
} as const;

/** The archive folder the tenant profile stages auto-memory under: `memory/<project key>/…`. */
export const MEMORY_ARCHIVE_DIR = "memory";

/**
 * The omission a memory file or folder gets when it is a symbolic link. Memory
 * is copied as it is; a link would reach outside it.
 */
export const MEMORY_LINK_OMISSION_REASON =
  "symbolic link in memory, not exported";

/**
 * The omission a project gets when its `projects/<key>` folder is itself a
 * symbolic link: the exporters never follow it, so its memory is not exported,
 * and the user is told rather than finding it missing after the import.
 */
export const MEMORY_PROJECT_LINK_OMISSION_REASON =
  "project folder is a symbolic link, its memory is not exported";

/**
 * The omission the importer records for a memory entry whose project is not at
 * the destination (Claude Code would never read it there).
 */
export const MEMORY_PROJECT_ABSENT_REASON =
  "not imported: project not present here";

/**
 * The project key Claude Code derives from a folder: every character that is
 * not an ASCII letter or digit becomes `-` (`cli/src/claude/utils/path.ts`,
 * `server/src/sync/transcript/transcriptPath.ts`). Pure: the caller resolves
 * the path first.
 */
export function projectKeyForPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Remap a SOURCE project key to the destination: when the key starts with the
 * source home's key at a part boundary, swap that prefix for the destination
 * home's key (`-home-ubuntu-projects-x` → `-Users-me-projects-x`). Any other
 * key is returned unchanged. Project keys lose their separators, so this is a
 * best effort; the importer writes only into a project folder that exists.
 */
export function remapProjectKey(
  key: string,
  sourceHomeKey: string,
  destHomeKey: string
): string {
  if (sourceHomeKey === "" || sourceHomeKey === destHomeKey) return key;
  if (key === sourceHomeKey) return destHomeKey;
  if (key.startsWith(sourceHomeKey + "-")) {
    return destHomeKey + key.slice(sourceHomeKey.length);
  }
  return key;
}

/** One project's memory folder in the archive. */
export const MemoryEntrySchema = z.object({
  /** The SOURCE project key (`projects/<key>/memory` on the source machine). */
  projectKey: z.string().min(1),
  /** Archive-relative folder, `memory/<projectKey>`. */
  path: z.string().min(1),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

/** The manifest's `memory` section (tenant profile only). */
export const MemorySectionSchema = z.object({
  /** The project key of the source machine's home folder, for {@link remapProjectKey}. */
  sourceHomeKey: z.string().default(""),
  entries: z.array(MemoryEntrySchema).default([]),
});
export type MemorySection = z.infer<typeof MemorySectionSchema>;
