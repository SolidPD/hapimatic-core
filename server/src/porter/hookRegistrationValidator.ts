// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, type Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { denormalizeHookCommand } from "@hapi/protocol/porter";

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

export interface HookRegistrationValidationResult {
  /** Hook script files on disk with no matching registration (dead code). */
  orphanFiles: string[];
  /** Registration commands whose referenced script path does not exist. */
  orphanRegistrations: string[];
  /**
   * #2639 (F9): the THIRD drift direction — a hook whose `from lib.X` import does
   * NOT resolve against the landed `hooks/lib/`. Absent presence+registration are
   * both clean, but the hook crashes (unguarded import) or silently degrades
   * (try/except availability flag) at runtime. `hook` is the on-disk script path
   * (like {@link orphanFiles}); `module` is the missing `lib` module NAME (a code
   * path, never a secret). One entry per (hook, unresolved module) pair.
   */
  unresolvedImports: { hook: string; module: string }[];
  /**
   * #3590 (K5, rule 4): dynamic-loader registry names (from the DESTINATION
   * `hooks/lib/detector_registry.py` + `hooks/lib/hook_registry.py`) that resolve
   * to NO `hooks/<name>.<ext>` file at the destination — a registry references a
   * hook that never landed. The post-commit half of the fail-loud belt (R2): a
   * missing registry-referenced module here is the drift a `settings.json`-only
   * orphan check could never see (a dispatcher-form host registers no such name in
   * settings.json). Empty when every registry name resolves, or when the
   * destination carries no registry (never a false positive on a clean tree).
   */
  registryMissing: string[];
}

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
 * Tolerant `settings.json` read — a missing or unparseable file yields `{}`
 * (no registrations), never a throw. Mirrors `claudeSettings.readClaudeSettings`.
 */
async function readSettingsHooks(
  claudeDir: string
): Promise<Record<string, unknown>> {
  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf-8"));
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
 * Extract path-like tokens from a command and resolve each to a destination path
 * (F3-expanded). A "path-like" token contains a `/` and either is absolute,
 * begins with a home/`~`/`$HOME` marker, or references `.claude/`. Interpreter
 * names (`python3`, `bash`) and flags are ignored.
 *
 * Exported for #4331: the plan-time dangling-registration warning
 * (`buildHookEntries` in ./planHooks) uses this same token rule, so the plan
 * and the post-commit orphan check below agree on what a command runs.
 */
export function referencedPaths(command: string, claudeDir: string): string[] {
  // Apply the canonical `$HOME/.claude` / `~/.claude` denormaliser first, then
  // token-level rewriting handles foreign-home and bare-home forms.
  const destHome = dirname(claudeDir);
  const normalised = denormalizeHookCommand(command, destHome);
  const tokens = normalised
    .split(/\s+/)
    .map(t => t.replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);

  const paths: string[] = [];
  for (const token of tokens) {
    const looksLikePath =
      token.includes("/") &&
      (token.startsWith("/") ||
        token.startsWith("~/") ||
        token.startsWith("$HOME/") ||
        token.includes(".claude/"));
    if (!looksLikePath) continue;
    paths.push(toDestPath(token, claudeDir));
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
 */
export function canonicalHookCommand(
  command: string,
  destHome: string
): string {
  return denormalizeHookCommand(command, destHome).trim().replace(/\s+/g, " ");
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
      return await readFile(join(libDir, name), "utf-8");
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
