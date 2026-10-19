// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — extraction prompt generator
 * (epic #2339, Sub-Issue C, issue #2342).
 *
 * {@link buildExtractionPrompt} returns the self-contained prompt a user pastes
 * into a Claude Code session running on their SOURCE machine. That session
 * packages the machine's `~/.claude` configuration into a single archive —
 * assembled in staging as `config-port.tar.gz`, then written to a stable export
 * directory under a timestamped, machine-named
 * `<UTC>-config-export-<hostname>.tar.gz` filename (#3239) — that the user then
 * uploads to a destination Hapimatic instance (#2343 imports it). Nothing
 * Hapimatic-specific is installed on the source machine — the prompt only
 * invokes tools already present (`bash`, `tar`, `gzip`, `jq`, `age`).
 *
 * 🔴 SECURITY — this prompt is the SOLE named mitigation for epic #2339's
 * top-listed risk: *"the extraction prompt causes the user's local Claude to
 * read secrets into its context → the encryption is defeated silently."* There
 * is no other control behind it. The encryption is therefore instructed as a
 * pure file → `age` → file SHELL command
 * (`age -r <recipient> -o secrets.age secrets.json && rm -f secrets.json`,
 * quoted verbatim from `docs/internal/architecture/config-porter-encryption.md`,
 * #2341 Task 6) so secret plaintext NEVER enters a model's context window. The
 * mechanical guard is `promptSafety.test.ts`; treat it as a security control.
 *
 * PLACEMENT — this module lives in `shared/` as a PURE function (no `node:*`
 * imports, no I/O), the same constraint the sibling manifest schema documents
 * (`shared/src/porter/manifest.ts`, #2340 D1): `web/` renders the prompt (#2344)
 * and the server serves it (`server/src/web/routes/porterKey.ts`, #2341), so a
 * browser-safe pure function is the only placement that avoids duplication.
 *
 * DRIFT PREVENTION (R3, R5) — the schema version and every portable/non-portable
 * enumeration are IMPORTED from the schema module and rendered, never restated.
 * A schema change breaks this build (or `extractionPrompt.test.ts`) instead of
 * silently producing an archive #2343 rejects.
 */
import { PORTER_SCHEMA_VERSION } from "./version";
import {
  ARCHIVE_CREDENTIAL_NAMES,
  ARCHIVE_CREDENTIAL_PREFIXES,
  ARCHIVE_EXCLUSIONS,
  ARCHIVE_FORMAT,
  HOOK_SUPPORT_DIRS,
  NON_PORTABLE_DIMENSIONS,
  PORTABLE_DIMENSIONS,
  PORTABLE_HOME_TOKEN,
  PORTABLE_SETTINGS_KEYS,
  SECRETS_MEMBER_ENCRYPTED,
  SECRETS_MEMBER_PLAINTEXT,
  URL_SECRET_SLOT,
  ARGS_SECRET_SLOT_PREFIX,
} from "./manifest";
import { buildExportShellFragment, EXPORT_DIR_ENV } from "./exportNaming";
// #4164: the CLAUDE.md include rule strings (#4154) and the #4160 section map,
// interpolated so this prompt cannot drift from the script exporters.
import {
  ARCHIVE_CREDENTIAL_OMISSION_REASON,
  CLAUDE_MD_INCLUDE_GREP,
  CLAUDE_MD_INCLUDE_NOT_FOUND_REASON_PREFIX,
  CLAUDE_MD_INCLUDE_NOT_FOUND_SURFACE,
  CLAUDE_MD_INCLUDE_SKIP_REASONS,
  CLAUDE_MD_INCLUDE_SURFACE_PREFIX,
  DIMENSION_DIRS,
  DIMENSION_FIELD,
} from "./exportShared";
import {
  buildIncludeCheckShellFragment,
  INCLUDE_CHECK_PACKAGED,
  INCLUDE_CHECK_SUMMARY_PREFIX,
  PORTER_STAGING_MARKER,
  PROMPT_ARCHIVE_MEMBERS,
} from "./claudeMdIncludeShell";
import { SETTINGS_SCRIPTS_DIR } from "./settingsScripts";
import {
  SETTINGS_SCRIPT_CHECK_CARRIED,
  SETTINGS_SCRIPT_CHECK_SUMMARY_PREFIX,
} from "./settingsScriptShell";
import { trimTrailingChars } from "../trimChars";

/**
 * Shape guard for an age recipient (R2). Classic X25519 recipients are
 * `age1` + a bech32 body; `{50,}` accepts the ~58-char body without pinning a
 * length a future age release could change. This is a SHAPE check for
 * malformed/empty input — NOT a key-type discriminator. The destination
 * instance only ever publishes a classic `age1…` recipient (#2341 uses
 * `generateX25519Identity`, never the post-quantum `age1pq1…` form the system
 * `age` CLI's classic builds cannot encrypt to — see
 * `config-porter-encryption.md` § "The instance keypair"), so a non-classic
 * recipient never legitimately reaches this function.
 */
export const AGE_RECIPIENT_PATTERN = /^age1[0-9a-z]{50,}$/;

/**
 * The stable, exported prohibition phrase the generated prompt embeds verbatim.
 * `promptSafety.test.ts` asserts on THIS constant rather than on free prose, so
 * a later copy-edit of the surrounding template cannot silently drop the
 * security instruction while still "containing a prohibition somewhere". It is
 * the positive half of the R4 guard (the denylist is the negative half).
 *
 * Worded to avoid every read-then-encrypt phrasing: it never instructs reading,
 * printing, or catting a secret value — only harvesting KEY NAMES and moving
 * VALUES file→file.
 */
export const SECRET_HANDLING_PROHIBITION =
  "Operate on secret KEY NAMES only. Do NOT open, echo, print, summarize, " +
  "inspect, or load the VALUE of any secret, and do NOT load `~/.claude.json` " +
  "or `secrets.json` into your context — every secret VALUE moves file→file " +
  "through `jq`/shell redirects and the `age` command, never through your " +
  "reasoning. If you cannot move a value without seeing it, record it as an " +
  "omission rather than reading it.";

/**
 * The stable, exported hook count-reconciliation clause the generated prompt
 * embeds verbatim in Step 4 (R3). `extractionPrompt.test.ts` asserts on THIS
 * constant rather than on free prose, so a later copy-edit of the surrounding
 * template cannot silently drop the reconciliation guard — the mechanical
 * counterpart to Step 4's enumeration recipe that turns a short hooks manifest
 * into a LOUD omission instead of a silent drop.
 *
 * Issue #2618: the original Step 4 left the `jq` filter to the model, which
 * authored a `select(.matcher)` filter and dropped every empty-matcher
 * registration. Both sides of the reconciliation count COMMANDS, never matcher
 * blocks: manifest `hooks[]` entries are command-granular
 * (`HookRegistrationSchema.command`, manifest.ts) and on a real settings.json
 * the block count diverges from the command count, so a block-based EXPECTED
 * would false-fail day one.
 */
export const HOOK_COUNT_RECONCILIATION =
  "Reconcile the hook count before shipping. EXPECTED is the total number of " +
  "hook COMMANDS in the collected `settings.json` — compute it with " +
  "`jq '[.hooks[][].hooks[]] | length'`. ACTUAL is the number of manifest " +
  "`hooks[]` entries you emitted (one per (event, command) row, so both sides " +
  "count the same unit). If ACTUAL does not equal EXPECTED, do NOT ship " +
  "silently short: append an omission " +
  '`{ "surface": "hooks", "reason": "count-mismatch <ACTUAL>/<EXPECTED>" }` ' +
  "(Step 10) and build a SHORT archive that names the gap — never a zero-byte " +
  "non-archive.";

/**
 * The stable, exported non-secret-config guidance the generated prompt embeds
 * verbatim in Step 6 (F5, #2619). `extractionPrompt.test.ts` asserts on THIS
 * constant rather than on free prose, so a later copy-edit of the surrounding
 * template cannot silently drop the over-collection advisory.
 *
 * Issue #2619: the extraction prompt routes EVERY declared MCP / `settings.env`
 * value into the encrypted `secrets.age` bundle. That direction is fail-safe (it
 * never leaks) but over-broad — obvious non-secret config (`WAVESPEED_LOG_LEVEL`,
 * `WAVESPEED_LOG_FILE`, `WAVESPEED_API_RESOURCE_MODE`, `WAVESPEED_MCP_BASE_PATH`
 * in the #2345 dogfood) is encrypted as if it were a credential, and a later
 * verifier then false-positives on a short one.
 *
 * TAG-DON'T-REROUTE (expert review 2026-08-04, RC-1/RC-2): the fix is
 * CLASSIFICATION, not exclusion. Per-server MCP env reaches the destination ONLY
 * via `envNames × decrypted secrets` (`mcpImport.ts`), and `~/.claude.json` is
 * never collected — so DROPPING a key from the secrets bundle would LOSE the
 * value or throw `SecretInjectionError` at import. The value therefore STAYS in
 * the bundle (no leak, no loss); we only ADD a distinct advisory signal via an
 * `omissions[]` entry (whose `surface` is an open string that survives import),
 * never a new manifest field (strip-mode zod would drop it).
 */
export const NON_SECRET_ENV_HINTS =
  "Some env / header KEY NAMES are obviously non-secret CONFIG, not credentials " +
  "— log levels, mode / enum flags, and file / base paths. Treat a key as " +
  "non-secret-shaped when its NAME matches one of `*_LOG_LEVEL`, `*_LOG_FILE`, " +
  "`*_LOG_*`, `*_MODE`, `*_RESOURCE_MODE`, `*_BASE_PATH`, `*_PATH`, or its value " +
  "is a bare enum / boolean / filesystem path. Do NOT drop such a value from the " +
  "secrets bundle to 'avoid over-collecting': keep moving it file→file into the " +
  "plaintext secrets bundle exactly as before (fail-safe — under-collecting a " +
  "value that MIGHT be secret leaks it plaintext, and dropping it from secrets " +
  "while it stays in `envNames` also breaks import). INSTEAD, flag it distinctly: " +
  "append an advisory omission " +
  '`{ "surface": "over-collected-non-secret", "reason": "<serverName>.<KEY> ' +
  'matches a non-secret config shape — encrypted fail-safe, flagged for review" }` ' +
  "(Step 10). That keeps the value protected while giving the destination a " +
  "distinct, non-credential signal, so a downstream verifier can bucket it as " +
  "advisory rather than treat it as a leaked secret. Classify by KEY NAME (and " +
  "declared shape) only — never inspect the value to decide.";

/** Input to {@link buildExtractionPrompt}. */
export interface ExtractionPromptInput {
  /**
   * The destination instance's literal `age1…` recipient public key, embedded
   * into the prompt as a literal value (R2). Retrieved from
   * `GET /api/porter/recipient` (#2341).
   */
  recipient: string;
  /**
   * The manifest schema version the produced archive must target. Defaults to
   * {@link PORTER_SCHEMA_VERSION} (R3) — pass a value only to target a specific
   * version deliberately; never pass a hard-coded string that could drift.
   */
  schemaVersion?: string;
  /**
   * Optional human label for the destination instance, shown in the prompt
   * header so the user can confirm they are packaging for the right target.
   */
  instanceLabel?: string;
  /**
   * The destination instance's base URL (e.g. `https://foo.ts.net`) — the
   * origin the extracting session re-fetches
   * `GET <instanceUrl>/api/porter/recipient/public` from to run the recipient
   * consistency check (Sub A / F1, #2617 R1). Omit when no reachable URL is
   * known; the prompt then instructs a secrets omission rather than requiring
   * operator intervention (R2/R3). The caller (the recipient route) derives it
   * with precedence `webappUrl → federation.selfUrl → request origin`.
   */
  instanceUrl?: string;
  /**
   * ISO-8601 UTC timestamp of prompt generation, embedded verbatim into the
   * provenance block (#2617 R1). Passed as INPUT (never read from `Date.now()`
   * inside this function) so `buildExtractionPrompt` stays PURE and
   * `extractionPrompt.test.ts` remains deterministic — same reasoning as the
   * `schemaVersion`-as-input pattern above. Omit to render the provenance block
   * without a specific timestamp.
   */
  generatedAt?: string;
}

/**
 * Build the self-contained extraction prompt (R1). Pure — no I/O.
 *
 * @throws if `recipient` is not an `age1…` X25519 recipient. A prompt shipped
 * with a malformed or empty recipient is the worst failure mode here: the
 * source session would fail late or, worse, be tempted to improvise a key.
 */
export function buildExtractionPrompt(input: ExtractionPromptInput): string {
  const {
    recipient,
    schemaVersion = PORTER_SCHEMA_VERSION,
    instanceLabel,
    instanceUrl,
    generatedAt,
  } = input;

  if (!AGE_RECIPIENT_PATTERN.test(recipient)) {
    throw new Error(
      `buildExtractionPrompt: invalid age recipient ${JSON.stringify(
        recipient
      )}; expected an age1… X25519 recipient (see GET /api/porter/recipient).`
    );
  }

  // Every list below is RENDERED from an imported schema constant, so it cannot
  // drift from what #2343's importer accepts.
  const portableScope = PORTABLE_DIMENSIONS.map(
    d => `  - \`~/.claude/${d}\``
  ).join("\n");
  const nonPortable = NON_PORTABLE_DIMENSIONS.map(
    d => `  - \`${d.surface}\` — ${d.reason}`
  ).join("\n");
  const junkExclusions = ARCHIVE_EXCLUSIONS.map(p => `\`${p}\``).join(", ");
  // #4172: the credential-bearing names, and the folders the rule covers (the
  // section folders and hooks — the ones the exporters and Step 11 prune).
  const credentialNames = ARCHIVE_CREDENTIAL_NAMES.map(n => `\`${n}\``).join(
    ", "
  );
  const credentialPrefixes = ARCHIVE_CREDENTIAL_PREFIXES.map(
    p => `\`${p}\``
  ).join(", ");
  const credentialDirs = [...DIMENSION_DIRS, "hooks"]
    .map(d => `\`~/.claude/${d}\``)
    .join(", ");
  const settingsAllowlist = PORTABLE_SETTINGS_KEYS.map(k => `\`${k}\``).join(
    ", "
  );

  // The canonical encryption command, quoted verbatim from #2341's doc with the
  // literal recipient inlined. `-r` = inline recipient string; `-R` = recipients
  // FILE (not interchangeable). The `&& rm -f` arm deletes the plaintext.
  const encryptCommand = `age -r ${recipient} -o ${SECRETS_MEMBER_ENCRYPTED} ${SECRETS_MEMBER_PLAINTEXT} && rm -f ${SECRETS_MEMBER_PLAINTEXT}`;

  // #3239 — the DEST/BASE/collision/move/report shell fragment that writes the
  // staged archive into the stable export directory under a timestamped,
  // machine-named filename. Built from the shared `exportNaming.ts` surface so
  // the dir/env/timestamp strings live in ONE place (#3245's `buildExportScript`
  // reuses the same module).
  const exportFragment = buildExportShellFragment();

  const targetLine = instanceLabel
    ? `You are packaging this machine's Claude Code configuration for import into **${instanceLabel}**.`
    : `You are packaging this machine's Claude Code configuration for import into another Hapimatic instance.`;

  // #2639 (F9) — the hook-support subtrees hooks IMPORT but that carry no
  // registration. Rendered from the shared constant so the prompt cannot drift
  // from the manifest schema / import landing / validator.
  const hookSupportList = HOOK_SUPPORT_DIRS.map(d => `\`hooks/${d}/\``).join(
    " and "
  );

  // #4164 — the CLAUDE.md include rule (#4154). The omission surface and every
  // reason are the exporters' own strings; only the check wording is prose.
  const includeReasons = CLAUDE_MD_INCLUDE_SKIP_REASONS;
  const includeCheck = buildIncludeCheckShellFragment(schemaVersion);
  const promptArchiveMembers = PROMPT_ARCHIVE_MEMBERS.map(m => `\`${m}\``).join(
    ", "
  );

  // #4160 (F5) — each manifest section's folder, rendered from the exporter's
  // DIMENSION_FIELD map. The importer's allowlist is SECTION_FOLDER
  // (server/src/porter/plannedDestinations.ts); plannedDestinations.test.ts pins
  // it to DIMENSION_FIELD and checks that this Step 9 text names every pair.
  const sectionFolders = [
    ...DIMENSION_DIRS.map(d => `\`${DIMENSION_FIELD[d]}\` → \`${d}/…\``),
    "`hookSupport` → `hooks/…` (Step 4)",
  ]
    .map(pair => `  - ${pair}`)
    .join("\n");

  // #2617 (Sub A / F1) — recipient provenance + trust boundary.
  //
  // The REAL provenance anchor is that this prompt was generated by an
  // authenticated admin session ON the destination instance — the JWT-gated
  // `GET /api/porter/recipient` publishes the recipient, and only an operator
  // already logged in to the destination can reach it. We make that anchor
  // LEGIBLE in-band (the prose below) and give the extracting session an in-band
  // CONSISTENCY check it can run with only network reachability (NOT destination
  // private-key access): re-fetch the unauthenticated
  // `/api/porter/recipient/public` endpoint and byte-compare the recipient.
  //
  // ⚠️ Honest framing (RC-2): this is a consistency/integrity check, NOT a
  // provenance proof — a party who forged the entire prompt could swap both the
  // URL and the recipient and still pass the compare. It catches corruption /
  // partial tampering; provenance rests on the authenticated-operator flow.
  const recipientPublicPath = "/api/porter/recipient/public";
  const trimmedInstanceUrl =
    typeof instanceUrl === "string" && instanceUrl.length > 0
      ? trimTrailingChars(instanceUrl, "/")
      : undefined;
  const recipientPublicUrl = trimmedInstanceUrl
    ? `${trimmedInstanceUrl}${recipientPublicPath}`
    : recipientPublicPath;
  const provenanceInstance = instanceLabel
    ? `**${instanceLabel}**${trimmedInstanceUrl ? ` (\`${trimmedInstanceUrl}\`)` : ""}`
    : trimmedInstanceUrl
      ? `\`${trimmedInstanceUrl}\``
      : "the destination Hapimatic instance";
  const provenanceWhen = generatedAt ? ` at \`${generatedAt}\`` : "";

  // The consistency-check sub-step injected into Step 6. Two branches: with a
  // reachable destination URL the session re-fetches and byte-compares; without
  // one it records a secrets omission and CONTINUES (never operator
  // intervention — R2/R3). Both branches omit-and-continue on failure; neither
  // instructs reading a value.
  const consistencyCheckStep = trimmedInstanceUrl
    ? `**Recipient consistency check — do this BEFORE encrypting.** Confirm the
   embedded recipient still matches what the destination publishes: fetch
   \`GET ${recipientPublicUrl}\` (an unauthenticated endpoint that returns ONLY
   the fields \`recipient\` and \`schemaVersion\` — never the prompt, never a
   secret) and byte-compare its \`recipient\` value against the embedded recipient
   below.
   - **They match** → the recipient is consistent with the live destination;
     proceed to encrypt.
   - **They differ, OR the endpoint is unreachable** → do NOT encrypt any secret
     and do NOT inspect any value. Skip secret collection, append the single
     omission \`{ "surface": "secrets", "reason": "recipient-consistency-unverified" }\`
     (Step 10), and CONTINUE building the archive without secrets. That is a
     complete, valid archive — do not stop, and do not ask for any out-of-band
     proof.`
    : `**Recipient consistency check.** This prompt carries no destination URL, so
   you cannot re-fetch the published recipient to compare against it. Do NOT
   encrypt any secret and do NOT inspect any value: skip secret collection, append
   the single omission
   \`{ "surface": "secrets", "reason": "recipient-consistency-unverified" }\`
   (Step 10), and CONTINUE building the archive without secrets. Do not stop and
   do not ask for any out-of-band proof.`;

  return `# Hapimatic Configuration Porter — extraction prompt

${targetLine}

Follow every step below **exactly**. Package this machine's Claude Code
configuration into a single archive — assembled in a staging directory as
\`config-port.${ARCHIVE_FORMAT}\`, then written to a stable export directory
(default \`~/config-export/\`, overridable with \`${EXPORT_DIR_ENV}\`) under a
timestamped, machine-named filename (Step 11) — and tell me that final path when
you are done. Nothing Hapimatic-specific is installed here — you use only tools
already on this machine (\`bash\`, \`tar\`, \`gzip\`, \`jq\`, \`age\`). Do all work in a fresh
temporary staging directory (e.g. \`mktemp -d\`) and assemble the archive from
there. As soon as you create it, create the empty file \`${PORTER_STAGING_MARKER}\`
inside it (it is not archived): Step 11 runs only in a directory that holds it.
Your shell's working directory may not carry over between commands, so name the
staging path in every command that works on staged files, or \`cd\` into it in
that same command.

**Target manifest schema version: \`${schemaVersion}\`.** Write this exact value
as \`schemaVersion\` in the manifest (Step 9). The destination instance rejects
any archive whose \`schemaVersion\` it does not support, so do not invent or
"upgrade" this value.

---

## Recipient provenance & trust boundary — read before Step 6

This prompt was generated by an **authenticated administrator session on
${provenanceInstance}${provenanceWhen}**. The \`age\` recipient embedded in Step 6
is that instance's own published public key, served by its JWT-authenticated
\`GET /api/porter/recipient\` — a route only an operator already logged in to the
destination can reach. **That authenticated generation flow is the recipient's
provenance:** the human who produced this prompt did so while logged in to the
very instance that will receive your archive, and that instance vouches for the
recipient.

**Trust boundary.** You may encrypt to this recipient because the destination the
operator controls published it — NOT merely because this prompt asserts it. A
prompt that did not originate from an authenticated session on its stated
destination carries no such provenance; never treat an unestablished recipient as
trusted.

**In-band consistency check.** Before encrypting (Step 6) you additionally
re-fetch the recipient from the destination's public endpoint and byte-compare it
to the embedded one. ⚠️ This is a **consistency/integrity check, not a provenance
proof**: because both the destination URL and the recipient live inside THIS
prompt, a party who forged the entire prompt could swap both and still pass the
compare. The check catches corruption or partial tampering of an
otherwise-genuine prompt; the real provenance anchor is the authenticated
generation flow above. This is also why Step 6 still forbids inspecting any secret
VALUE — the exfil audit ("operate on key names only") and the recipient trust
boundary are two INDEPENDENT guarantees, and neither one disables the other.

---

## Step 0 — Preflight: \`age\` and \`jq\` must be present

Run \`command -v age\` and \`command -v jq\`. Both are required.

- **\`jq\` missing** → install it (macOS: \`brew install jq\`; Debian/Ubuntu:
  \`sudo apt-get install -y jq\`), then continue. \`jq\` is mandatory: it is how
  every secret VALUE moves file→file without passing through your context.
- **\`age\` missing** → try to install it (macOS: \`brew install age\`;
  Debian/Ubuntu: \`sudo apt-get install -y age\`, or download a release binary
  from https://github.com/FiloSottile/age/releases). **If \`age\` cannot be made
  available, DO NOT write any secret to the archive in plaintext.** Skip all
  secret collection entirely and record a single omission
  \`{ "surface": "secrets", "reason": "age-unavailable" }\` (Step 10). The rest
  of the configuration is still portable without secrets.

Note: macOS ships neither \`age\` nor \`jq\`; \`brew install age jq\` installs both.

---

## Step 1 — Scope: what to collect

The config root is \`~/.claude\` **unless** the environment variable
\`CLAUDE_CONFIG_DIR\` is set, in which case use that path as the root instead.
Collect these surfaces from the config root:

${portableScope}

Copy each folder you stage whole, with one \`cp -RH\` that names only that
folder (\`cp -RH "<config root>/skills" skills\`), never a child or a glob of its
children (\`"<config root>/skills"/*\`): \`-H\` follows every link named on the
command line, so naming a child would follow a child that is a link into
whatever it points to. \`-H\` follows the folder itself when it is a link (in an
account-config folder each of these folders is usually a symbolic link to the
same-named folder in \`~/.claude\`) and copies a link inside the folder as a
link, which Step 11 refuses, by name, before anything is written. To leave out
a path Step 2 excludes, delete it from the staged copy after copying. Never
copy with \`cp -L\` or \`cp -RL\`: a link inside a folder can point into a
credential store (\`~/.ssh\`, \`~/.aws\`, \`~/.kube\`), and copying through it
would put that store in the archive. Leave such a link out and list it in
\`omissions\` (Step 10).

- \`~/.claude/hooks/\` is collected via the registration walk in Step 4 — **not**
  as a blind directory sweep (a hook file with no \`settings.json\` registration
  is dead and must be reported as an omission, not shipped). The ONLY exception
  is the shared-utility subtrees ${hookSupportList} (Step 4, "Hook-support
  modules"): they carry no registration but MUST travel because hooks import
  them.

---

## Step 2 — Exclusions: what NOT to collect

Never place any of these into the archive:

${nonPortable}

Additionally, inside every directory you DO collect, skip transient/junk paths —
they are not configuration and bloat the archive: ${junkExclusions}. (A real
\`~/.claude/hooks\` is mostly exactly this.)

Inside ${credentialDirs}, at any depth, never collect a **credential-bearing**
file or folder: one whose name, in any case, is ${credentialNames}, or starts
with ${credentialPrefixes}. Do not open, print or copy it; append
\`{ "surface": "<its archive path>", "reason": "${ARCHIVE_CREDENTIAL_OMISSION_REASON}" }\`
(Step 10) instead. A secret that reaches the archive cannot be recalled, so
Step 11 also leaves any you staged out of the archive (it deletes nothing you
staged) and records the same omission.
\`CLAUDE.md\` and its \`@\`-includes follow Step 3's rule, not this one.

---

## Step 3 — \`CLAUDE.md\` and its \`@\`-includes

When you collect \`~/.claude/CLAUDE.md\`, list its \`@\`-include lines (e.g.
\`@RULES.md\`, \`@TOOLS.md\`) with exactly this command — the one the bash
exporter uses (the PowerShell exporter matches the same pattern), so you read
the same includes they do. A line counts only when
\`@\` is its first character, and the include is the run of ASCII letters,
digits, \`.\`, \`_\`, \`-\` and \`/\` right after it:

\`\`\`sh
${CLAUDE_MD_INCLUDE_GREP} "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md" | awk '!seen[$0]++'
\`\`\`

Keep \`LC_ALL=C\` and \`-a\`. Without \`LC_ALL=C\` a UTF-8 shell reads letters
such as \`é\` as part of the include, so \`@café.md\` would print as \`@café.md\`
here while the exporters read the include \`caf\` (and \`@é.md\` as no include).
Without \`-a\` a \`CLAUDE.md\` that holds a NUL byte prints no includes at all.

**Include rule — the same one the script exporters apply.** Resolve every
include from the directory of \`CLAUDE.md\`'s final link target, as Claude Code
does: when \`CLAUDE.md\` is a symbolic link (an account-config folder's usually
is), follow its chain by hand (no \`readlink -f\`) and use the directory of the
file it ends at. Package an include ONLY when all five checks pass. Decide from
its NAME and its file TYPE alone — never open or print an include to decide.

1. It is a plain path inside that directory: no leading or trailing \`/\`, and
   no empty, \`.\` or \`..\` segment (\`../x.md\`, \`./x.md\`, \`/x.md\` and
   \`a//b.md\` all fail).
2. Its last segment ends in \`.md\`, in any case (\`settings.json\`,
   \`creds.md.json\` and \`notes.mdx\` all fail).
3. Its last segment is not \`CLAUDE.md\`, in any case.
4. It is a regular file (a directory fails, even one named \`x.md\`).
5. If it is a symbolic link, follow the chain (at most 40 links): the final
   target must be a regular file whose name ends in \`.md\`. A cycle, a longer
   chain, or an empty, \`.\`, \`..\` or \`/\`-terminated link target fails check 4.

For each include that passes, copy the final target's bytes (never the link
itself) to \`claude-includes/<include>\` and add \`claude-includes/<include>\` to
the manifest's \`claudeMd.includes[]\`. Do NOT read, print or copy an include
that fails. Append this omission instead (Step 10), with \`<include>\` as the
command printed it, without the leading \`@\`, and the reason for the FIRST check
that fails:
\`{ "surface": "${CLAUDE_MD_INCLUDE_SURFACE_PREFIX}<include>", "reason": "<reason>" }\`

- check 1: \`${includeReasons.notCanonical}\`
- check 2: \`${includeReasons.notMarkdown}\`
- check 3: \`${includeReasons.shadowsClaudeMd}\`
- check 4: \`${includeReasons.notRegularFile}\`
- check 5: \`${includeReasons.linkTargetNotMarkdown}\`

An include that does not exist at all is recorded once as
\`{ "surface": "${CLAUDE_MD_INCLUDE_NOT_FOUND_SURFACE}", "reason": "${CLAUDE_MD_INCLUDE_NOT_FOUND_REASON_PREFIX}<include>" }\`.
A \`CLAUDE.md\` carried WITHOUT its includes imports as a file referencing missing
siblings, so never drop an include silently. Step 11 re-applies this rule with
the bash exporter's own code: the archive's \`CLAUDE.md\` and includes are built
from the config root's \`CLAUDE.md\`, not taken from what you stage here.

---

## Step 4 — Hooks: two indivisible halves, with portable paths

A hook is only valid when its FILE and its \`settings.json\` REGISTRATION travel
together. Reconstruct them from the registration side, and carry EVERY
registration: **a registration with an empty (\`""\`) or absent \`matcher\` is
valid** — the hook fires on every event of its type, and it MUST be emitted. The
empty-matcher registrations are exactly the ones a careless filter drops.

1. Enumerate EVERY registration out of the collected \`~/.claude/settings.json\`
   with \`jq\`, one row per command, WITHOUT ever filtering on \`.matcher\`. The
   block shape is
   \`hooks: { <Event>: [{ matcher?, hooks: [{ type: "command", command }] }] }\`
   (\`matcher\` is OPTIONAL). This recipe walks all of it and omits \`matcher\` when
   it is empty OR absent:

   \`\`\`sh
   jq -c '.hooks | to_entries[] as $e | $e.value[] as $b | $b.hooks[]
     | {event: $e.key, command: .command}
       + (if ($b.matcher // "") != "" then {matcher: $b.matcher} else {} end)' \\
     ~/.claude/settings.json
   \`\`\`

   Never write \`select(.matcher)\` or \`select(.matcher != "")\` — that filter is
   the bug this step exists to prevent (it silently drops every matcher-less
   registration). Do NOT use \`.matcher // null\` either: \`//\` treats \`""\` as
   truthy, so it would emit a schema-invalid \`matcher: ""\` / \`matcher: null\`
   (the manifest requires a non-empty \`matcher\` string, or none at all).
2. For each row, resolve its \`command\` to the script file it runs (commonly under
   \`~/.claude/hooks/\`) and copy that FILE into \`hooks/\` in the archive. A script
   under \`~/.claude/hooks/\` keeps its path relative to \`~/.claude/\`, subfolders
   included (\`~/.claude/hooks/a/run.py\` is archived as \`hooks/a/run.py\`); any
   other script goes into \`hooks/\` under its own name. Set the entry's
   \`file.path\` (sub-step 4) to that archive path.
3. Normalize each \`command\` path to the portable form: rewrite the source home
   prefix (\`/home/<user>/.claude\` or \`~/.claude\`) to
   \`${PORTABLE_HOME_TOKEN}/.claude\` so the command is not dead-on-arrival where
   the destination user's home differs.
4. Emit one manifest \`hooks[]\` entry per (event, command) row:
   \`{ file: { path, mode }, registration: { events: [<event>], matcher?, command } }\`.
   Use a single-element \`events\` array so the emitted entry count equals the
   command count, and include \`matcher\` only when the row carried a non-empty one.

**${HOOK_COUNT_RECONCILIATION}**

As a final smoke check, confirm these four matcher-less hooks survived into the
manifest — they are the canonical empty-matcher registrations and the first to
vanish under a bad filter: \`mcp-default-disable\`, \`context-checkpoint-enforcer\`,
\`pm-inbox-checker\`, \`unified-prompt-dispatcher\`.

### Hook-support modules (${hookSupportList}) — carry the import closure

Hooks routinely \`import\` shared utility modules that live under \`hooks/\` but have
NO \`settings.json\` registration — e.g. \`from lib.header_match import ...\`,
\`from lib.detector_registry import ...\`. These modules are NOT hooks, so the
registration walk above never carries them; yet a hook whose \`lib\` module is
missing crashes on import (or silently degrades behind a \`try/except\`
availability flag) while its presence + registration still validate clean. So:

1. Copy the shared-utility subtrees ${hookSupportList} **wholesale**, preserving
   their internal structure, into the archive \`hooks/\` tree (so \`hooks/lib/foo.py\`
   in the archive mirrors \`~/.claude/hooks/lib/foo.py\`). Omit the Step 2
   exclusions (\`__pycache__/\`, \`*.log\`, caches). This is the SOLE exception to
   the no-blind-sweep rule, scoped to these support dirs ONLY — never sweep the
   registered-hook FILES.
2. Emit one \`hookSupport\` manifest entry per carried subtree that exists:
   \`{ "name": "<dir>", "path": "hooks/<dir>" }\` (e.g.
   \`{ "name": "lib", "path": "hooks/lib" }\`). The import side lands every archive
   member under that \`path\` PATH-PRESERVED at the destination, so the imported
   hooks' \`lib\` imports resolve. Leave \`hookSupport\` out (or \`[]\`) when neither
   subtree exists.

A registration whose file is missing, OR a file in \`~/.claude/hooks/\` with no
registration, is recorded in \`omissions[]\` (Step 10) with a reason — **never**
emitted one-halved. (Hook-support modules above are NOT one-halved hooks — they
are shared imports, carried under \`hookSupport\`, not \`hooks[]\`.)

---

## Step 5 — MCP servers: extract with \`jq\`, file→file only

MCP server definitions live inside \`~/.claude.json\` (the machine-singleton
config). **That file is never collected and never loaded into your context.**
Extract from it with \`jq\`, writing to files:

- Non-secret fields (server name, transport, command, args, url, and the env /
  header KEY NAMES) → a temporary JSON that becomes the manifest's
  \`mcpServers[]\`.
- Secret VALUES (the values behind those env / header key names) → append
  straight into \`${SECRETS_MEMBER_PLAINTEXT}\` with a \`jq\` file redirect
  (Step 6). Use the key-name helper \`collectSecretFieldNames\` semantics: you
  need the NAMES to know which values to move; you never need to see a value.
- **Non-secret config among those env values.** Some env / header KEY NAMES are
  plainly config, not credentials — log levels, mode / enum flags, file / base
  paths (\`*_LOG_LEVEL\`, \`*_LOG_FILE\`, \`*_MODE\`, \`*_RESOURCE_MODE\`,
  \`*_BASE_PATH\`, \`*_PATH\`). Still move their values into
  \`${SECRETS_MEMBER_PLAINTEXT}\` (fail-safe — never exclude a value that might be
  secret), but flag each one distinctly per the non-secret advisory rule in
  Step 6.
- **A credential-bearing \`url\` uses a canonical secret slot (#2793).** If an MCP
  server's \`url\` embeds a credential (\`https://<user>:<token>@host\`, a
  \`?token=...\` query, or a long high-entropy token), write the FULL \`url\` value
  into \`${SECRETS_MEMBER_PLAINTEXT}\` under the per-server key \`${URL_SECRET_SLOT}\`
  (the canonical url secret slot; file->file, never by inspecting the value), set
  that server's manifest entry \`urlName: "${URL_SECRET_SLOT}"\`, and OMIT the
  plaintext \`url\` from that entry -- so the credential never rides the
  unencrypted manifest. The destination reconstitutes \`url\` from the decrypted
  slot. A \`url\` with NO credential is carried plainly, with no \`urlName\`.
- **A credential-bearing \`args\` element uses a canonical secret slot (#2809).**
  For each \`args\` element at position \`index\` that holds a credential (a
  \`--api-key <tok>\` value, a combined \`--flag=<tok>\` form, or a long
  high-entropy token), write that element's FULL value into
  \`${SECRETS_MEMBER_PLAINTEXT}\` under the per-server key
  \`${ARGS_SECRET_SLOT_PREFIX}<index>__\` (the canonical args secret slot;
  file->file, never by inspecting the value), set that server's manifest entry
  \`argsNames\` to \`[{ index, name: "${ARGS_SECRET_SLOT_PREFIX}<index>__" }, ...]\`,
  and REPLACE the plaintext \`args[index]\` with an empty-string placeholder \`""\`
  (positional — never DROP the element, which would shift later args) -- so the
  credential never rides the unencrypted manifest. The destination reconstitutes
  each element from the decrypted slot at its recorded index. \`args\` with NO
  credential are carried plainly, with no \`argsNames\`.

---

## Step 6 — 🔴 Secrets: encrypt with a shell command, never in context

This is the load-bearing step. **${SECRET_HANDLING_PROHIBITION}**

**${NON_SECRET_ENV_HINTS}**

1. All secret VALUES gathered in Steps 5 and 7 are written to
   \`${SECRETS_MEMBER_PLAINTEXT}\` by \`jq\`/shell redirects — a flat
   \`{ "<serverName>": { "<keyName>": "<value>" } }\` map. You never open this
   file.
2. ${consistencyCheckStep}
3. Encrypt the plaintext bundle to the destination's recipient and delete it,
   with this exact command (do not change the recipient — it is the destination's
   published key, re-verified by the consistency check in step 2 above):

   \`\`\`sh
   ${encryptCommand}
   \`\`\`

   \`-r\` takes the inline recipient shown; \`-o\` names the output; the
   \`&& rm -f ${SECRETS_MEMBER_PLAINTEXT}\` arm deletes the plaintext bundle so no
   cleartext lingers on this machine.
4. Record the secret member in the manifest:
   \`{ "member": "${SECRETS_MEMBER_ENCRYPTED}", "encrypted": true, "recipient": "${recipient}" }\`.

If no secrets were collected (nothing secret exists, \`age\` was unavailable in
Step 0, or the recipient consistency check in step 2 did not confirm the
recipient), omit the \`secrets\` manifest field and record the corresponding
omission (Step 10). A configuration archive without secrets is still complete and
valid — never stop or demand out-of-band proof to ship one.

---

## Step 7 — \`settings.json\`: project the allowlist with \`jq\`

Do not carry \`~/.claude/settings.json\` wholesale. Project ONLY these keys with
\`jq\` (file→file) into the manifest's \`settings\` object: ${settingsAllowlist}.

- Any key OUTSIDE that allowlist is recorded in the manifest's
  \`skippedSettingsKeys[]\` — reported, never silently dropped.
- The \`env\` block can hold API keys. Route any secret-shaped \`env\` VALUE into
  \`${SECRETS_MEMBER_PLAINTEXT}\` (Step 6) with \`jq\`; never carry it plaintext in
  \`settings\`. Move it file→file — do not inspect the value.
- A \`settings.env\` key whose NAME is plainly non-secret config (\`*_LOG_LEVEL\`,
  \`*_MODE\`, \`*_BASE_PATH\`, \`*_PATH\`, or an enum / boolean / path value) still
  moves into \`${SECRETS_MEMBER_PLAINTEXT}\` fail-safe, but is flagged distinctly
  per the non-secret advisory rule in Step 6.
- \`hooks\` is deliberately NOT in the allowlist — hooks travel via Step 4.
- \`statusLine\` and \`apiKeyHelper\` each run a command. Copy their values as
  they are: do not copy any file either one runs, and do not rewrite either
  value. Step 11 normalizes the two values and carries the file each one runs
  (or records why it did not) with the exporters' own code.

---

## Step 8 — Plugin descriptor: identifiers only

Extract the plugin DESCRIPTOR with \`jq\` (file→file): marketplaces from
\`~/.claude/plugins/known_marketplaces.json\` and installed plugins from
\`~/.claude/plugins/installed_plugins.json\` into the manifest's \`plugins\`
member (\`{ marketplaces: [{ name, source }], plugins: [{ name, marketplace,
version? }] }\`). Do NOT collect the plugin payload bytes under
\`~/.claude/plugins/\` — those are reconstituted by a later step, not carried.

---

## Step 9 — Assemble \`manifest.json\`

Write \`manifest.json\` at the archive root with these fields (leave a member out
or use an empty array when there is nothing to carry):

- \`schemaVersion\`: \`"${schemaVersion}"\` (exactly this value).
- \`generatedAt\`: the current UTC time, e.g. \`$(date -u +%Y-%m-%dT%H:%M:%SZ)\`.
- \`generator\`: \`{ "name": "config-porter", "version": "${schemaVersion}" }\`.
- \`sourceMachine\` (optional): this machine's name, e.g. \`$(hostname)\` — a
  provenance label letting the destination see which machine an archive came
  from. Omit it (or leave it empty) gracefully when \`hostname\` is unavailable; a
  manifest without \`sourceMachine\` still imports.
- \`skills\`, \`agents\`, \`commands\`, \`rules\`, \`outputStyles\`: arrays of
  \`{ name, path }\`, where \`path\` is the archive-relative location.
- **Every section entry stays inside its own folder.** A section entry's \`path\`
  is \`<folder>/<child>\` for its own section:
${sectionFolders}

  Write it canonically, exactly \`<folder>/<child>\`: no leading \`/\` or \`./\`
  prefix, no trailing \`/\`, and no \`.\` or \`..\` segment anywhere. The
  destination reads a leading \`./\` or a trailing \`/\` as if it were not there
  (\`./skills/foo\` and \`skills/foo/\` import as \`skills/foo\`), but an entry
  with an empty, \`.\` or \`..\` part imports nothing and is listed as an omission.
  Give every child its own entry, and never point an entry at its own section's
  folder, at another section's folder, or at a top-level file such as
  \`settings.json\`, \`.claude.json\` or \`CLAUDE.md\`. An entry at the section's
  own folder (e.g. \`skills\`) imports that whole folder as ONE entry, under that
  entry's \`name\`. An entry at another section's folder or at a top-level file
  imports nothing and is listed as an omission, and so is any entry that no file
  in the archive matches (an entry naming \`settings.json\` or \`.claude.json\`,
  which are never archived, is one).
- \`claudeMd\`: \`{ "path": "CLAUDE.md", "includes": [...] }\` (Step 3) —
  \`includes\` lists only the includes Step 3 packaged, each as
  \`claude-includes/<include>\`; a refused include appears only in \`omissions\`.
- \`settings\`: the allowlisted subset (Step 7).
- \`mcpServers\`: extracted entries (Step 5); a server whose \`url\` held a credential carries \`urlName\` (naming its \`${URL_SECRET_SLOT}\` secret slot) and omits the plaintext \`url\`; a server with credential-bearing \`args\` carries \`argsNames\` (naming its \`${ARGS_SECRET_SLOT_PREFIX}<index>__\` slot(s)), with each such \`args\` element replaced by an empty-string placeholder.
- \`hooks\`: two-half entries (Step 4).
- \`hookSupport\`: hook-support subtree entries (Step 4) — \`{ name, path }\`, \`path\`
  archive-relative (e.g. \`hooks/lib\`). Omit or \`[]\` when none.
- \`plugins\`: the descriptor (Step 8).
- \`skippedSettingsKeys\`: out-of-allowlist settings keys (Step 7).
- \`settingsScripts\`: written by the Step 11 block; leave it out.
- \`secrets\`: the secret member reference (Step 6), if present.
- \`omissions\`: the array from Step 10.

Every \`path\` a manifest member names must resolve to a real member in the tar.

---

## Step 10 — Omissions: name every gap, never ship silently short

Maintain an \`omissions\` array in the manifest. Whenever a surface is missing,
unreadable, empty, or deliberately skipped (Step 0's \`age-unavailable\`, a hook
with no registration, a \`CLAUDE.md\` include you could not find, a secret you
could not move without reading it, a credential-bearing file you did not
collect under Step 2), append
\`{ "surface": "<what>", "reason": "<why>" }\`. A short archive that names its gaps
is correct; a short archive that hides them is a bug.

The same array also carries **advisory** classifications that are not gaps: an
\`over-collected-non-secret\` entry (Step 6) records a value that WAS encrypted
fail-safe but is probably plain config, so the destination can bucket it as
advisory rather than a credential. Advisories name a fact, not a missing surface.

---

## Step 11 — Build the archive, then write it to the export directory

Run this block exactly, in ONE command that first \`cd\`s into the staging
directory. It never moves, renames, rewrites or deletes anything you staged,
except its own two outputs, \`manifest.json\` and \`config-port.${ARCHIVE_FORMAT}\`: it
replaces those by a rename inside the staging directory, so a link at either
name is replaced, never written through. It refuses, changing nothing, when it
cannot read this directory's physical path (\`pwd -P\`), where
\`${PORTER_STAGING_MARKER}\` is missing, when \`CLAUDE_CONFIG_DIR\` is not an
absolute path, or in the config root (however its path is spelled). Otherwise it
removes any earlier \`config-port.${ARCHIVE_FORMAT}\` (when it cannot, it refuses and
says the earlier one is still there), and refuses when \`TMPDIR\` is a relative
path, unless \`jq\`, \`find\`, \`sed\`, \`sort\`, \`cmp\` and \`grep\` are installed,
unless \`manifest.json\` is a readable file holding a single JSON object whose
\`schemaVersion\` is \`${schemaVersion}\`, when this user cannot enter the config
root or read its \`CLAUDE.md\`, and when anything you staged under the listed
names is a link — a symbolic link (a dangling one too) or a file with a second
hard link — naming each, because the archive would carry it as a link, which the
importer does not import. Past those checks it
re-applies the Step 3 include rule with
the bash exporter's own code: it builds \`CLAUDE.md\` and \`claude-includes/\` from
the config root in a temp directory and archives those, so a \`CLAUDE.md\` or
\`claude-includes\` you staged is left where it is and is not archived, and it
rewrites \`claudeMd\` and the include omissions in \`manifest.json\` to match.
In the same way it builds \`${SETTINGS_SCRIPTS_DIR}/\` from \`$HOME/.claude\`: the
top-level script that \`statusLine\` or \`apiKeyHelper\` runs, by the exporters'
rule, so a \`${SETTINGS_SCRIPTS_DIR}\` folder you staged is never archived; and
it rewrites \`settings\` (with those two values normalized), \`settingsScripts\`
and the settings-script omissions in \`manifest.json\` to match.
It then builds the gzip-compressed POSIX tar from the top-level names in this
fixed list that exist — ${promptArchiveMembers} — so no other top-level file in
the staging directory is archived; every other listed folder carries the files
and folders you staged under it, less every credential-bearing file or folder under the Step 2
folders: the block leaves those out of its own copy (it deletes nothing you
staged), records each as an omission, and drops any section or
\`hookSupport\` entry that named one. It assembles those names in one temp
directory and tars that one directory, then reads the archive back and writes
\`config-port.${ARCHIVE_FORMAT}\` only when every step of that check succeeds: every
name it lists is canonical (no leading \`/\` or \`./\`, no \`//\`, no \`.\` or \`..\`
segment) and appears once, its \`manifest.json\` is byte for byte the one the block
wrote, its \`CLAUDE.md\` and \`claude-includes/\` are exactly the ones it built
from the config root, its \`${SETTINGS_SCRIPTS_DIR}/\` is exactly the one it
built, and every other listed name holds exactly what you staged (less the
credential-bearing paths). Those are the members the importer reads to choose
what it installs, so a \`tar\` that misplaces, adds, drops, duplicates or
rewrites any of them, as that \`tar\` reads the archive back, leaves no archive.
It clears \`TAR_OPTIONS\` and every other
\`TAR_*\` variable, and \`GZIP\`, before it runs \`tar\`.
Only after the archive is in place does it print its summary
line, \`${INCLUDE_CHECK_SUMMARY_PREFIX} <n> ${INCLUDE_CHECK_PACKAGED} …\` (each refusal,
and the line naming a step that failed, starts with \`${INCLUDE_CHECK_SUMMARY_PREFIX}\` too), followed by a
second line, \`${SETTINGS_SCRIPT_CHECK_SUMMARY_PREFIX} <n> ${SETTINGS_SCRIPT_CHECK_CARRIED} …\`:

\`\`\`sh
${includeCheck}
\`\`\`

If the block exits non-zero, or ends without printing its summary line
(\`${INCLUDE_CHECK_SUMMARY_PREFIX} <n> ${INCLUDE_CHECK_PACKAGED} …\`), never build the
archive another way. When its message tells you what to change and to run this
block again (for a listed folder that is a link, named with no \`/\`: remove the
link and copy that folder alone with \`cp -RH\`; for a link named with a \`/\`,
inside a folder: remove it and list it in \`omissions\`, never copying it; write
\`manifest.json\`; \`cd\` into the staging directory; delete an earlier archive;
set \`TMPDIR\` to an absolute path), make that change and run the block again;
otherwise stop and report the error. A failed run leaves no archive
of its own; only a refusal that changed nothing can leave an earlier one in
place. Keep the summary line and the
\`${SETTINGS_SCRIPT_CHECK_SUMMARY_PREFIX}\` line after it, unchanged, for your
final report. This
produces the **staging** archive
\`config-port.${ARCHIVE_FORMAT}\` inside the \`mktemp -d\` directory — that is the
staging name, not the final one.

Now MOVE that staging archive into a stable, predefined **export directory** under
a timestamped, machine-named filename. The export directory defaults to
\`~/config-export/\` and is overridable with the \`${EXPORT_DIR_ENV}\` environment
variable; the final filename carries a full UTC date+time prefix and this
machine's name — \`<UTC>-config-export-<hostname>.${ARCHIVE_FORMAT}\`. Run exactly:

\`\`\`sh
${exportFragment}
\`\`\`

- The export directory is created with \`mkdir -p\` if it does not exist.
- On a filename collision the loop appends a numeric suffix (\`-2\`, \`-3\`, …)
  before the \`.${ARCHIVE_FORMAT}\` extension until the path is free — it **never
  overwrites** an existing export.
- If \`$(hostname)\` is empty, the filename simply omits the host segment and the
  export still succeeds.
- Do **NOT** create a backup or second copy of the archive — the single \`mv\`
  above is the only write.

The final \`echo\` prints the archive's absolute path (\`$DEST/$FINAL\`). Tell me
that path — that is the file the user uploads to the destination instance — and
the two summary lines from the block above: the
\`${INCLUDE_CHECK_SUMMARY_PREFIX} <n> ${INCLUDE_CHECK_PACKAGED} …\` line and the
\`${SETTINGS_SCRIPT_CHECK_SUMMARY_PREFIX}\` line after it.
`;
}
