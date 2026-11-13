// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The node's "compact at" preference (issue #6570).
 *
 * `settings.json` → `compactAt: { enabled, percent, seededFrom?, seededAt? }`. The
 * SERVER is its sole writer: the one-time boot seed (`seedCompactAtOnce`) and the
 * preference PUT (`saveCompactAt`). The session wrapper reads it at start
 * (`cli/src/claude/utils/sessionCompaction.ts`) through the same shared accessor,
 * `resolveCompactAt`, so the value Settings shows and the value a session receives
 * cannot differ.
 *
 * Every write goes through `updateSettings`, so an unreadable file is refused and
 * left byte-identical, and the serialized per-file chain orders this module's
 * writes against the other server writers.
 */

import {
  CompactAtPreferenceSchema,
  CompactAtStoredSchema,
  resolveCompactAt,
  type CompactAtPreferencePatch,
  type CompactAtStored,
  type ResolvedCompactAt,
} from "@hapi/protocol";
import { envEnabledOverride } from "./contextWatermarkConfig";
import {
  SettingsUnreadableError,
  readSettings,
  updateSettings,
  type Settings,
} from "./settings";

/** The resolved value plus the seed fields when a `compactAt` is stored. */
export interface CompactAtState extends ResolvedCompactAt {
  seededFrom?: CompactAtStored["seededFrom"];
  seededAt?: string;
}

/** The sent percent is out of range or a fraction. */
export const COMPACT_AT_PERCENT_RANGE_MESSAGE =
  "percent must be a whole number from 50 to 95";
/** The stored half of the pair is invalid, so one field alone cannot replace it. */
export const COMPACT_AT_NEEDS_BOTH_MESSAGE =
  "the saved value is invalid; send enabled and percent together to replace it";

/** Thrown by {@link saveCompactAt} when the merged value is not a valid stored value. */
export class CompactAtValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactAtValidationError";
  }
}

/** The optional seed fields, each checked on its own (see {@link saveCompactAt}). */
const SEED_FIELDS = ["seededFrom", "seededAt"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateFromSettings(settings: unknown): CompactAtState {
  const resolved = resolveCompactAt(settings);
  const state: CompactAtState = { ...resolved };
  if (resolved.source === "stored" && isPlainObject(settings)) {
    const stored = CompactAtStoredSchema.safeParse(settings.compactAt);
    if (stored.success) {
      if (stored.data.seededFrom !== undefined) {
        state.seededFrom = stored.data.seededFrom;
      }
      if (stored.data.seededAt !== undefined) {
        state.seededAt = stored.data.seededAt;
      }
    }
  }
  return state;
}

/**
 * Read the effective value. A missing file is the default (90, on); an unreadable
 * one resolves to `unreadable`, which is off.
 */
export async function readCompactAt(
  settingsFile: string
): Promise<CompactAtState> {
  return stateFromSettings(await readSettings(settingsFile));
}

/**
 * Merge `patch` into the stored value and write it. The patch is spread over the RAW
 * stored `compactAt` object (or over the resolved value when none is stored), never
 * over a parsed copy, so `seededFrom`, `seededAt` and any field a newer binary added
 * survive. Only the result's `enabled` and `percent` are validated, so a patch
 * carrying both fields repairs an `invalid` stored value whatever made it invalid: a
 * stored `seededFrom` or `seededAt` this binary cannot read (a hand edit, or a newer
 * binary's seed source after a rollback) would keep the value `invalid` after the
 * repair, so it is dropped; the two fields only record where the value came from.
 *
 * Throws {@link CompactAtValidationError} when the result's `enabled` or `percent` is
 * not valid (a percent outside 50–95 or a fraction, or one field sent over an invalid
 * stored pair), and `SettingsUnreadableError` for an unreadable file; neither writes
 * anything.
 */
export async function saveCompactAt(
  settingsFile: string,
  patch: CompactAtPreferencePatch
): Promise<CompactAtState> {
  const written = await updateSettings(settingsFile, current => {
    const raw = (current as Record<string, unknown>).compactAt;
    let base: Record<string, unknown>;
    if (raw === undefined) {
      const resolved = resolveCompactAt(current);
      base = { enabled: resolved.enabled, percent: resolved.percent };
    } else {
      base = isPlainObject(raw) ? raw : {};
    }
    const next: Record<string, unknown> = { ...base };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.percent !== undefined) next.percent = patch.percent;
    const pair = CompactAtPreferenceSchema.safeParse({
      enabled: next.enabled,
      percent: next.percent,
    });
    if (!pair.success) {
      const sentPercentInvalid =
        patch.percent !== undefined &&
        !CompactAtPreferenceSchema.shape.percent.safeParse(patch.percent)
          .success;
      throw new CompactAtValidationError(
        sentPercentInvalid
          ? COMPACT_AT_PERCENT_RANGE_MESSAGE
          : COMPACT_AT_NEEDS_BOTH_MESSAGE
      );
    }
    let droppedSeedField = false;
    for (const key of SEED_FIELDS) {
      if (
        next[key] !== undefined &&
        !CompactAtStoredSchema.shape[key].safeParse(next[key]).success
      ) {
        delete next[key];
        droppedSeedField = true;
      }
    }
    if (
      !droppedSeedField &&
      isPlainObject(raw) &&
      raw.enabled === next.enabled &&
      raw.percent === next.percent
    ) {
      return current; // unchanged: no write
    }
    return { ...current, compactAt: next as CompactAtStored };
  });
  return stateFromSettings(written);
}

export interface CompactAtSeedResult {
  seeded: boolean;
  percent?: number;
  seededFrom?: "contextWatermark" | "default";
  /** True when this seed turned a stored `contextWatermark.enabled: true` off. */
  handoffSwitchedOff?: boolean;
  /** Why nothing was written, when nothing was. */
  skipped?: "already-seeded" | "unreadable" | "error";
}

/**
 * The one-time boot seed (R3, R4). On the first start that finds no `compactAt`,
 * write it from the shared accessor's result — a legacy
 * `contextWatermark.watermarkPercent` or the default 90 — with `enabled: true`,
 * `seededFrom` and `seededAt`. In the same write, when the switch-off marker
 * `contextWatermark.compactAtSwitchOffAt` is absent, set it to the seed time and turn
 * a stored `contextWatermark.enabled: true` off, so Session Handoff is off after the
 * upgrade. The marker sits outside `compactAt`, so a later re-seed (after a hand edit
 * or a restored backup drops `compactAt`) leaves the operator's handoff switch alone.
 *
 * Never throws: a boot step that throws stops the hub. An unreadable file is not
 * written.
 */
export async function seedCompactAtOnce(
  settingsFile: string,
  log: (message: string) => void,
  now: () => Date = () => new Date()
): Promise<CompactAtSeedResult> {
  let result: CompactAtSeedResult = {
    seeded: false,
    skipped: "already-seeded",
  };
  try {
    await updateSettings(settingsFile, current => {
      if ((current as Record<string, unknown>).compactAt !== undefined) {
        result = { seeded: false, skipped: "already-seeded" };
        return current;
      }
      const resolved = resolveCompactAt(current);
      // R3: the source maps to the stored field in one place.
      const seededFrom: "contextWatermark" | "default" =
        resolved.source === "legacy-watermark" ? "contextWatermark" : "default";
      const seededAt = now().toISOString();
      const compactAt: CompactAtStored = {
        enabled: true,
        percent: resolved.percent,
        seededFrom,
        seededAt,
      };

      // R4: the one-time Session Handoff switch-off, guarded by its own marker.
      const rawWatermark = (current as Record<string, unknown>)
        .contextWatermark;
      const watermark = isPlainObject(rawWatermark) ? rawWatermark : undefined;
      let nextWatermark: unknown = rawWatermark;
      let handoffSwitchedOff = false;
      if (watermark?.compactAtSwitchOffAt === undefined) {
        const updated: Record<string, unknown> = {
          ...(watermark ?? {}),
          compactAtSwitchOffAt: seededAt,
        };
        if (watermark?.enabled === true) {
          updated.enabled = false;
          handoffSwitchedOff = true;
        }
        nextWatermark = updated;
      }

      result = {
        seeded: true,
        percent: resolved.percent,
        seededFrom,
        handoffSwitchedOff,
      };
      const next: Record<string, unknown> = { ...current, compactAt };
      if (nextWatermark !== undefined) next.contextWatermark = nextWatermark;
      return next as Settings;
    });
  } catch (error) {
    if (error instanceof SettingsUnreadableError) {
      log(
        "[compact-at] settings.json is unreadable; compact-at not seeded (sessions keep Claude Code's own setting)"
      );
      return { seeded: false, skipped: "unreadable" };
    }
    const reason = error instanceof Error ? error.message : String(error);
    log(`[compact-at] seed failed, nothing written: ${reason}`);
    return { seeded: false, skipped: "error" };
  }

  if (result.seeded) {
    log(
      `[compact-at] seeded ${result.percent}% from ${result.seededFrom}; Session Handoff ${
        result.handoffSwitchedOff ? "switched off" : "left as stored"
      }`
    );
    if (envEnabledOverride() === true) {
      log(
        "[compact-at] HAPI_CONTEXT_WATERMARK_ENABLED is truthy, so Session Handoff stays on whatever settings.json says"
      );
    }
  }
  return result;
}
