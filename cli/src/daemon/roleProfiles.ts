// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #2155 — Role-scoped `@`-include profile resolution.
 *
 * A session's ROLE (pm/worker/researcher/closer/interactive) resolves to a
 * settings file whose `claudeMdExcludes` trims the instruction stack that role
 * never uses. The daemon threads the role through the spawn path (like
 * `safeMode`); `runClaude` calls {@link resolveProfileExcludes} at hook-settings
 * generation time and MERGES the returned excludes into the single `--settings`
 * file every launcher already delivers (ruling D3).
 *
 * 🔴 R3 (fail-open to the FULL stack) is implemented HERE and nowhere else. Any
 * ambiguity — absent role, unknown role, `interactive`, a missing/broken
 * profile file — resolves to `null` / `[]`, which means the spawner merges no
 * excludes and the session loads the complete stack. A session that is MISSING
 * context fails silently, which is worse than paying the full context tax; the
 * asymmetry is deliberate. `interactive` is intentionally absent from
 * {@link PROFILE_ROLES} so a user-opened session always gets the full stack.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@/ui/logger";

/**
 * The roles that map to a profile file. `interactive` is intentionally EXCLUDED
 * → it resolves to `null` → full stack (an interactive session is never scoped).
 */
export const PROFILE_ROLES = ["pm", "worker", "researcher", "closer"] as const;

const PROFILE_ROLE_SET: ReadonlySet<string> = new Set(PROFILE_ROLES);

/** Absolute path of the directory holding the role profile settings files. */
export function defaultProfilesDir(): string {
  return join(homedir(), ".claude", "profiles");
}

/**
 * Resolve a role to the absolute path of its profile settings file, or `null`
 * for an absent / unknown / `interactive` role, or a known role whose file does
 * not exist on disk (a missing profile file must degrade to the full stack,
 * never to a broken launch). `profilesDir` is injectable for tests.
 */
export function resolveProfile(
  role?: string,
  profilesDir: string = defaultProfilesDir()
): string | null {
  if (!role) return null; // absent → full stack
  if (!PROFILE_ROLE_SET.has(role)) return null; // unknown / interactive → full stack
  const path = join(profilesDir, `${role}.settings.json`);
  if (!existsSync(path)) {
    logger.warn(
      `[roleProfiles] profile file for role "${role}" not found at ${path} — falling back to the FULL stack`
    );
    return null;
  }
  return path;
}

/**
 * Resolve a role to the `claudeMdExcludes` array from its profile settings
 * file, or `[]` on any failure (absent/unknown role, missing file, unreadable
 * file, malformed JSON, or a non-string-array `claudeMdExcludes`). This is the
 * value {@link runClaude} merges into the generated hook-settings file. Empty
 * array → no excludes merged → full stack.
 */
export function resolveProfileExcludes(
  role?: string,
  profilesDir: string = defaultProfilesDir()
): string[] {
  const path = resolveProfile(role, profilesDir);
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const excludes = parsed?.claudeMdExcludes;
    if (
      Array.isArray(excludes) &&
      excludes.every((e: unknown) => typeof e === "string")
    ) {
      return excludes as string[];
    }
    logger.warn(
      `[roleProfiles] profile "${role}" (${path}) has no valid string[] claudeMdExcludes — falling back to the FULL stack`
    );
    return [];
  } catch (err) {
    logger.warn(
      `[roleProfiles] failed to read/parse profile "${role}" (${path}): ${err} — falling back to the FULL stack`
    );
    return [];
  }
}
