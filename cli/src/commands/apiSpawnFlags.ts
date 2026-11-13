// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6400: the one-pass flag scanner behind `hapi api sessions spawn`.
 *
 * The spawn command used to find each flag with its own `indexOf`, so one token
 * could be both a flag and another flag's value (`--name --yolo` turned YOLO
 * on), a value flag with no value was dropped (a trailing `--permission-mode`
 * sent no posture, so the node default applied), and a misspelled or `=`-form
 * flag was ignored. This scanner walks the tokens once, left to right, so each
 * token is a flag or the value of the flag before it, never both, and refuses
 * every malformed command instead of guessing. It mirrors the strict walk in
 * `resolveWaitUntilRequest` (`api.ts`). The board-26 PM ruled each refusal
 * class on 2026-11-11 (D1-D4, option 1).
 *
 * The server stays the authoritative posture check; this only makes what the
 * CLI sends match what the caller typed.
 */
import { EFFORT_LEVELS } from "@hapi/protocol/effort";
import { MODEL_MODES, PERMISSION_MODES } from "@hapi/protocol/modes";
import { SESSION_ROLES } from "@hapi/protocol/schemas";

/** The usage text `hapi api sessions spawn` prints (moved from `api.ts`). */
export const SPAWN_USAGE =
  "Usage: hapi api sessions spawn --dir <path> [--machine <id>] [--name <display-name>] [--session-role <role>] [--model-mode <mode>] [--effort <level>] [--yolo | --permission-mode <mode>] [--mcp <name>]... [--mcp-none | --mcp-all] [--mcp-enable-for-project] [--parent-session-id <id>]";

/** Flags that take exactly one value. */
export const SPAWN_VALUE_FLAGS = [
  "--dir",
  "--machine",
  "--name",
  "--session-role",
  "--model-mode",
  "--effort",
  "--permission-mode",
  "--parent-session-id",
] as const;

/** Flags that take a value and may repeat; every value is kept, in order. */
export const SPAWN_REPEATED_FLAGS = ["--mcp"] as const;

/** Flags that take no value. */
export const SPAWN_BOOLEAN_FLAGS = [
  "--yolo",
  "--mcp-none",
  "--mcp-all",
  "--mcp-enable-for-project",
] as const;

/** The scanned spawn flags. */
export type SpawnFlagScan = {
  values: ReadonlyMap<string, string>;
  repeated: ReadonlyMap<string, readonly string[]>;
  booleans: ReadonlySet<string>;
};

const VALUE_FLAGS: ReadonlySet<string> = new Set(SPAWN_VALUE_FLAGS);
const REPEATED_FLAGS: ReadonlySet<string> = new Set(SPAWN_REPEATED_FLAGS);
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(SPAWN_BOOLEAN_FLAGS);

/** The valid values to name when an enum flag is given no value. */
function validValuesHint(flag: string): string {
  switch (flag) {
    case "--permission-mode":
      return ` Valid modes: ${PERMISSION_MODES.join(", ")}.`;
    case "--session-role":
      return ` Valid roles: ${SESSION_ROLES.join(", ")}.`;
    case "--model-mode":
      return ` Valid modes: ${MODEL_MODES.join(", ")}.`;
    case "--effort":
      return ` Valid levels: ${EFFORT_LEVELS.join(", ")}.`;
    default:
      return "";
  }
}

/**
 * Scan the spawn flags (the tokens after the `spawn` verb). Returns the scan,
 * or `{ error }` for the first malformed token:
 *   - `--help` / `-h`: the usage text;
 *   - a value flag with no value, or with a value starting with `--`;
 *   - a single-value flag given twice (D3);
 *   - an empty `--machine` (D4), which would otherwise spawn on the local node;
 *   - a known flag in the `--flag=value` form (D1), naming the space form;
 *   - an unknown option or a stray token (D2), with the usage text.
 * A value may start with a single dash (`--name -draft`) or be empty
 * (`--name ""`), as before.
 */
export function scanSpawnFlags(
  tokens: readonly string[]
): SpawnFlagScan | { error: string } {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const booleans = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (token === "--help" || token === "-h") {
      return { error: SPAWN_USAGE };
    }

    if (VALUE_FLAGS.has(token) || REPEATED_FLAGS.has(token)) {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return {
          error: `${token} needs a value.${validValuesHint(token)}`,
        };
      }
      if (REPEATED_FLAGS.has(token)) {
        repeated.set(token, [...(repeated.get(token) ?? []), value]);
      } else {
        if (values.has(token)) {
          return { error: `${token} was given more than once.` };
        }
        if (token === "--machine" && value === "") {
          return { error: "--machine needs a machine id, not an empty value." };
        }
        values.set(token, value);
      }
      i++;
      continue;
    }

    if (BOOLEAN_FLAGS.has(token)) {
      booleans.add(token);
      continue;
    }

    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    if (eq > 0) {
      const flag = token.slice(0, eq);
      if (VALUE_FLAGS.has(flag) || REPEATED_FLAGS.has(flag)) {
        return { error: `Use "${flag} <value>", not "${token}".` };
      }
      if (BOOLEAN_FLAGS.has(flag)) {
        return {
          error: `"${flag}" takes no value: pass "${flag}" alone, not "${token}".`,
        };
      }
    }

    return token.startsWith("-")
      ? { error: `Unknown option "${token}". ${SPAWN_USAGE}` }
      : { error: `Unexpected argument "${token}". ${SPAWN_USAGE}` };
  }

  return { values, repeated, booleans };
}
