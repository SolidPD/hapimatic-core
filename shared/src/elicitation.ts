// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MCP elicitations (#6606): the contract between the Codex CLI, the hub and
 * the web card for a server's request for input.
 *
 * An MCP server attached to a Codex session can ask the user for input: a form
 * with fields, or a link to open. Codex forwards the request without checking
 * anything (measured on 0.167.0), so every value Hapimatic sends back must come
 * from an answer set the user (or, under Matt's 69-Q1-b, an agent session in a
 * bypass mode) submitted for that request, and must pass these checks first.
 * Nothing here ever derives a value from the schema.
 *
 * - `parseElicitationSchema` turns a form's `requestedSchema` into the card's
 *   fields, or says why the form is unsupported (it is then declined, and no
 *   card is shown).
 * - `answersToContent` checks an answer set (the `answers` channel:
 *   `Record<string, string[]>`) against the fields and builds the reply's
 *   `content`.
 * - `checkElicitationUrl` checks a link request's address before anything is
 *   shown.
 */

/**
 * The card's tool name. Not `mcp__`-prefixed, so the web's `mcp__` handling and
 * today's `mcp__<server>` approve/deny card (Codex's own tool-call approvals)
 * stay as they are.
 */
export const MCP_ELICITATION_TOOL = "mcp_elicitation";

/**
 * The parser's limits (R12), the address limit (R5), the text-value cap, and
 * the notice-name (R15) and shown-value (R17) cuts.
 */
export const ELICITATION_LIMITS = {
  fields: 50,
  message: 2000,
  title: 200,
  description: 1000,
  choices: 100,
  choiceText: 200,
  propertyName: 64,
  /** The serialised card input, a catch-all for anything else in it. */
  cardInput: 65536,
  url: 2048,
  /**
   * A submitted text value whose field sets no `maxLength` (board-26 PM ruling,
   * 2026-11-11): a submitted value rests whole in the session record (69-Q2-b).
   */
  textValue: 10000,
  /** A server or field name in a notice (R15). */
  noticeName: 64,
  /**
   * One field's value (a multi-select's choices joined) in the line that
   * lists a submitted form (R17).
   */
  shownValue: 200,
} as const;

export type ElicitationTextFormat = "email" | "uri" | "date" | "date-time";
export type ElicitationFieldKind =
  | "text"
  | "number"
  | "integer"
  | "boolean"
  | "single"
  | "multi";

export interface ElicitationChoice {
  value: string;
  title: string;
}

export interface ElicitationField {
  name: string;
  kind: ElicitationFieldKind;
  required: boolean;
  title?: string;
  description?: string;
  format?: ElicitationTextFormat;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  choices?: ElicitationChoice[];
  minItems?: number;
  maxItems?: number;
  /** The server's default in the answer form, only when it satisfies the field. */
  default?: string[];
}

/** What the card shows (the request's `arguments` in the agent state). */
export interface ElicitationRequestInput {
  mode: "form" | "url";
  server: string;
  message: string;
  fields?: ElicitationField[];
  url?: string;
  host?: string;
  punycode?: boolean;
  /** The server's own id: card data only, never the request's key. */
  elicitationId?: string;
}

export type ElicitationSchemaResult =
  | { fields: ElicitationField[] }
  | { unsupported: string; secretField?: string; unshowableField?: string };

export type ElicitationContentResult =
  | { ok: true; content: Record<string, unknown> }
  | { ok: false; reason: string };

export type ElicitationUrlResult =
  | {
      ok: true;
      host: string;
      punycode: boolean;
      /** The parsed address: what a browser opens for this request (D2). */
      href: string;
    }
  | { ok: false; reason: string };

const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const TOP_LEVEL_IGNORED: ReadonlySet<string> = new Set([
  "$schema",
  "title",
  "description",
  "additionalProperties",
]);
/** Annotation keys: they describe a field and constrain nothing. */
const ANNOTATIONS: ReadonlySet<string> = new Set([
  "$comment",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const TEXT_FORMATS: ReadonlySet<string> = new Set([
  "email",
  "uri",
  "date",
  "date-time",
]);
const COMMON_KEYS = ["type", "title", "description", "default"] as const;
const FIELD_KEYS: Record<string, ReadonlySet<string>> = {
  string: new Set([...COMMON_KEYS, "format", "minLength", "maxLength"]),
  enum: new Set([...COMMON_KEYS, "enum", "enumNames"]),
  oneOf: new Set([...COMMON_KEYS, "oneOf"]),
  number: new Set([...COMMON_KEYS, "minimum", "maximum"]),
  boolean: new Set(COMMON_KEYS),
  array: new Set([...COMMON_KEYS, "items", "minItems", "maxItems"]),
};

/**
 * The secret-word rule (Matt's 69-S1-a): a form is declined when the words of
 * one entry appear next to each other, in order, in a field's name or title.
 */
const SECRET_WORDS: ReadonlyArray<readonly string[]> = [
  ["password"],
  ["passwd"],
  ["passphrase"],
  ["secret"],
  ["token"],
  ["apikey"],
  ["api", "key"],
  ["private", "key"],
  ["credential"],
  ["credentials"],
  ["otp"],
  ["one", "time", "code"],
  ["cvv"],
  ["cvc"],
  ["security", "code"],
];

const NUMBER_GRAMMAR = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const DATE_GRAMMAR = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_GRAMMAR =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;
const MAX_SIGNIFICANT_DIGITS = 15;
// C0 and C1 controls, line and paragraph separators, the object replacement
// character, and bidirectional formatting characters, which can reorder what a
// user reads. It holds every character a field's name or title may not hold.
const UNSAFE_TEXT =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffc\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Zero-width and bidirectional formatting characters: invisible, or able to
// reorder what a user reads. They are removed (not replaced) from every label
// a card shows, so "\u202edrowssap" shows as typed (round 1, D3).
const FORMAT_CHARACTERS =
  /[\u200b-\u200d\u2060\ufeff\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Every character Unicode marks Default_Ignorable_Code_Point or gives the
// general category Cf (format), by class: most are drawn as nothing, some
// reorder what a user reads. It holds every character of FORMAT_CHARACTERS
// (round 2, F1).
const IGNORABLE_CHARACTERS = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
// What a field's name or title may not hold (round 3, H1), by class: every
// control (general category Cc) except tab, line feed, form feed and carriage
// return, which stay word separators; the line and paragraph separators (Zl,
// Zp); and the object replacement character. Several are drawn as nothing, so
// "Pass" and "word" around one read "Password" (measured in headless Chromium).
const UNSHOWABLE_CHARACTERS = /(?![\t\n\f\r])[\p{Cc}\p{Zl}\p{Zp}\uFFFC]/u;

/** `text` without zero-width or bidirectional formatting characters. */
export function stripFormatCharacters(text: string): string {
  return text.replace(FORMAT_CHARACTERS, "");
}

/**
 * `text` as a person reads it, for the secret-word test only: without any
 * default-ignorable or format character, so "Pass\u00adword" or
 * "Pass\u3164word" is matched as "Password" (round 2, F1). A shown label keeps
 * the characters this drops beyond `stripFormatCharacters`, because dropping a
 * variation selector or a tag character changes how an emoji is drawn.
 */
function readAsPerson(text: string): string {
  return text.replace(IGNORABLE_CHARACTERS, "");
}

class Unsupported extends Error {
  constructor(
    readonly reason: string,
    readonly secretField?: string,
    readonly unshowableField?: string
  ) {
    super(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * Text from a server or a caller, made safe to show in one line: controls,
 * line and paragraph separators, U+FFFC and bidirectional formatting
 * characters become spaces, white space is collapsed, and the result is cut
 * to `max` characters (code points), the last one an ellipsis when cut.
 */
export function cleanElicitationText(text: string, max: number): string {
  const clean = text.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** A field or key name as a notice may show it (R15). */
function shownName(name: string): string {
  return cleanElicitationText(name, ELICITATION_LIMITS.noticeName);
}

function nameWords(name: string): string[] {
  return name
    .split(/[^\p{L}\p{N}]+/u)
    .flatMap(chunk =>
      chunk
        .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
        .split(" ")
    )
    .filter(word => word.length > 0)
    .map(word => word.toLowerCase());
}

function titleWords(title: string): string[] {
  return title
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length > 0)
    .map(word => word.toLowerCase());
}

function containsRun(words: string[], run: readonly string[]): boolean {
  for (let i = 0; i + run.length <= words.length; i++) {
    if (run.every((word, j) => words[i + j] === word)) return true;
  }
  return false;
}

/**
 * Why a field's name or title declines the form, read here, the one place:
 * first the secret-word rule, each passing through `readAsPerson` before the
 * word split; then a character the card cannot show (round 3, H1). A field the
 * word rule declines keeps that reason.
 */
function nameOrTitleRefusal(
  name: string,
  title: string | undefined
): "secret" | "unshowable" | null {
  const lists = [nameWords(readAsPerson(name))];
  if (title !== undefined) lists.push(titleWords(readAsPerson(title)));
  if (SECRET_WORDS.some(run => lists.some(words => containsRun(words, run)))) {
    return "secret";
  }
  const texts = title === undefined ? [name] : [name, title];
  return texts.some(text => UNSHOWABLE_CHARACTERS.test(text))
    ? "unshowable"
    : null;
}

function readText(
  field: string,
  value: unknown,
  label: string,
  max: number
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Unsupported(`${shownName(field)}: a ${label} that is not text`);
  }
  if (codePoints(value) > max) {
    throw new Unsupported(
      `${shownName(field)}: a ${label} longer than ${max.toLocaleString("en-US")} characters`
    );
  }
  return value;
}

function readCount(
  field: string,
  value: unknown,
  key: string
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Unsupported(`${shownName(field)}: ${key} is not a count`);
  }
  return value;
}

function readBound(
  field: string,
  value: unknown,
  key: string
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Unsupported(`${shownName(field)}: ${key} is not a number`);
  }
  return value;
}

function checkKeys(
  field: string,
  property: Record<string, unknown>,
  allowed: ReadonlySet<string>
): void {
  for (const key of Object.keys(property)) {
    if (allowed.has(key) || ANNOTATIONS.has(key)) continue;
    throw new Unsupported(
      `${shownName(field)}: the schema key ${shownName(key)} is not supported`
    );
  }
}

function readChoiceText(field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new Unsupported(`${shownName(field)}: a choice that is not text`);
  }
  if (codePoints(value) > ELICITATION_LIMITS.choiceText) {
    throw new Unsupported(
      `${shownName(field)}: a choice longer than ${ELICITATION_LIMITS.choiceText} characters`
    );
  }
  return value;
}

function checkChoices(field: string, choices: ElicitationChoice[]): void {
  if (choices.length === 0) {
    throw new Unsupported(`${shownName(field)}: no choices`);
  }
  if (choices.length > ELICITATION_LIMITS.choices) {
    throw new Unsupported(
      `${shownName(field)}: more than ${ELICITATION_LIMITS.choices} choices`
    );
  }
  if (new Set(choices.map(c => c.value)).size !== choices.length) {
    throw new Unsupported(`${shownName(field)}: a choice given twice`);
  }
}

function enumChoices(
  field: string,
  values: unknown,
  names: unknown
): ElicitationChoice[] {
  if (!Array.isArray(values)) {
    throw new Unsupported(`${shownName(field)}: enum is not a list`);
  }
  const titles = names === undefined ? undefined : names;
  if (
    titles !== undefined &&
    (!Array.isArray(titles) || titles.length !== values.length)
  ) {
    throw new Unsupported(`${shownName(field)}: enumNames does not match enum`);
  }
  const choices = values.map((value, i) => {
    const text = readChoiceText(field, value);
    const title = titles ? readChoiceText(field, titles[i]) : text;
    // The value goes back as sent; only the label the card shows is cleaned.
    return { value: text, title: stripFormatCharacters(title) };
  });
  checkChoices(field, choices);
  return choices;
}

function constChoices(field: string, options: unknown): ElicitationChoice[] {
  if (!Array.isArray(options)) {
    throw new Unsupported(`${shownName(field)}: the choices are not a list`);
  }
  const choices = options.map(option => {
    if (!isRecord(option)) {
      throw new Unsupported(`${shownName(field)}: a choice is not an object`);
    }
    checkKeys(field, option, new Set(["const", "title"]));
    return {
      value: readChoiceText(field, option.const),
      title: stripFormatCharacters(readChoiceText(field, option.title)),
    };
  });
  checkChoices(field, choices);
  return choices;
}

function parseField(
  name: string,
  value: unknown,
  required: boolean
): ElicitationField {
  if (!isRecord(value)) {
    throw new Unsupported(`${shownName(name)}: not a field`);
  }
  const rawTitle = readText(
    name,
    value.title,
    "title",
    ELICITATION_LIMITS.title
  );
  const title =
    rawTitle === undefined ? undefined : stripFormatCharacters(rawTitle);
  // A writeOnly field holds a value the server means never to show back: a
  // secret by its own declaration, declined like a word match (round 1, D3).
  const refusal =
    value.writeOnly === true ? "secret" : nameOrTitleRefusal(name, title);
  if (refusal === "secret") {
    throw new Unsupported(
      `${shownName(name)}: asks for a password, key or token`,
      name
    );
  }
  if (refusal === "unshowable") {
    throw new Unsupported(
      `${shownName(name)}: its name or title holds a character Hapimatic cannot show`,
      undefined,
      name
    );
  }
  const description = readText(
    name,
    value.description,
    "description",
    ELICITATION_LIMITS.description
  );
  const field: ElicitationField = { name, kind: "text", required };
  if (title !== undefined && title.length > 0) field.title = title;
  if (description !== undefined) field.description = description;

  switch (value.type) {
    case "string": {
      if (value.enum !== undefined) {
        checkKeys(name, value, FIELD_KEYS.enum);
        field.kind = "single";
        field.choices = enumChoices(name, value.enum, value.enumNames);
      } else if (value.oneOf !== undefined) {
        checkKeys(name, value, FIELD_KEYS.oneOf);
        field.kind = "single";
        field.choices = constChoices(name, value.oneOf);
      } else {
        checkKeys(name, value, FIELD_KEYS.string);
        if (value.format !== undefined) {
          if (
            typeof value.format !== "string" ||
            !TEXT_FORMATS.has(value.format)
          ) {
            throw new Unsupported(`${shownName(name)}: an unsupported format`);
          }
          field.format = value.format as ElicitationTextFormat;
        }
        const minLength = readCount(name, value.minLength, "minLength");
        const maxLength = readCount(name, value.maxLength, "maxLength");
        if (minLength !== undefined) field.minLength = minLength;
        if (maxLength !== undefined) field.maxLength = maxLength;
      }
      break;
    }
    case "number":
    case "integer": {
      checkKeys(name, value, FIELD_KEYS.number);
      field.kind = value.type;
      const minimum = readBound(name, value.minimum, "minimum");
      const maximum = readBound(name, value.maximum, "maximum");
      if (minimum !== undefined) field.minimum = minimum;
      if (maximum !== undefined) field.maximum = maximum;
      break;
    }
    case "boolean":
      checkKeys(name, value, FIELD_KEYS.boolean);
      field.kind = "boolean";
      break;
    case "array": {
      checkKeys(name, value, FIELD_KEYS.array);
      field.kind = "multi";
      const items = value.items;
      if (!isRecord(items)) {
        throw new Unsupported(`${shownName(name)}: a list without choices`);
      }
      if (items.anyOf !== undefined) {
        checkKeys(name, items, new Set(["anyOf"]));
        field.choices = constChoices(name, items.anyOf);
      } else if (items.type === "string" && items.enum !== undefined) {
        checkKeys(name, items, new Set(["type", "enum"]));
        field.choices = enumChoices(name, items.enum, undefined);
      } else {
        throw new Unsupported(`${shownName(name)}: a list without choices`);
      }
      const minItems = readCount(name, value.minItems, "minItems");
      const maxItems = readCount(name, value.maxItems, "maxItems");
      if (minItems !== undefined) field.minItems = minItems;
      if (maxItems !== undefined) field.maxItems = maxItems;
      break;
    }
    case "object":
      throw new Unsupported(`${shownName(name)}: a nested object`);
    default:
      throw new Unsupported(`${shownName(name)}: an unsupported type`);
  }

  // The server's default is shown prefilled only when it satisfies its own
  // field; it reaches the server only as the user's submitted value.
  const prefill = defaultAnswer(value.default);
  if (prefill !== undefined && checkValue(field, prefill) === null) {
    field.default = prefill;
  }
  return field;
}

function defaultAnswer(value: unknown): string[] | undefined {
  if (typeof value === "string") return value === "" ? undefined : [value];
  if (typeof value === "boolean") return [String(value)];
  if (typeof value === "number" && Number.isFinite(value))
    return [String(value)];
  if (Array.isArray(value) && value.every(v => typeof v === "string")) {
    return value as string[];
  }
  return undefined;
}

/**
 * The card's fields for a form's `requestedSchema`, or why the form cannot be
 * shown. Checks every limit before it returns, so nothing over a limit is ever
 * written to the session state. Field order: the `required` fields in the
 * server's order, then the rest by name (Codex sorts `properties` by name and
 * keeps `required` in the server's order).
 */
export function parseElicitationSchema(
  requestedSchema: unknown
): ElicitationSchemaResult {
  try {
    if (!isRecord(requestedSchema) || requestedSchema.type !== "object") {
      throw new Unsupported("the form is not an object schema");
    }
    for (const key of Object.keys(requestedSchema)) {
      if (key === "type" || key === "properties" || key === "required")
        continue;
      if (TOP_LEVEL_IGNORED.has(key)) continue;
      throw new Unsupported(
        `the schema key ${shownName(key)} is not supported`
      );
    }
    const properties = requestedSchema.properties;
    if (!isRecord(properties)) throw new Unsupported("the form has no fields");
    const names = Object.keys(properties);
    if (names.length === 0) throw new Unsupported("the form has no fields");
    if (names.length > ELICITATION_LIMITS.fields) {
      throw new Unsupported(`more than ${ELICITATION_LIMITS.fields} fields`);
    }
    for (const name of names) {
      if (
        name.length === 0 ||
        codePoints(name) > ELICITATION_LIMITS.propertyName
      ) {
        throw new Unsupported(
          `a field name longer than ${ELICITATION_LIMITS.propertyName} characters`
        );
      }
      if (RESERVED_NAMES.has(name)) {
        throw new Unsupported(`${name}: a reserved field name`);
      }
    }
    const rawRequired = requestedSchema.required;
    if (
      rawRequired !== undefined &&
      (!Array.isArray(rawRequired) ||
        !rawRequired.every(item => typeof item === "string"))
    ) {
      throw new Unsupported("required is not a list of field names");
    }
    const required: string[] = [];
    for (const name of (rawRequired as string[] | undefined) ?? []) {
      if (!Object.prototype.hasOwnProperty.call(properties, name)) {
        throw new Unsupported("required names a field the form does not have");
      }
      if (!required.includes(name)) required.push(name);
    }
    const optional = names
      .filter(name => !required.includes(name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const fields = [
      ...required.map(name => parseField(name, properties[name], true)),
      ...optional.map(name => parseField(name, properties[name], false)),
    ];
    return { fields };
  } catch (error) {
    if (error instanceof Unsupported) {
      if (error.secretField !== undefined) {
        return { unsupported: error.reason, secretField: error.secretField };
      }
      if (error.unshowableField !== undefined) {
        return {
          unsupported: error.reason,
          unshowableField: error.unshowableField,
        };
      }
      return { unsupported: error.reason };
    }
    return { unsupported: "the form could not be read" };
  }
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function checkFormat(
  format: ElicitationTextFormat,
  value: string
): string | null {
  switch (format) {
    case "email": {
      if (/\s/.test(value)) return "not an email address";
      const parts = value.split("@");
      if (parts.length !== 2 || parts[0].length === 0) {
        return "not an email address";
      }
      const labels = parts[1].split(".");
      if (labels.length < 2 || labels.some(label => label.length === 0)) {
        return "not an email address";
      }
      return null;
    }
    case "uri": {
      try {
        const url = new URL(value);
        return url.protocol.length > 1 ? null : "not a URL";
      } catch {
        return "not a URL";
      }
    }
    case "date": {
      const match = DATE_GRAMMAR.exec(value);
      if (!match) return "not a date";
      return isRealDate(Number(match[1]), Number(match[2]), Number(match[3]))
        ? null
        : "not a date";
    }
    case "date-time": {
      const match = DATE_TIME_GRAMMAR.exec(value);
      if (!match) return "not a date and time";
      const [, y, mo, d, h, mi, s, , , oh, om] = match;
      const ok =
        isRealDate(Number(y), Number(mo), Number(d)) &&
        Number(h) <= 23 &&
        Number(mi) <= 59 &&
        Number(s) <= 60 &&
        (oh === undefined || (Number(oh) <= 23 && Number(om) <= 59));
      return ok ? null : "not a date and time";
    }
  }
}

function checkNumber(field: ElicitationField, value: string): string | null {
  const match = NUMBER_GRAMMAR.exec(value);
  if (!match) return "not a number";
  const digits = `${match[1]}${(match[2] ?? "").slice(1)}`.replace(/^0+/, "");
  if (digits.length > MAX_SIGNIFICANT_DIGITS) {
    return `more than ${MAX_SIGNIFICANT_DIGITS} significant digits`;
  }
  const number = Number(value);
  if (Object.is(number, -0)) return "negative zero";
  if (field.kind === "integer" && match[2] !== undefined) {
    return "not a whole number";
  }
  if (field.minimum !== undefined && number < field.minimum) {
    return `below the minimum ${field.minimum}`;
  }
  if (field.maximum !== undefined && number > field.maximum) {
    return `above the maximum ${field.maximum}`;
  }
  return null;
}

function checkText(field: ElicitationField, value: string): string | null {
  const length = codePoints(value);
  if (field.minLength !== undefined && length < field.minLength) {
    return `shorter than ${field.minLength} characters`;
  }
  const max = field.maxLength ?? ELICITATION_LIMITS.textValue;
  if (length > max)
    return `longer than ${max.toLocaleString("en-US")} characters`;
  return field.format ? checkFormat(field.format, value) : null;
}

/** Why `values` does not satisfy `field`, or null. Never quotes a value. */
function checkValue(field: ElicitationField, values: string[]): string | null {
  if (values.length === 0) return field.required ? "no answer" : null;
  if (values.some(value => value === "")) return "an empty value";
  if (field.kind !== "multi" && values.length > 1) return "more than one value";
  const choiceValues = field.choices?.map(choice => choice.value) ?? [];
  switch (field.kind) {
    case "text":
      return checkText(field, values[0]);
    case "number":
    case "integer":
      return checkNumber(field, values[0]);
    case "boolean":
      return values[0] === "true" || values[0] === "false"
        ? null
        : "not true or false";
    case "single":
      return choiceValues.includes(values[0]) ? null : "not one of the choices";
    case "multi": {
      if (!values.every(value => choiceValues.includes(value))) {
        return "not one of the choices";
      }
      if (new Set(values).size !== values.length) return "a choice given twice";
      if (field.minItems !== undefined && values.length < field.minItems) {
        return `fewer than ${field.minItems} choices`;
      }
      if (field.maxItems !== undefined && values.length > field.maxItems) {
        return `more than ${field.maxItems} ${field.maxItems === 1 ? "choice" : "choices"}`;
      }
      return null;
    }
  }
}

function toContentValue(field: ElicitationField, values: string[]): unknown {
  switch (field.kind) {
    case "number":
    case "integer":
      return Number(values[0]);
    case "boolean":
      return values[0] === "true";
    case "multi":
      return [...values];
    default:
      return values[0];
  }
}

/**
 * The reply's `content` for an answer set, or why the set is refused. The key
 * set must equal the field set (`[]` leaves an optional field empty, and it is
 * then omitted), so a bare approve with no answers, or `answers: {}`, is never
 * read as a submitted form. Fills nothing in. The reason names the field and
 * the rule, never a value.
 */
export function answersToContent(
  fields: readonly ElicitationField[],
  answers: unknown
): ElicitationContentResult {
  const set = isRecord(answers) ? answers : null;
  for (const field of fields) {
    if (!set || !Object.prototype.hasOwnProperty.call(set, field.name)) {
      return { ok: false, reason: `${shownName(field.name)}: no answer` };
    }
  }
  const known = new Set(fields.map(field => field.name));
  for (const key of Object.keys(set ?? {})) {
    if (!known.has(key)) {
      return {
        ok: false,
        reason: `${shownName(key)}: not a field of this form`,
      };
    }
  }
  const content = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const values = (set as Record<string, unknown>)[field.name];
    if (!Array.isArray(values) || !values.every(v => typeof v === "string")) {
      return {
        ok: false,
        reason: `${shownName(field.name)}: not a list of text values`,
      };
    }
    const problem = checkValue(field, values as string[]);
    if (problem !== null) {
      return { ok: false, reason: `${shownName(field.name)}: ${problem}` };
    }
    if (values.length > 0) {
      content[field.name] = toContentValue(field, values as string[]);
    }
  }
  return { ok: true, content };
}

/**
 * A link request's address, checked before anything is shown (board-26 PM
 * ruling P3-a): `https` only, no user name or password, at most 2,048
 * characters, no white space or control characters, and a host. `punycode`
 * is true when any label of the host is Punycode, so the card can flag it.
 * `href` is the parsed address (the host in Punycode, the path
 * percent-encoded): the one a press on the card's link opens, so the card
 * shows it rather than the raw request address (round 1, D2). The reason
 * names the rule, never the address.
 */
export function checkElicitationUrl(url: unknown): ElicitationUrlResult {
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, reason: "no address" };
  }
  if (url.length > ELICITATION_LIMITS.url) {
    return {
      ok: false,
      reason: `longer than ${ELICITATION_LIMITS.url.toLocaleString("en-US")} characters`,
    };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(url)) {
    return {
      ok: false,
      reason: "white space or a control character in the address",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "not a valid address" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "not https" };
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "a user name or password in the address" };
  }
  if (parsed.hostname === "") return { ok: false, reason: "no host" };
  const punycode = parsed.hostname
    .split(".")
    .some(label => label.toLowerCase().startsWith("xn--"));
  return { ok: true, host: parsed.host, punycode, href: parsed.href };
}

/**
 * The fields and values of a submitted form, as one plain-text line: the
 * fields in card order, an empty one left out, a multi-select's choices joined
 * with ", ", and each field's joined value cleaned and cut at 200 characters
 * with a count of what was cut. Shown in the chat line on submit and in the
 * Pins answer (R17).
 */
export function formatElicitationAnswers(
  fields: readonly ElicitationField[],
  answers: Record<string, readonly string[]>
): string {
  const parts: string[] = [];
  for (const field of fields) {
    const values = answers[field.name];
    if (!Array.isArray(values) || values.length === 0) continue;
    parts.push(`${shownName(field.name)}: ${shownValue(values.join(", "))}`);
  }
  return parts.join("; ");
}

function shownValue(value: string): string {
  const clean = value.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  const max = ELICITATION_LIMITS.shownValue;
  if (chars.length <= max) return clean;
  return `${chars.slice(0, max).join("")}… (${chars.length - max} more characters)`;
}
