// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the Codex source (issue #5169), dialect-neutral part.
 *
 * Both exporters read a Codex home (`$CODEX_HOME`, else `~/.codex`) and carry:
 *
 *  - its MCP servers, from `config.toml` table `[mcp_servers.<name>]`, read by a
 *    small TOML SUBSET reader (D1). Neither exporter can rely on a TOML parser
 *    (bash needs only jq, tar and gzip; PowerShell has none), and `env` /
 *    `http_headers` hold literal secret values, so the file is never shipped.
 *    The reader lexes the whole file with ONE regex ({@link CODEX_TOML_TOKEN_PATTERN}:
 *    a multi-line string is one token, so a `"""` body can never be read as a
 *    table), then walks the tokens with a statement state machine that keeps
 *    only key NAMES of env and headers and never assigns their values. Its
 *    output feeds each exporter's existing MCP projection, which places
 *    secret-looking args and urls as it does for every other source;
 *  - its global instructions (`AGENTS.override.md` when it holds a non-blank
 *    byte, else `AGENTS.md`) as the rule `rules/codex-agents.md` (D2);
 *  - its user skills, from `~/.agents/skills/<name>/` and then the deprecated
 *    `$CODEX_HOME/skills/<name>/` (D7), under `skills/<name>`.
 *
 * Nothing else under the Codex home is read (R7). Custom prompts were removed
 * from Codex (openai/codex#16115), so a `prompts/` folder records one omission
 * instead (D6).
 *
 * THE ACCEPTED TOML SUBSET (R3). Inside `[mcp_servers.<k>]` (a bare or quoted
 * `<k>`): `command`, `url`, `bearer_token_env_var` and `bearer_token` as a
 * single-line string; `args` as an array of single-line strings (it may span
 * lines and end with a comma); `enabled` as `true` / `false`; `env`,
 * `http_headers` and `env_http_headers` as an inline table of single-line
 * strings, as dotted keys (`env.KEY = "v"`) or as their own table
 * `[mcp_servers.<k>.env]` of `KEY = "v"` lines. A basic string may use only
 * the escapes `\" \\ \b \f \n \r \t \uXXXX` and no control character
 * ({@link CODEX_TOML_BASIC_BODY_PATTERN}); a literal string no control
 * character. A server that leaves this subset is dropped whole, with one
 * omission naming it: a multi-line string, a non-string array element, a
 * nested inline table, a `[[...]]` table, a repeated key, an empty name or
 * value the manifest would refuse, or both or neither of `command` and `url`.
 * Any other key or sub-table of a server (`http_headers_helper`, `oauth`,
 * `env_vars`, `cwd`, `tools.*`, timeouts, ...) is dropped as a field and named
 * in one omission per server, as is a field the transport does not use (`env`
 * on an HTTP server, headers on a stdio one). Tables outside `mcp_servers` are
 * skipped token by token (brackets counted, so an array or inline table there
 * may span lines). A token the lexer cannot read (a stray quote, a lone CR, a
 * non-ASCII bare key), a malformed header, an unbalanced bracket, an
 * `mcp_servers` the reader cannot place, or a root key it cannot decode makes
 * the whole file unreadable: no Codex server is exported, and one omission
 * says so (fail-closed).
 *
 * The bash twin is `codexSourceShell.ts`, the PowerShell one
 * `codexSourcePowerShell.ts`; `exportEquivalence.test.ts` pins the two.
 *
 * NODE-FREE (R7): constants and string builders only, like every non-test
 * module under `shared/src/porter`.
 */

/** Archive path of the Codex instructions rule (D2). */
export const CODEX_RULE_ARCHIVE_PATH = "rules/codex-agents.md";

/** Manifest entry name of the Codex instructions rule. */
export const CODEX_RULE_NAME = "codex-agents";

/** Codex's global instruction files, in the order Codex reads them. */
export const CODEX_INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md"];

/** The skills folder Codex keeps its bundled skills in (never carried). */
export const CODEX_SYSTEM_SKILLS_DIR = ".system";

/** Codex's user skill folder under the home directory (read first, D7). */
export const CODEX_AGENTS_SKILLS_DIR = ".agents/skills";

/**
 * The single regex that lexes a `config.toml` into tokens, alternatives in
 * order: a multi-line basic string, a multi-line literal string, a basic
 * string, a literal string, a comment, a newline, a run of spaces or tabs, one
 * punctuation character, a bare word, and any other single character (a token
 * the reader refuses). `[\d\D]` is any character in JavaScript, .NET and jq's
 * Oniguruma alike.
 */
export const CODEX_TOML_TOKEN_PATTERN =
  '"""(?:[^\\\\]|\\\\[\\d\\D])*?"""' +
  "|'''[\\d\\D]*?'''" +
  '|"(?:[^"\\\\\\n\\r]|\\\\[^\\n\\r])*"' +
  "|'[^'\\n\\r]*'" +
  "|#[^\\n\\r]*" +
  "|\\r?\\n" +
  "|[ \\t]+" +
  "|[\\[\\]{}=,.]" +
  "|[A-Za-z0-9_+:-]+" +
  "|[\\d\\D]";

/**
 * The body of a basic string the reader decodes (between its quotes): no
 * control character, and only the escapes it can decode identically in both
 * dialects. A string outside it leaves the subset.
 */
export const CODEX_TOML_BASIC_BODY_PATTERN =
  '^(?:[^\\\\"\\x00-\\x1F\\x7F]|\\\\["\\\\bfnrt]|\\\\u(?![dD][89abAB])[0-9A-Fa-f]{4})*$';

/** The body of a literal string the reader accepts: no control character. */
export const CODEX_TOML_LITERAL_BODY_PATTERN = "^[^\\x00-\\x1F\\x7F]*$";

/** A bare key: TOML's own bare-key characters (a bare token may hold more). */
export const CODEX_TOML_BARE_KEY_PATTERN = "^[A-Za-z0-9_-]+$";

/** The server fields that hold one single-line string. */
export const CODEX_MCP_STRING_FIELDS = [
  "command",
  "url",
  "bearer_token_env_var",
  "bearer_token",
];

/** The server fields that hold a table of names (their values are never kept). */
export const CODEX_MCP_MAP_FIELDS = ["env", "http_headers", "env_http_headers"];

/** Every server field the reader maps (D8); any other is dropped and named. */
export const CODEX_MCP_MAPPED_FIELDS = [
  ...CODEX_MCP_STRING_FIELDS,
  "args",
  "enabled",
  ...CODEX_MCP_MAP_FIELDS,
];

/**
 * Fields a server's transport does not use: set on a stdio server (`command`)
 * or an HTTP server (`url`), each is dropped and named in that server's
 * omission. Both readers render these lists, so the two dialects drop alike.
 */
export const CODEX_STDIO_UNUSED_FIELDS = [
  "http_headers",
  "env_http_headers",
  "bearer_token_env_var",
  "bearer_token",
];
export const CODEX_HTTP_UNUSED_FIELDS = ["args", "env"];

/** The header slot a bearer token fills (`bearer_token_env_var` or `bearer_token`). */
export const CODEX_BEARER_HEADER = "Authorization";

/** Omission surface for anything read from `config.toml`. */
export const CODEX_CONFIG_SURFACE = "codex/config.toml";

/** Omission surface for the Codex home itself (a refused home). */
export const CODEX_HOME_SURFACE = "codex";

/** Omission surface for the instructions rule. */
export const CODEX_INSTRUCTIONS_SURFACE = "codex/AGENTS.md";

/** Omission surface for the custom prompts folder. */
export const CODEX_PROMPTS_SURFACE = "codex/prompts";

/** Omission surface for a Codex skill folder that is refused whole. */
export const CODEX_SKILLS_SURFACE = "codex/skills";

/** Omission surface prefix for one Codex skill (`codex/skills/<name>`). */
export const CODEX_SKILLS_SURFACE_PREFIX = CODEX_SKILLS_SURFACE + "/";

/** D6: Codex no longer has custom prompts, so a `prompts/` folder is not carried. */
export const CODEX_PROMPTS_OMISSION_REASON =
  "Codex removed custom prompts (openai/codex#16115); not carried";

/** R3: the reader could not read `config.toml`, so no Codex MCP server is exported. */
export const CODEX_TOML_UNREADABLE_REASON =
  "not exported: the Codex config.toml uses TOML the export cannot read safely, so no Codex MCP server was exported";

/**
 * An instructions file the export cannot read is recorded and stops the
 * search, so AGENTS.md never stands in for an override it could not read.
 */
export const CODEX_INSTRUCTIONS_UNREADABLE_REASON =
  "not exported: the Codex instructions file could not be read";

/** A Codex skills folder the export cannot list is recorded, not skipped. */
export const CODEX_SKILLS_UNREADABLE_REASON =
  "not exported: the Codex skills folder could not be read";

/** R6: a Claude Code skill (or an earlier Codex skill folder) already has this name. */
export const CODEX_SKILL_SHADOWED_REASON =
  "not exported: a skill with this name is already exported (Claude Code first, then ~/.agents/skills)";

/** D7: a link in a Codex skill or instructions file is never followed. */
export const CODEX_LINK_OMISSION_REASON =
  "not exported: a link inside the Codex configuration is not followed";

/** R5: the Claude Code configuration already has a rule named codex-agents. */
export const CODEX_RULE_SHADOWED_REASON =
  "not exported: the Claude Code configuration already has a rule at rules/codex-agents.md";

/**
 * The text around the server name (and the field list) in the two per-server
 * reasons below. Each dialect builds the same reason from these parts: the
 * name sits between plain double quotes, never JSON-escaped, so jq and
 * PowerShell (whose escapers differ) produce identical bytes.
 */
export const CODEX_SERVER_UNSUPPORTED_PARTS = [
  'not exported: the Codex MCP server "',
  '" uses TOML or settings the export cannot carry, so it was left out whole',
] as const;
export const CODEX_SERVER_DROPPED_PARTS = [
  'exported without these fields of the Codex MCP server "',
  '", which are not carried: ',
] as const;

/** R3: a server that leaves the accepted subset is dropped whole. */
export function codexServerUnsupportedReason(name: string): string {
  const [a, b] = CODEX_SERVER_UNSUPPORTED_PARTS;
  return a + name + b;
}

/** R4: the fields a server lost (names only, never values), comma-separated. */
export function codexServerDroppedFieldsReason(
  name: string,
  fields: readonly string[]
): string {
  const [a, b] = CODEX_SERVER_DROPPED_PARTS;
  return a + name + b + fields.join(", ");
}
