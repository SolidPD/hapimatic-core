// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The free-form spawn values that become an argument of the spawned `hapi`
 * (hapimatic-private#5348, R11; Matt, 63-M5 a).
 *
 * The daemon writes each as ONE argv element after its flag (`--hapi-raw-model <v>`,
 * `--resume <v>`, …). A value that starts with a dash is read by the spawned `hapi` as a
 * flag of its own: a resume id of `--yolo` on an argv seeded with `plan` started a
 * session in bypass, and a raw model of `--` dropped every flag before it. These rules
 * are checked ONCE in the daemon's `spawnSession`, the point every spawn path reaches
 * (the guarantee), and early by the server's schemas (a 400 before a bad value is sent
 * or stored).
 *
 * Load-order note: `schemas.ts` uses `isSpawnModelArgValue` and this module uses
 * `SessionRoleSchema` from `schemas.ts`; each reads the other's binding only inside a
 * function call, never while the module evaluates, so the import cycle is safe in any
 * load order.
 */
import { SessionRoleSchema } from "./schemas";

/** A Claude Code session id (a UUID): the only `--resume` value a claude spawn writes. */
export const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SPAWN_ARG_VALUE_MAX_LENGTH = 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const WHITESPACE = /\s/;
const LETTER_OR_DIGIT_FIRST = /^[A-Za-z0-9]/;

export type SpawnArgValueField =
  | "rawModel"
  | "model"
  | "outputStyle"
  | "resumeSessionId"
  | "sessionRole";

export type SpawnArgValueFailure = {
  field: SpawnArgValueField;
  /** One line naming the field, echoing at most the value's first 40 characters. */
  reason: string;
};

/**
 * A model id (`rawModel`, a codex `model`), already trimmed: the problem, or null.
 * First character a letter or digit; no whitespace or control character; at most 200
 * characters. `claude-opus-5-5[1m]` and `provider/model:free` pass.
 */
export function modelArgValueProblem(value: string): string | null {
  if (!LETTER_OR_DIGIT_FIRST.test(value)) {
    return "must start with a letter or a digit";
  }
  if (WHITESPACE.test(value) || CONTROL_CHARACTER.test(value)) {
    return "must not contain whitespace or a control character";
  }
  if (value.length > SPAWN_ARG_VALUE_MAX_LENGTH) {
    return `must be at most ${SPAWN_ARG_VALUE_MAX_LENGTH} characters`;
  }
  return null;
}

/**
 * An output style name: the problem, or null. Not empty; no leading dash; no leading or
 * trailing whitespace; no control character; at most 200 characters. Spaces inside are
 * allowed (custom style names have them).
 */
export function outputStyleArgValueProblem(value: string): string | null {
  if (value.length === 0) return "must not be empty";
  if (value.startsWith("-")) return "must not start with a dash";
  if (value !== value.trim()) {
    return "must not start or end with whitespace";
  }
  if (CONTROL_CHARACTER.test(value)) {
    return "must not contain a control character";
  }
  if (value.length > SPAWN_ARG_VALUE_MAX_LENGTH) {
    return `must be at most ${SPAWN_ARG_VALUE_MAX_LENGTH} characters`;
  }
  return null;
}

/** A plain token (a non-claude resume id): not empty, not dash-led, no whitespace. */
function plainTokenProblem(value: string): string | null {
  if (value.length === 0) return "must not be empty";
  if (value.startsWith("-")) return "must not start with a dash";
  if (WHITESPACE.test(value) || CONTROL_CHARACTER.test(value)) {
    return "must not contain whitespace or a control character";
  }
  if (value.length > SPAWN_ARG_VALUE_MAX_LENGTH) {
    return `must be at most ${SPAWN_ARG_VALUE_MAX_LENGTH} characters`;
  }
  return null;
}

/** True when a model id passes once trimmed (empty after the trim: nothing is emitted). */
export function isSpawnModelArgValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || modelArgValueProblem(trimmed) === null;
}

/** True when an output style passes (an empty one is not emitted, so it passes). */
export function isSpawnOutputStyleArgValue(value: string): boolean {
  return value.length === 0 || outputStyleArgValueProblem(value) === null;
}

function failure(
  field: SpawnArgValueField,
  value: string,
  problem: string
): SpawnArgValueFailure {
  return {
    field,
    reason: `${field} ${problem} (got ${JSON.stringify(value.slice(0, 40))}${
      value.length > 40 ? "…" : ""
    }).`,
  };
}

export type SpawnArgValues = {
  agent?: string;
  rawModel?: unknown;
  model?: unknown;
  outputStyle?: unknown;
  resumeSessionId?: unknown;
  sessionRole?: unknown;
};

/**
 * The first value of a spawn that fails its rule, or null. Each value is judged as the
 * daemon emits it: `rawModel` and the codex `model` after the daemon's trim (a value
 * that trims to nothing is not emitted); a non-empty `outputStyle`; a resume id (a UUID
 * for claude, a plain token for any other agent); a session role from the schema.
 */
export function checkSpawnArgValues(
  values: SpawnArgValues
): SpawnArgValueFailure | null {
  const agent = values.agent ?? "claude";

  // Fix round 3: a check that cannot read a value refuses it. A present value that is not
  // a string fails its field (the daemon writes these whenever truthy, coercing an array).
  for (const field of [
    "rawModel",
    "model",
    "outputStyle",
    "resumeSessionId",
  ] as const) {
    const value = values[field];
    if (field === "model" && agent !== "codex") continue;
    if (value != null && typeof value !== "string")
      return failure(field, String(value), "must be a string");
  }

  if (typeof values.rawModel === "string") {
    const trimmed = values.rawModel.trim();
    const problem = trimmed ? modelArgValueProblem(trimmed) : null;
    if (problem) return failure("rawModel", values.rawModel, problem);
  }

  if (agent === "codex" && typeof values.model === "string") {
    const trimmed = values.model.trim();
    const problem = trimmed ? modelArgValueProblem(trimmed) : null;
    if (problem) return failure("model", values.model, problem);
  }

  if (typeof values.outputStyle === "string" && values.outputStyle) {
    const problem = outputStyleArgValueProblem(values.outputStyle);
    if (problem) return failure("outputStyle", values.outputStyle, problem);
  }

  if (typeof values.resumeSessionId === "string" && values.resumeSessionId) {
    const id = values.resumeSessionId;
    const problem =
      agent === "claude"
        ? CLAUDE_SESSION_ID_PATTERN.test(id)
          ? null
          : "must be a Claude session id (a UUID)"
        : plainTokenProblem(id);
    if (problem) return failure("resumeSessionId", id, problem);
  }

  // Falsy values are not emitted (the daemon writes the flag only for a truthy role).
  if (values.sessionRole) {
    if (!SessionRoleSchema.safeParse(values.sessionRole).success) {
      return failure(
        "sessionRole",
        String(values.sessionRole),
        "is not a known session role"
      );
    }
  }

  return null;
}
