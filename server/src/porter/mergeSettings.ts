// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The key-wise settings.json merge — split out of `importArchive.ts` (#4281, the
 * epic #4290 T24 move; #2077 max-lines), the same decomposition that produced
 * `./planClaudeMd` (#4173). Homes `mergeSettings` and its strict reader so the
 * import core stays under the 1,500-line `max-lines` guardrail. The move is
 * verbatim; #4281 then gave `mergeSettings` its empty-base flag, which #5534
 * widened from a dangling link to any link that did not resolve to a regular
 * file when checked.
 */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { toSettingsHooksBlock, type HookEntry } from "@hapi/protocol/porter";
import { canonicalHookCommand } from "./hookRegistrationValidator";
import { isRegularFile } from "./commitFs";
import type { Conflict } from "./conflictDetection";
import { differingSettingsKeys, settingsKeyLands } from "./planSettingsScripts";
import type { MergedHookRegistration } from "./importArchive";

// #2564 (F4): strict variant of readJsonObject — a present-yet-unparseable file
// THROWS (mirrors mcpImport) instead of silently {}, and so does valid JSON
// that is not an object (#3022); used only by mergeSettings.
export async function readJsonObjectStrict(
  path: string
): Promise<Record<string, unknown>> {
  // #4146: read only a regular file. An acknowledged link to a directory, FIFO or
  // socket is replaced, not read (reading a FIFO would block under the import lock).
  if (!(await isRegularFile(path))) return {};
  const raw = await readFile(path, "utf-8");
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // #5676: a fixed reason, never the parser's text — Bun's JSON.parse names
    // an unquoted value verbatim, and settings.json can hold secret values.
    throw new Error(
      `Refusing to merge settings: ${path} is not valid JSON. ` +
        `Preserving the original.`
    );
  }
  // #3022 (F3): valid JSON that is not a plain object (null, a number, string,
  // boolean or array) is refused, not coerced to {} and overwritten. An array
  // would take the merged keys as properties that JSON.stringify drops, so the
  // commit would write [] while reporting settingsMerged (#5178). Outside the
  // try, so the catch above cannot relabel it as invalid JSON. Names the kind,
  // never the value: a top-level JSON string can be a secret (#5676).
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = Array.isArray(parsed)
      ? "an array"
      : parsed === null
        ? "null"
        : `a ${typeof parsed}`;
    throw new Error(
      `Refusing to merge settings: ${path} is not a JSON object (it is ${kind}). ` +
        `Preserving the original.`
    );
  }
  return parsed as Record<string, unknown>;
}

/** Key-wise settings.json merge — F5 allowlist + additive hooks block. */
export async function mergeSettings(
  settingsPath: string,
  settingsToMerge: Record<string, unknown>,
  hookEntries: HookEntry[],
  settingsConflicts: Conflict[],
  overwrite: ReadonlySet<string>,
  write: (content: Buffer) => Promise<void>,
  baseAbsent = false
): Promise<{
  changed: boolean;
  mergedHookRegistrations: MergedHookRegistration[];
}> {
  // #2564 (F4): strict read — a malformed settings.json throws before any write
  // and is preserved by runCommit's rollback (not parsed as {} and overwritten).
  // #4281, #5534: a link that was dangling, looping or not a regular file when
  // checked had no settings to merge into, even if a file item of this import
  // has since created its target or replaced a link in its chain.
  const existing = baseAbsent ? {} : await readJsonObjectStrict(settingsPath);
  const conflictKeys = differingSettingsKeys(settingsConflicts);

  let changed = false;
  for (const [key, value] of Object.entries(settingsToMerge)) {
    const lands = settingsKeyLands(key, {
      conflictKeys,
      overwrite,
      settingsPath,
      keyExists: key in existing,
    });
    if (!lands) continue; // differing pre-existing key — preserved (default skip, R3)
    existing[key] = value;
    changed = true;
  }

  // Additive hooks block: append imported matcher entries per event, deduping
  // path-equivalent registrations (#2641 / F12). Two matcher entries are
  // duplicates iff they share an event, a matcher (absent ≡ ""), AND a canonical
  // command set (`$HOME` / `~/.claude` expanded to the destination home). The
  // key deliberately includes event + matcher + canonical command so a same
  // command under a different matcher or event is NEVER merged (R3 / Task 3
  // guardrail). Deduping runs against BOTH pre-existing destination entries and
  // other incoming entries; surviving entries keep their stored textual form —
  // we canonicalize for the compare only, never write the canonical form back
  // (KD-3). The count invariant (one output per unique canonical key) is a
  // REPORTED outcome via `mergedHookRegistrations`, never a runtime throw — a
  // throw here would be caught by runCommit's rollback and revert exactly the
  // damaged destinations this heals (D4 / 1B-9).
  const mergedHookRegistrations: MergedHookRegistration[] = [];
  if (hookEntries.length > 0) {
    // settingsPath = <claudeDir>/settings.json → destHome = dirname(claudeDir).
    // Matches the destHome used to expand incoming commands at import time.
    const destHome = dirname(dirname(settingsPath));
    const commandsOf = (entry: unknown): string[] => {
      const inner = (entry as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) return [];
      return inner
        .map(h => (h as { command?: unknown })?.command)
        .filter((c): c is string => typeof c === "string");
    };
    const matcherOf = (entry: unknown): string => {
      const m = (entry as { matcher?: unknown })?.matcher;
      return typeof m === "string" ? m : "";
    };
    const canonicalCommand = (entry: unknown): string =>
      commandsOf(entry)
        .map(c => canonicalHookCommand(c, destHome))
        .join("; ");
    // event + matcher + canonical command(s) — the full dedupe identity.
    const canonicalKey = (event: string, entry: unknown): string =>
      JSON.stringify([event, matcherOf(entry), canonicalCommand(entry)]);

    const incoming = toSettingsHooksBlock(hookEntries);
    const hooks = (existing.hooks ??= {}) as Record<string, unknown[]>;
    for (const [event, matchers] of Object.entries(incoming)) {
      const arr = Array.isArray(hooks[event])
        ? (hooks[event] as unknown[])
        : [];
      const seen = new Set<string>();
      const kept: unknown[] = [];
      let eventChanged = false;

      // D4: collapse pre-existing canonical-key-equivalent duplicate entries
      // already stored on the destination (the MS1 damaged-destination heal —
      // both the `$HOME` and expanded forms survived a prior no-dedupe import).
      // Keep the first, drop the rest, and report each collapse per-item (R6).
      // Strictly canonical-key-equivalent pairs only (KD-3).
      for (const entry of arr) {
        const key = canonicalKey(event, entry);
        if (seen.has(key)) {
          mergedHookRegistrations.push({
            event,
            command: canonicalCommand(entry),
            source: "preexisting-collapse",
          });
          eventChanged = true;
          continue;
        }
        seen.add(key);
        kept.push(entry);
      }

      // Then append incoming matchers, skipping any whose canonical key already
      // exists (a surviving pre-existing entry OR one appended earlier this run).
      for (const entry of matchers) {
        const key = canonicalKey(event, entry);
        if (seen.has(key)) {
          mergedHookRegistrations.push({
            event,
            command: canonicalCommand(entry),
            source: "incoming-skip",
          });
          continue;
        }
        seen.add(key);
        kept.push(entry);
        eventChanged = true;
      }

      hooks[event] = kept;
      // Dirty flag (D3, honors #2562 R3): a no-op for this event only when
      // nothing was appended AND nothing collapsed.
      if (eventChanged) changed = true;
    }
  }

  // #4130 mode + #4146 link rule live in ./commitFs writeMergedSettings.
  if (changed) await write(Buffer.from(JSON.stringify(existing, null, 2)));
  return { changed, mergedHookRegistrations };
}
