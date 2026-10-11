// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL skill-projection compiler — SHA-pinned envelope acquisition (issue #3122,
 * Task 5 / KD4).
 *
 * Defines WHERE the SHA-pinned canonical envelopes + skill bodies come from at
 * spawn time, with three guarantees:
 *
 *   (a) SOURCE — a configured local canonical checkout (`settings
 *       .halCanonicalCheckoutPath`, the rp1-home companion tree that owns
 *       `.claude/skills/<name>/envelope.yaml` + the sibling SKILL.md).
 *   (b) CACHE — a content-addressed local cache under `<HAPI_HOME>`, keyed by the
 *       envelope's `skill_sha`, so a given skill body is parsed/read once per SHA
 *       and reused across spawns (determinism preserved; repeat spawns are pure
 *       fs reads).
 *   (c) FAILURE POLICY — on an unconfigured source, a missing checkout, or an
 *       unparseable envelope, acquisition returns `{ ok: false, unavailableReason }`
 *       and NEVER throws. The spawn proceeds WITHOUT projection and the provenance
 *       records the annotated reason (R2's spirit; never a hard spawn failure).
 *
 * 🔴 NO network on the daemon spawn hot path (KD4). This module reads ONLY the
 * local checkout + the local cache — never `gh api` / HTTP. Cache warming from a
 * remote (if ever needed) belongs in a separate out-of-band command, NOT here.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  CAPABILITY_TOKENS,
  type CapabilityToken,
  type ContractEnvelope,
  type EnvelopeInvariant,
  type EnvelopePhase,
  type ResolvedSkill,
  type TriState,
} from "./types";

/** Options for {@link acquireEnvelopes}. */
export interface AcquireEnvelopesOptions {
  /** The HAL canonical checkout root (`settings.halCanonicalCheckoutPath`). */
  canonicalCheckoutPath?: string;
  /** Content-addressed cache dir (default `<HAPI_HOME>/hal-projection-cache`). */
  cacheDir?: string;
  /**
   * Restrict to these skill dir names (default: every `.claude/skills/<name>/`
   * that carries an `envelope.yaml`). The MVP golden case is `issue-expert-reviewer`.
   */
  skills?: string[];
}

/** Result of an acquisition — fail-open (`ok:false` + reason, never a throw). */
export interface EnvelopeSourceResult {
  ok: boolean;
  skills?: ResolvedSkill[];
  /** Set when `ok === false` — the annotated "projection unavailable" reason. */
  unavailableReason?: string;
  /** Non-fatal per-skill warnings (e.g. a stale `skill_sha` pin, a skipped envelope). */
  warnings?: string[];
}

const TRI_STATES: readonly TriState[] = ["native", "emulated", "absent"];

/** Compute the git blob SHA-1 of `content` (`sha1("blob " + len + "\0" + bytes)`). */
export function computeGitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([header, bytes]))
    .digest("hex");
}

function isCapabilityToken(value: unknown): value is CapabilityToken {
  return (
    typeof value === "string" &&
    (CAPABILITY_TOKENS as readonly string[]).includes(value)
  );
}

function isTriState(value: unknown): value is TriState {
  return (
    typeof value === "string" &&
    (TRI_STATES as readonly string[]).includes(value)
  );
}

/**
 * Parse an `envelope.yaml` string into a validated {@link ContractEnvelope}.
 * Throws a descriptive Error on any structural violation — the caller catches it
 * and downgrades to a per-skill warning (fail-open at the fleet level).
 */
export function parseEnvelopeYaml(raw: string): ContractEnvelope {
  const doc = parseYaml(raw) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") {
    throw new Error("envelope.yaml did not parse to an object");
  }

  const skill = doc.skill;
  const skillSha = doc.skill_sha;
  const schemaVersion = doc.schema_version;
  if (typeof skill !== "string" || skill.length === 0) {
    throw new Error("envelope.yaml missing string `skill`");
  }
  if (typeof skillSha !== "string" || skillSha.length === 0) {
    throw new Error(
      `envelope.yaml for "${skill}" missing string \`skill_sha\``
    );
  }
  if (typeof schemaVersion !== "number") {
    throw new Error(
      `envelope.yaml for "${skill}" missing numeric \`schema_version\``
    );
  }

  const rawCaps = Array.isArray(doc.required_capabilities)
    ? doc.required_capabilities
    : [];
  const requiredCapabilities: CapabilityToken[] = [];
  for (const cap of rawCaps) {
    if (!isCapabilityToken(cap)) {
      throw new Error(
        `envelope.yaml for "${skill}" has unknown required capability "${String(cap)}"`
      );
    }
    requiredCapabilities.push(cap);
  }

  const degradation: Partial<Record<CapabilityToken, TriState>> = {};
  const rawDeg =
    doc.degradation && typeof doc.degradation === "object"
      ? (doc.degradation as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(rawDeg)) {
    if (!isCapabilityToken(key)) {
      throw new Error(
        `envelope.yaml for "${skill}" has degradation for unknown capability "${key}"`
      );
    }
    if (!isTriState(value)) {
      throw new Error(
        `envelope.yaml for "${skill}" degradation.${key} is not native|emulated|absent`
      );
    }
    degradation[key] = value;
  }

  const phases: EnvelopePhase[] = [];
  if (Array.isArray(doc.phases)) {
    for (const entry of doc.phases) {
      if (!entry || typeof entry !== "object") continue;
      const p = entry as Record<string, unknown>;
      if (typeof p.id !== "string" || typeof p.name !== "string") continue;
      const gate =
        p.gate === "approval" || p.gate === "hard-stop" ? p.gate : undefined;
      phases.push({ id: p.id, name: p.name, gate });
    }
  }

  const invariants: EnvelopeInvariant[] = [];
  if (Array.isArray(doc.invariants)) {
    for (const entry of doc.invariants) {
      if (!entry || typeof entry !== "object") continue;
      const inv = entry as Record<string, unknown>;
      if (typeof inv.id !== "string") continue;
      invariants.push({
        id: inv.id,
        note: typeof inv.note === "string" ? inv.note : undefined,
      });
    }
  }

  return {
    schemaVersion,
    skill,
    skillSha,
    requiredCapabilities,
    degradation,
    phases,
    invariants,
  };
}

interface CachedSkill {
  envelope: ContractEnvelope;
  skillBody: string;
}

/** Read a SHA-keyed cache entry, or `undefined` on any miss/parse error. */
async function readCache(
  cacheDir: string,
  skillSha: string
): Promise<CachedSkill | undefined> {
  try {
    const raw = await fs.readFile(join(cacheDir, `${skillSha}.json`), "utf8");
    const parsed = JSON.parse(raw) as CachedSkill;
    if (parsed && parsed.envelope && typeof parsed.skillBody === "string") {
      return parsed;
    }
  } catch {
    // miss — fall through
  }
  return undefined;
}

/** Write a SHA-keyed cache entry (best-effort; a failure is non-fatal). */
async function writeCache(
  cacheDir: string,
  skillSha: string,
  value: CachedSkill
): Promise<void> {
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      join(cacheDir, `${skillSha}.json`),
      JSON.stringify(value),
      "utf8"
    );
  } catch {
    // best-effort cache — a write failure never blocks projection
  }
}

/**
 * Acquire the SHA-pinned canonical skill fleet from the configured checkout,
 * using the content-addressed cache. Fail-open: any source-level failure returns
 * `{ ok: false, unavailableReason }`. Per-skill failures (an unparseable
 * envelope, a missing SKILL.md) are downgraded to `warnings` and the skill is
 * skipped — one bad envelope never sinks the whole fleet.
 */
export async function acquireEnvelopes(
  opts: AcquireEnvelopesOptions
): Promise<EnvelopeSourceResult> {
  const checkout = opts.canonicalCheckoutPath;
  if (!checkout) {
    return {
      ok: false,
      unavailableReason:
        "no HAL canonical checkout configured (set settings.halCanonicalCheckoutPath to the rp1-home #1687 tree)",
    };
  }

  const skillsRoot = join(checkout, ".claude", "skills");
  let skillDirs: string[];
  try {
    if (opts.skills && opts.skills.length > 0) {
      skillDirs = opts.skills;
    } else {
      const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
      skillDirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith("_"))
        .map(e => e.name);
    }
  } catch (error) {
    return {
      ok: false,
      unavailableReason: `HAL canonical checkout unreadable at ${skillsRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const cacheDir = opts.cacheDir;
  const resolved: ResolvedSkill[] = [];
  const warnings: string[] = [];

  for (const name of skillDirs) {
    const envelopePath = join(skillsRoot, name, "envelope.yaml");
    let envelopeRaw: string;
    try {
      envelopeRaw = await fs.readFile(envelopePath, "utf8");
    } catch {
      // No envelope for this skill dir — silently skip (not every dir carries one).
      continue;
    }

    let envelope: ContractEnvelope;
    try {
      envelope = parseEnvelopeYaml(envelopeRaw);
    } catch (error) {
      warnings.push(
        `skipped ${name}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }

    // Cache hit by skill_sha → reuse the resolved body (pure fs read avoided).
    if (cacheDir) {
      const cached = await readCache(cacheDir, envelope.skillSha);
      if (cached) {
        resolved.push({
          envelope: cached.envelope,
          skillBody: cached.skillBody,
        });
        continue;
      }
    }

    let skillBody: string;
    try {
      skillBody = await fs.readFile(join(skillsRoot, name, "SKILL.md"), "utf8");
    } catch (error) {
      warnings.push(
        `skipped ${name}: sibling SKILL.md unreadable (${
          error instanceof Error ? error.message : String(error)
        })`
      );
      continue;
    }

    // Advisory freshness check (KD4): the pin should match the sibling body.
    const actualSha = computeGitBlobSha(skillBody);
    if (actualSha !== envelope.skillSha) {
      warnings.push(
        `${name}: skill_sha pin ${envelope.skillSha} != current SKILL.md blob ${actualSha} (stale pin — projecting current body)`
      );
    }

    const resolvedSkill: ResolvedSkill = { envelope, skillBody };
    resolved.push(resolvedSkill);
    if (cacheDir) {
      await writeCache(cacheDir, envelope.skillSha, {
        envelope,
        skillBody,
      });
    }
  }

  if (resolved.length === 0) {
    return {
      ok: false,
      unavailableReason: `no projectable envelopes found under ${skillsRoot}`,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  return {
    ok: true,
    skills: resolved,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
