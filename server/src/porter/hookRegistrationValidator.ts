// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, type Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  denormalizeHookCommand,
  type HookRegistrationValidationResult,
} from "@hapi/protocol/porter";
import { readDestination } from "./regularFile";

/**
 * The bidirectional hook registration validator (issue #2343, epic #2339 Sub D,
 * R5 / AC-5, Task 5 / D2).
 *
 * 🔴 This does NOT exist in this repository. AC-5 says a "bidirectional
 * registration validator is run after import and reports no drift", which reads
 * as invoking an existing tool — but that validator is an rp1-home artifact
 * (rp1-home#624). Research confirmed no equivalent in `server/`, `cli/`,
 * `scripts/`, or `.claude/` at the pinned commit, so this issue BUILDS it.
 *
 * A hook is live only if it is BOTH present on disk AND registered in
 * `settings.json`. Either half alone is a drift:
 *  - `orphanFiles`         — a hook SCRIPT on disk that no registration references
 *                            (dead code: installed-looking but never fires);
 *  - `orphanRegistrations` — a registration whose referenced command path does
 *                            not exist on disk (a dangling command).
 *
 * #2639 (F9) adds a THIRD, orthogonal drift class — a hook that IS present AND
 * registered but whose `from lib.X` import does not resolve against the landed
 * `hooks/lib/` (`unresolvedImports`). Presence+registration validate clean while
 * behavior is gone: the hook crashes on an unguarded import or silently degrades
 * behind a try/except availability flag. This closes the presence / registration
 * / behavior triangle.
 *
 * F3 (directive Task 12): the command-path existence check FIRST expands
 * `$HOME`/`~` and rewrites a foreign-home config-root prefix to the destination
 * config root. Without it, EVERY imported hook — whose command is
 * `$HOME/.claude/hooks/...` or a `/home/sourceuser/.claude/...` literal — would
 * land as a false `orphanRegistration` (loud) or, if the raw path happened to
 * exist, would never fire (silent). `denormalizeHookCommand` (#2340) is the
 * canonical `$HOME`/`~` expander; foreign-home rewriting is layered on top.
 */

// #5601: the wire shape lives in @hapi/protocol/porter (importWire.ts).
export type { HookRegistrationValidationResult } from "@hapi/protocol/porter";

/**
 * #3590 (K4/K5): the two dynamic-loader registries a dispatcher-form host uses to
 * load hooks that `settings.json` never names. `detector_registry.py` (the
 * secondary loader, `unified-prompt-dispatcher.py`) holds one `{"name": "<hook>"}`
 * object per line; `hook_registry.py` (the primary loader, `EVENT_REGISTRY`) holds
 * `Entry("<Event>", "<hook>")` rows. Both are parsed line-anchored + comment-
 * tolerant (a `#` line never matches), mirroring the F9 `LIB_IMPORT_RE` precedent.
 * The captured name maps to a `hooks/<name>.<ext>` file. Shared by BOTH the
 * plan-time belt (`planHooks.ts`, Task 3, over the ARCHIVE) and the post-commit
 * validator (Task 4, over the DESTINATION), so the two halves parse identically.
 */
const DETECTOR_REGISTRY_NAME_RE = /^\s*\{\s*"name"\s*:\s*"([^"]+)"/gm;
const HOOK_REGISTRY_ENTRY_RE =
  /Entry\(\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]/g;

/** Names from a `detector_registry.py` source (one `{"name": …}` per line). */
export function parseDetectorRegistryNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(DETECTOR_REGISTRY_NAME_RE)) {
    if (m[1]) names.add(m[1]);
  }
  return [...names];
}

/** Names from a `hook_registry.py` source (`Entry("<Event>", "<name>")` rows). */
export function parseHookRegistryNames(source: string): string[] {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    if (/^\s*#/.test(line)) continue; // skip comment lines
    for (const m of line.matchAll(HOOK_REGISTRY_ENTRY_RE)) {
      if (m[1]) names.add(m[1]);
    }
  }
  return [...names];
}

/**
 * Union of the hook names both registries declare, from their file SOURCES (a
 * `null` source — the registry is absent — contributes nothing, never a throw).
 */
export function parseRegistryNames(
  detectorSource: string | null,
  hookSource: string | null
): string[] {
  const names = new Set<string>();
  if (detectorSource)
    for (const n of parseDetectorRegistryNames(detectorSource)) names.add(n);
  if (hookSource)
    for (const n of parseHookRegistryNames(hookSource)) names.add(n);
  return [...names];
}

/** The hook NAME a registry entry maps to: a file's basename minus its extension. */
export function hookNameOf(filePath: string): string {
  const b = basename(filePath);
  const dot = b.lastIndexOf(".");
  return dot === -1 ? b : b.slice(0, dot);
}

/** Resolve the config root exactly as `cli/src/claude/utils/claudeSettings.ts` does. */
export function resolveClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Hook-script file extensions considered "a hook" for orphan-file detection. */
const HOOK_SCRIPT_EXTENSIONS = new Set([".py", ".sh", ".js", ".ts", ".mjs"]);
/** Subdirectories under `hooks/` that hold shared utilities, not registered hooks. */
const NON_HOOK_DIRS = new Set([
  "lib",
  "_shared",
  "state",
  "tests",
  "__pycache__",
  "node_modules",
]);

/**
 * Tolerant `settings.json` read — a missing, unparseable or special (FIFO,
 * socket, device) file yields `{}` (no registrations), never a throw. The
 * missing/unparseable tolerance mirrors the CLI's
 * `claudeSettings.readClaudeSettings`; that reader has no special-file case.
 */
async function readSettingsHooks(
  claudeDir: string
): Promise<Record<string, unknown>> {
  const settingsPath = join(claudeDir, "settings.json");
  try {
    // #5759: a FIFO, socket or device reads as absent and is never read. This
    // runs post-commit under the import lock and from the installed-config
    // route, and a FIFO's open blocks until a writer appears.
    const r = await readDestination(settingsPath);
    if (r.kind !== "file") return {};
    const parsed = JSON.parse(r.content.toString("utf-8"));
    const hooks = parsed?.hooks;
    return hooks && typeof hooks === "object" ? hooks : {};
  } catch {
    return {};
  }
}

/**
 * Extract every registration command string from the `settings.json` hooks
 * block, shaped `{ <Event>: [{ matcher?, hooks: [{ type: "command", command }] }] }`
 * (the exact shape `toSettingsHooksBlock` / `generateHookSettings.ts` write).
 */
function extractRegistrationCommands(
  hooksBlock: Record<string, unknown>
): string[] {
  const commands: string[] = [];
  for (const matcherList of Object.values(hooksBlock)) {
    if (!Array.isArray(matcherList)) continue;
    for (const matcherEntry of matcherList) {
      const inner = (matcherEntry as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const cmd = (h as { command?: unknown })?.command;
        if (typeof cmd === "string" && cmd.length > 0) commands.push(cmd);
      }
    }
  }
  return commands;
}

/**
 * Rewrite a single command TOKEN's config-root prefix to `claudeDir`, and expand
 * a bare `$HOME`/`~` to the real home (F3). Order matters: config-root rewrites
 * first (so `$HOME/.claude` → `<claudeDir>` even when `claudeDir` is a custom
 * `CLAUDE_CONFIG_DIR`), then generic `$HOME`/`~` for non-`.claude` paths.
 */
function toDestPath(token: string, claudeDir: string): string {
  let t = token;
  // Config-root rewrites → claudeDir. Covers the export-normalised `$HOME/.claude`
  // and `~/.claude` forms plus a raw foreign-home `/home/<user>/.claude` literal.
  t = t.replace(/^\$HOME\/\.claude/, claudeDir);
  t = t.replace(/^~\/\.claude/, claudeDir);
  t = t.replace(/^\/home\/[^/]+\/\.claude/, claudeDir);
  // Generic $HOME / ~ expansion for any remaining non-.claude path.
  const home = homedir();
  t = t.replace(/^\$HOME(?=\/|$)/, home);
  t = t.replace(/^~(?=\/|$)/, home);
  return t;
}

/**
 * #5199 (OOS-1): spellings the shell expands to the home directory, rewritten
 * to the bare `$HOME` the rest of the token rule reads. `${HOME}`, `"$HOME"`
 * and `"${HOME}"` all name the home directory at run time; a single-quoted
 * `'$HOME'` is literal in the shell and is deliberately left alone (R4).
 * Used for path resolution only, never written back to settings.json.
 *
 * #5612: applied through {@link readHomeSpellings} (which writes `${HOME}`
 * before a name character), on a {@link readShellLiterals} copy, so a spelling
 * inside single quotes (`'${HOME}/…'`) or after a backslash is not rewritten
 * either, unless the command runs a nested shell.
 */
const SHELL_HOME_SPELLING_RE = /"\$\{HOME\}"|"\$HOME"|\$\{HOME\}/g;

/**
 * #5612: rewrite each home spelling to `$HOME`, or to `${HOME}` when a name
 * character follows, so the rewrite never joins the next word into another
 * variable (`${HOME}_bin` must not become `$HOME_bin`).
 */
function readHomeSpellings(text: string): string {
  return text.replace(
    SHELL_HOME_SPELLING_RE,
    (match: string, offset: number, whole: string) =>
      /[A-Za-z0-9_]/.test(whole.charAt(offset + match.length))
        ? "${HOME}"
        : "$HOME"
  );
}

// #5612: stand-ins for a `$` / `~` the shell reads literally, so neither the
// home-spelling rewrite nor the shared denormaliser can match them. NUL-led: a
// command holding a NUL cannot be run by a shell, so protect + restore is the
// identity on every runnable command.
const LITERAL_DOLLAR = "\u0000d";
const LITERAL_TILDE = "\u0000t";

// #5612: the words of a nested-shell command (see runsNestedShell).
const SHELL_NAME_RE = /^(?:ba|z|da|k|a)?sh$/;
/** An option cluster holding `c`: the shell runs its next argument. */
const COMMAND_OPTION_RE = /^-[A-Zabd-z]*c[A-Za-z]*$/;
/** An option whose argument is the next word (`-o X`, `+O X`, `--rcfile F`). */
const ARG_OPTION_RE = /^(?:[-+][A-NP-Za-np-z]*[oO]|--(?:rcfile|init-file))$/;
const PLAIN_OPTION_RE = /^--?[A-Za-z][\w-]*$/;

/**
 * #5612: true when the command hands text to a nested shell (`bash -c '…'`,
 * `sh -ec "…"`, `bash -euo pipefail -c '…'`, `eval …`). The inner shell reads
 * the quoted text again and expands what the outer quotes kept literal, so
 * such a command is read without literal protection. The test covers the
 * whole command: a nested shell anywhere turns protection off for every token.
 * Options may carry an argument (`-o X`, `+o X`, `-O X`, `--rcfile F`,
 * `--init-file F`).
 *
 * One pass over the words, holding only the current one: a walk over a
 * shell's options resumes the outer pass at the word where it stopped, so a
 * crafted command of any length takes linear time. (A regex form backtracked
 * quadratically, and on a long enough command returned no match.)
 */
function runsNestedShell(command: string): boolean {
  const wordRe = /[^\s;&|()]+/g;
  const nextWord = (from: number): RegExpExecArray | null => {
    wordRe.lastIndex = from;
    return wordRe.exec(command);
  };
  const spacedTo = (end: number, word: RegExpExecArray): boolean =>
    /^\s+$/.test(command.slice(end, word.index));
  const spaceAfter = (end: number): boolean => /\s/.test(command.charAt(end));
  const endOf = (word: RegExpExecArray): number => word.index + word[0].length;

  let word = nextWord(0);
  while (word) {
    const text = word[0];
    if (text === "eval" && spaceAfter(endOf(word))) return true;
    if (!SHELL_NAME_RE.test(text.slice(text.lastIndexOf("/") + 1))) {
      word = nextWord(endOf(word));
      continue;
    }
    let end = endOf(word);
    let option = nextWord(end);
    while (option && spacedTo(end, option)) {
      const flag = option[0];
      const flagEnd = endOf(option);
      const last = flagEnd === command.length;
      if (COMMAND_OPTION_RE.test(flag) && (last || spaceAfter(flagEnd))) {
        return true;
      }
      if (!spaceAfter(flagEnd)) break;
      const arg = ARG_OPTION_RE.test(flag) ? nextWord(flagEnd) : null;
      if (
        arg &&
        spacedTo(flagEnd, arg) &&
        !arg[0].startsWith("-") &&
        spaceAfter(endOf(arg))
      ) {
        // An `eval` here starts a nested shell of its own.
        if (arg[0] === "eval") return true;
        end = endOf(arg);
      } else if (PLAIN_OPTION_RE.test(flag)) {
        end = flagEnd;
      } else {
        break;
      }
      option = nextWord(end);
    }
    // Resume at the word that ended the walk: the words before it were this
    // shell's options and their arguments, and a walk from an argument would
    // see the same options again.
    word = option;
  }
  return false;
}

/**
 * #5612 (S3): replace each `$` and `~` the shell reads literally with a
 * placeholder: a `$` inside single quotes, a `~` inside single or double
 * quotes, and either one after a backslash outside single quotes. A `#`
 * comment runs to the end of its line and holds no quotes. An unterminated
 * quote keeps its state to the end of the string.
 */
function protectShellLiterals(command: string): string {
  const literal = (c: string): string =>
    c === "$" ? LITERAL_DOLLAR : c === "~" ? LITERAL_TILDE : c;
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (quote === "'") {
      if (c === "'") quote = null;
      out += literal(c);
    } else if (c === "\\" && i + 1 < command.length) {
      out += c + literal(command.charAt(i + 1));
      i++;
    } else if (
      c === "#" &&
      quote === null &&
      (i === 0 || /[\s;&|()]/.test(command.charAt(i - 1)))
    ) {
      const eol = command.indexOf("\n", i);
      const end = eol === -1 ? command.length : eol;
      out += command.slice(i, end);
      i = end - 1;
    } else if (c === "'" && quote === null) {
      quote = "'";
      out += c;
    } else if (c === '"') {
      quote = quote === '"' ? null : '"';
      out += c;
    } else {
      out += quote === '"' && c === "~" ? LITERAL_TILDE : c;
    }
  }
  return out;
}

/** {@link protectShellLiterals}, unless the command runs a nested shell. */
function readShellLiterals(command: string): string {
  return runsNestedShell(command) ? command : protectShellLiterals(command);
}

/** Undo {@link protectShellLiterals}. */
function restoreShellLiterals(text: string): string {
  return text.replaceAll(LITERAL_DOLLAR, "$").replaceAll(LITERAL_TILDE, "~");
}

/**
 * #5612 (S2): an expansion the destination cannot resolve: any variable but
 * HOME, a braced form other than a plain `${HOME}` (another variable, or HOME
 * with a modifier), a special or positional parameter (`$#`, `$?`, `$1`…), or
 * a `$(` inside the token. The path it names is unknowable here (Claude Code
 * sets `CLAUDE_PROJECT_DIR` per project when it runs the hook), so the token
 * is not checked at all. A plain `${HOME}` is not skipped: before a name
 * character (`${HOME}_bin/…`) it is checked as written.
 */
const UNRESOLVED_EXPANSION_RE =
  /\$(?:\{(?!HOME\})|[(0-9#?*@!$-]|(?!HOME(?![A-Za-z0-9_]))[A-Za-z_])/;

/**
 * Extract path-like tokens from a command and resolve each to a destination path
 * (F3-expanded). A "path-like" token contains a `/` and either is absolute,
 * begins with a home/`~`/`$HOME` marker, or references `.claude/`. Interpreter
 * names (`python3`, `bash`) and flags are ignored.
 *
 * Exported for #4331: the plan-time dangling-registration warning
 * (`buildHookEntries` in ./planHooks) uses this same token rule, so the plan
 * and the post-commit orphan check below agree on what a command runs.
 *
 * #5199: the shell-expanded home spellings `${HOME}`, `"$HOME"` and `"${HOME}"`
 * are read as `$HOME` (see SHELL_HOME_SPELLING_RE); a single-quoted `'$HOME'`
 * is not.
 *
 * #5612: single quotes, a quoted `~` and backslash escapes are honored (S3),
 * so `'${HOME}/…'`, `'$HOME/…'` and `"~/…"` resolve to their literal text,
 * unless the command hands its text to a nested shell. A token holding any
 * other unresolved expansion (UNRESOLVED_EXPANSION_RE, e.g.
 * `$CLAUDE_PROJECT_DIR/…`) is skipped (S2). Tokens are still split on
 * whitespace, so a `$(…)` holding a space is split too, and the part after
 * the space (`~/.x)/…` in `$(cat ~/.x)/…`) is checked on its own.
 */
export function referencedPaths(command: string, claudeDir: string): string[] {
  // Apply the canonical `$HOME/.claude` / `~/.claude` denormaliser first, then
  // token-level rewriting handles foreign-home and bare-home forms. Outside a
  // nested shell, literal `$` / `~` stay protected through the rewrite, the
  // denormaliser, the skip test and `toDestPath`; `looksLikePath` reads the
  // restored text.
  const destHome = dirname(claudeDir);
  const normalised = denormalizeHookCommand(
    readHomeSpellings(readShellLiterals(command)),
    destHome
  );
  const tokens = normalised
    .split(/\s+/)
    .map(t => t.replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);

  const paths: string[] = [];
  for (const token of tokens) {
    const literal = restoreShellLiterals(token);
    // A `${HOME}/` prefix here is single-quoted text: every expandable
    // spelling was already rewritten to `$HOME` above.
    const looksLikePath =
      literal.includes("/") &&
      (literal.startsWith("/") ||
        literal.startsWith("~/") ||
        literal.startsWith("$HOME/") ||
        literal.startsWith("${HOME}/") ||
        literal.includes(".claude/"));
    if (!looksLikePath) continue;
    if (UNRESOLVED_EXPANSION_RE.test(token)) continue;
    paths.push(restoreShellLiterals(toDestPath(token, claudeDir)));
  }
  return paths;
}

/**
 * Canonicalize a hook registration command for EQUALITY COMPARISON ONLY (#2641,
 * F12): expand `$HOME` / `~/.claude` to `destHome` via the shared
 * {@link denormalizeHookCommand} — never a second path-expansion implementation
 * (KD-1), so the dedupe key can never drift from the import path's own expansion
 * (`importArchive.ts` `denormalizeHookCommand(..., destHome)` at import) — and
 * normalize surrounding/inner whitespace. Two registrations whose commands are
 * textually different but path-equivalent (`$HOME/.claude/hooks/x.py` vs the
 * expanded `/home/<user>/.claude/hooks/x.py`) return the SAME string. Because
 * `denormalizeHookCommand` is idempotent on an already-expanded command, an
 * incoming (import-normalized) command and a stored `$HOME`-form command both map
 * to one canonical string. Used to build the dedupe key at the settings merge
 * site; NEVER written back — surviving entries keep their stored form (KD-3).
 *
 * #5612 (S1): `${HOME}`, `"$HOME"` and `"${HOME}"` outside single quotes and
 * not after a backslash (anywhere, in a command that runs a nested shell) are
 * read as `$HOME` first (as `${HOME}` before a name character), so a hook
 * stored as `$HOME/…` and imported as `${HOME}/…` gets one key. Only that
 * spelling rewrite honors quoting; the expansion itself stays the shared,
 * quote-unaware denormaliser (KD-1).
 */
export function canonicalHookCommand(
  command: string,
  destHome: string
): string {
  const spelled = restoreShellLiterals(
    readHomeSpellings(readShellLiterals(command))
  );
  return denormalizeHookCommand(spelled, destHome).trim().replace(/\s+/g, " ");
}

/** One registered hook, flattened to (event, command) for the read surface. */
export interface RegisteredHook {
  event: string;
  command: string;
  matcher?: string;
}

/**
 * List every hook registration in `settings.json`, flattened to (event, command,
 * matcher?) tuples — the "registration half" of the installed-hooks read surface
 * (Task 11). Tolerant: a missing/corrupt settings file yields `[]`.
 */
export async function listSettingsHookRegistrations(
  claudeDir: string = resolveClaudeConfigDir()
): Promise<RegisteredHook[]> {
  const hooksBlock = await readSettingsHooks(claudeDir);
  const out: RegisteredHook[] = [];
  for (const [event, matcherList] of Object.entries(hooksBlock)) {
    if (!Array.isArray(matcherList)) continue;
    for (const matcherEntry of matcherList) {
      const matcher = (matcherEntry as { matcher?: unknown })?.matcher;
      const inner = (matcherEntry as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const cmd = (h as { command?: unknown })?.command;
        if (typeof cmd !== "string" || cmd.length === 0) continue;
        out.push({
          event,
          command: cmd,
          ...(typeof matcher === "string" && matcher.length > 0
            ? { matcher }
            : {}),
        });
      }
    }
  }
  return out;
}

/** Recursively collect hook-script files directly relevant to registration. */
export async function collectHookFiles(hooksDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (NON_HOOK_DIRS.has(e.name)) continue;
        await walk(join(dir, e.name));
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf(".");
        const ext = dot === -1 ? "" : e.name.slice(dot);
        if (HOOK_SCRIPT_EXTENSIONS.has(ext)) out.push(join(dir, e.name));
      }
    }
  }
  await walk(hooksDir);
  return out;
}

/**
 * #2639 (F9): extract every `lib` module a Python hook imports. Line-anchored, so
 * a `#`-comment or a `from lib.…` inside a string does NOT match; and it scans the
 * WHOLE file (not just a top-of-file import block), which is deliberate — the F9
 * silent-degradation cases ARE try-guarded and function-body imports (e.g.
 * `unified-prompt-dispatcher.py`'s `from lib.detector_registry import …` inside a
 * `try:`, `closing-summary-enforcer.py`'s function-body `from lib.telemetry_logger
 * import …`). Matches `from lib.X[.Y] import …` and `import lib.X[.Y]`; the captured
 * dotted module maps to `lib/X[/Y]`.
 *
 * Out of scope (KD-2, documented): the bare `from lib import X` form (no RP1 hook
 * uses it — verified), dynamically-constructed module names, and a `from lib.…`
 * inside a triple-quoted string literal.
 */
const LIB_IMPORT_RE =
  /^\s*(?:from\s+lib\.([A-Za-z_][\w.]*)\s+import\b|import\s+lib\.([A-Za-z_][\w.]*))/gm;

export function extractLibImports(source: string): string[] {
  const modules = new Set<string>();
  for (const m of source.matchAll(LIB_IMPORT_RE)) {
    const mod = m[1] ?? m[2];
    if (mod) modules.add(mod);
  }
  return [...modules];
}

/**
 * Whether a dotted `lib` module (`detector_registry`, `sub.mod`) resolves to a
 * real file under `libDir` (`<claudeDir>/hooks/lib/`) — either `<mod>.py` or the
 * package form `<mod>/__init__.py`.
 */
function libModuleResolves(libDir: string, moduleDotted: string): boolean {
  const rel = moduleDotted.split(".").join("/");
  return (
    existsSync(join(libDir, `${rel}.py`)) ||
    existsSync(join(libDir, rel, "__init__.py"))
  );
}

/**
 * Validate hook registration in both directions for the config root `claudeDir`
 * (defaults to `CLAUDE_CONFIG_DIR || ~/.claude`).
 *
 * `commitImport` runs this AFTER the swap and includes the result in
 * `ImportResult`. A non-empty result is reported to the user; it does NOT roll
 * back — the swap already succeeded and the state is consistent, just incomplete.
 */
export async function validateHookRegistration(
  claudeDir: string = resolveClaudeConfigDir()
): Promise<HookRegistrationValidationResult> {
  const hooksBlock = await readSettingsHooks(claudeDir);
  const commands = extractRegistrationCommands(hooksBlock);

  // Referenced paths across all registrations (F3-expanded).
  const referenced = new Set<string>();
  const orphanRegistrations: string[] = [];
  for (const cmd of commands) {
    const paths = referencedPaths(cmd, claudeDir);
    for (const p of paths) referenced.add(p);
    // A registration is orphaned when it references path-like tokens but NONE of
    // them exists on disk (a dangling command). A command with no path-like token
    // (e.g. a bare builtin) is not classifiable and is not flagged.
    if (paths.length > 0 && !paths.some(p => existsSync(p))) {
      orphanRegistrations.push(cmd);
    }
  }

  // Hook script files on disk.
  const hooksDir = join(claudeDir, "hooks");
  const files = await collectHookFiles(hooksDir);
  const libDir = join(hooksDir, "lib");

  // #3590 (K5, rule 4): parse the DESTINATION dynamic-loader registries. A hook
  // named here is registered-by-registry — NOT an orphan — even though
  // settings.json never references it (the dispatcher-form host case). Tolerant:
  // an absent/unreadable registry contributes no names, never a throw.
  const readRegistry = async (name: string): Promise<string | null> => {
    try {
      // #5759: a FIFO, socket or device is an absent registry, never read.
      const r = await readDestination(join(libDir, name));
      return r.kind === "file" ? r.content.toString("utf-8") : null;
    } catch {
      return null;
    }
  };
  const registryNames = new Set(
    parseRegistryNames(
      await readRegistry("detector_registry.py"),
      await readRegistry("hook_registry.py")
    )
  );

  // A file is an orphan only if NO settings.json registration references it AND no
  // registry declares its name (rule 4). The files in neither surface stay flagged.
  const orphanFiles = files.filter(
    f => !referenced.has(f) && !registryNames.has(hookNameOf(f))
  );

  // Registry names resolving to NO hooks/<name>.<ext> file at the destination —
  // the post-commit half of the fail-loud belt (R2).
  const fileNames = new Set(files.map(hookNameOf));
  const registryMissing = [...registryNames]
    .filter(n => !fileNames.has(n))
    .sort();

  // #2639 (F9): THIRD check — a hook's `from lib.X` imports must resolve against
  // the landed `hooks/lib/`. `collectHookFiles` skips `NON_HOOK_DIRS` (incl.
  // `lib`), so `files` is the TOP-LEVEL hook set; scan each Python hook and flag
  // every `lib` module it imports that is absent. lib-scoped per R2 (the F9
  // evidence is `from lib.…`); `_shared` is CARRIED via manifest `hookSupport`
  // but is not import-checked here. Tolerant: an unreadable hook is skipped, never
  // thrown — mirrors `readSettingsHooks`.
  const unresolvedImports: { hook: string; module: string }[] = [];
  for (const file of files) {
    if (!file.endsWith(".py")) continue;
    let source: string;
    try {
      source = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    for (const mod of extractLibImports(source)) {
      if (!libModuleResolves(libDir, mod)) {
        unresolvedImports.push({ hook: file, module: mod });
      }
    }
  }

  return {
    orphanFiles,
    orphanRegistrations,
    unresolvedImports,
    registryMissing,
  };
}
