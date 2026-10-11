// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { WebAppEnv } from "../middleware/auth";
import {
  resolveClaudeConfigDir,
  validateHookRegistration,
  listSettingsHookRegistrations,
  collectHookFiles,
  type RegisteredHook,
} from "../../porter/hookRegistrationValidator";
import {
  assertContained,
  PathEscapeError,
} from "../../porter/archiveContainment";
import {
  resolveHostConfigPath,
  type ImportResult,
} from "../../porter/importArchive";
import type { PorterLastImportBox } from "./porterImport";
import { isSafeMachinePath } from "../../utils/pathSecurity";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

/**
 * Configuration Porter installed-state read surface (issue #2343, epic #2339
 * Sub D, Task 11). Consumer: #2344 R1's four tabs.
 *
 * `GET /porter/installed` — returns the currently-installed skills, agents, and
 * hooks read from `CLAUDE_CONFIG_DIR || ~/.claude` (resolution per Task 5). For
 * hooks it reports BOTH halves (files on disk + settings.json registrations)
 * plus the orphan states from Task 5's bidirectional validator.
 *
 * 🔴 The MCP-servers tab uses the EXISTING `GET /api/mcp-status`
 * (`server/src/web/server.ts:1094`; on-demand refresh at `:1141`) — it is
 * deliberately NOT duplicated here. (#3546 fixed the stale `server.ts:702`
 * citation, a #2343-era listing-route note.)
 *
 * 🔴 The MOUNT POSITION is the auth mechanism (like `createPorterKeyRoutes`,
 * #2341): no inline auth; mount AFTER the global JWT gate.
 */

/** Top-level entry names of a `~/.claude/<dimension>` directory (files + dirs). */
async function listDimensionEntries(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith("."))
      .map(e => e.name)
      .sort();
  } catch {
    return []; // dimension dir absent — nothing installed
  }
}

interface InstalledPlugins {
  marketplaces: { name: string; source: string }[];
  plugins: { name: string; marketplace?: string; version?: string }[];
}

/**
 * Best-effort read of the LIVE installed-plugin descriptor from
 * `~/.claude/plugins/{known_marketplaces,installed_plugins}.json` (F12). This is
 * the actual installed-plugin state — the porter does NOT execute plugin installs
 * (that is #2465), so the plan's remediation commands, not this surface, describe
 * what an import WOULD add. Any parse failure yields empty lists.
 */
async function readInstalledPlugins(
  claudeDir: string
): Promise<InstalledPlugins> {
  const pluginsDir = join(claudeDir, "plugins");
  const out: InstalledPlugins = { marketplaces: [], plugins: [] };

  try {
    const raw = JSON.parse(
      await readFile(join(pluginsDir, "known_marketplaces.json"), "utf-8")
    );
    const source = Array.isArray(raw) ? raw : (raw?.marketplaces ?? raw);
    if (source && typeof source === "object") {
      for (const [key, value] of Object.entries(source)) {
        const name =
          typeof (value as { name?: unknown })?.name === "string"
            ? (value as { name: string }).name
            : key;
        const src = (value as { source?: unknown })?.source;
        out.marketplaces.push({
          name,
          source: typeof src === "string" ? src : "",
        });
      }
    }
  } catch {
    // no marketplaces file — leave empty
  }

  try {
    const raw = JSON.parse(
      await readFile(join(pluginsDir, "installed_plugins.json"), "utf-8")
    );
    const source = Array.isArray(raw) ? raw : (raw?.plugins ?? raw);
    if (Array.isArray(source)) {
      for (const p of source) {
        const name = (p as { name?: unknown })?.name;
        if (typeof name === "string") {
          out.plugins.push({
            name,
            marketplace:
              typeof (p as { marketplace?: unknown }).marketplace === "string"
                ? (p as { marketplace: string }).marketplace
                : undefined,
            version:
              typeof (p as { version?: unknown }).version === "string"
                ? (p as { version: string }).version
                : undefined,
          });
        }
      }
    } else if (source && typeof source === "object") {
      for (const [key, value] of Object.entries(source)) {
        out.plugins.push({
          name: key,
          marketplace:
            typeof (value as { marketplace?: unknown })?.marketplace ===
            "string"
              ? (value as { marketplace: string }).marketplace
              : undefined,
          version:
            typeof (value as { version?: unknown })?.version === "string"
              ? (value as { version: string }).version
              : undefined,
        });
      }
    }
  } catch {
    // no installed-plugins file — leave empty
  }

  return out;
}

export interface InstalledConfigResponse {
  claudeDir: string;
  skills: string[];
  agents: string[];
  hooks: {
    files: string[];
    registrations: RegisteredHook[];
    orphanFiles: string[];
    orphanRegistrations: string[];
  };
  plugins: InstalledPlugins;
  /**
   * #3590 (K6/D7): the last import's {@link ImportResult} (incl. `parity`) — the
   * "CLI equivalent" of the commit response, exposed here because the commit
   * response is otherwise ephemeral. In-memory only: `null` on a fresh server
   * (never imported) and after any restart.
   */
  lastImport?: ImportResult | null;
}

/**
 * Content-read surface (issue #3116). The Configuration page's preview pane
 * reads ONE installed file's text via `GET /porter/content?dimension&name`.
 *
 * 🔴 SECURITY — this is a file-read surface on the instance server. The endpoint
 * takes a `dimension` + a `name`, NEVER a raw client path: the server constructs
 * the candidate from a TRUSTED root (`resolveClaudeConfigDir()` + dimension) plus
 * the validated name, so the attack surface is a name, not a full path. The
 * allowlist is enforced in three composed layers:
 *   1. Lexical — {@link assertContained} rejects a `..` segment / absolute / NUL
 *      / empty name, resolves the candidate against the dimension root, asserts a
 *      `root + sep` prefix, and runs the {@link isSafeMachinePath} denylist.
 *   2. Symlink — `fs.realpath` on BOTH the dimension root and the candidate leaf,
 *      then a `realRoot + sep` prefix check on the REAL paths. This is what
 *      catches a symlink inside `skills/` that points OUTSIDE the root — the
 *      lexical layer alone cannot (its path is lexically contained). No realpath
 *      pattern exists elsewhere in `server/src`, so it is written fresh here.
 *
 *      🔓 Denylist-only follow (issue #3145, Option A): an escaping symlink whose
 *      REAL target passes the {@link isSafeMachinePath} denylist AND is not a host
 *      OAuth store is FOLLOWED and read — 9 of 77 skills are operator-created
 *      symlinks into `~/projects/*` (surfaced during #3116), and refusing them all
 *      made the preview pane useless. The follow is DENYLIST-BOUNDED, not
 *      allowlisted: a denylisted target (any `.config`/`.ssh`/`/etc`/… segment or
 *      prefix) OR one of the two host OAuth stores (`~/.claude.json`,
 *      `<claudeDir>/.credentials.json`) is refused with a bare 403 — no `target`,
 *      no existence confirmation. That OAuth-store refusal is the D1(a) targeted
 *      carve-out: those two whole-file token stores PASS `isSafeMachinePath`
 *      (its segment denylist has no `.claude` entry, `pathSecurity.ts`), yet this
 *      endpoint's own MCP branch never serves them whole, so the follow path must
 *      not either.
 *
 *      Design rationale (denylist-only, chosen over an allowlist of followable
 *      roots or per-target operator confirmation): (i) single-tenant trust
 *      boundary — the server runs as the operator reading the operator's own
 *      files, so the threat is accidental self-exposure, not a foreign principal;
 *      (ii) every symlink under `skills/` is provably operator-created (the import
 *      path rejects link members, `archiveContainment.ts`), so none can be
 *      injected; (iii) the read is confined to a single named leaf
 *      (`<name>/SKILL.md`, or the one named hook/agent file), never a tree walk;
 *      (iv) the denylist + D1(a) refusal cover the credential/secret locations the
 *      exposure caveat names. RESIDUAL RISK (accepted, must stay documented): an
 *      operator symlink to a NON-denylisted-but-sensitive file (e.g. a
 *      `secrets.md` inside a `~/projects/*` repo, or any non-denylisted `$HOME`
 *      dotfile) is previewable — a self-inflicted read under the operator's own
 *      boundary, mitigated by (ii)–(iv). An optional `followableRoots` allowlist
 *      is the recorded future hardening. This residual is why the issue's risk
 *      stays `high` even at `medium` complexity.
 *
 *      ⚠️ Scope honesty — the real-path denylist runs ONLY on this escape branch.
 *      A LEXICALLY-contained path is never denylist-checked post-realpath, and a
 *      hardlinked file never reaches this branch at all, so the denylist governs
 *      ESCAPED SYMLINK TARGETS ONLY, not every read.
 *   3. Content — a ~1 MB size cap and a NUL-byte binary guard, so the pane never
 *      streams a huge or binary blob as text.
 *
 * ⚠️ Known limitation (documented, do NOT remove the check): `isSafeMachinePath`
 * denylists any path segment named `.config` (`pathSecurity.ts`), so a
 * `CLAUDE_CONFIG_DIR` under `~/.config/...` would 403 every read, and an escaping
 * symlink whose real target sits under a `.config` segment is refused (not
 * followed). That is a deliberate denylist, not a bug — the fix is the config-dir
 * location, never removing the guard.
 */
const MAX_CONTENT_BYTES = 1024 * 1024;

/** File dimensions whose content is read straight off disk (MCP is special-cased). */
type FileDimension = "skills" | "hooks" | "agents";

/** JSON error slug per refusal status. */
const STATUS_ERROR: Record<400 | 403 | 404, string> = {
  400: "bad-request",
  403: "forbidden",
  404: "not-found",
};

/**
 * Realpath each candidate, dropping any that do not exist (ENOENT) or are
 * unreadable. Used to canonicalize the two host OAuth-store paths for the D1(a)
 * refusal comparison (issue #3145), so the check holds even where the temp root
 * itself is a symlink (macOS `/tmp` → `/private/tmp`) and a followed symlink's
 * realpath'd target must equal the store's realpath'd path.
 */
async function resolveExistingRealPaths(
  candidates: readonly string[]
): Promise<string[]> {
  const out: string[] = [];
  for (const candidate of candidates) {
    try {
      out.push(await realpath(candidate));
    } catch {
      // Absent/unreadable — cannot be a followed target, so it never matches.
    }
  }
  return out;
}

/**
 * Resolve `<root>/<relativeName>` to a REAL absolute path that is provably
 * readable, resolving symlinks on both ends. Returns a refusal status instead of
 * throwing so the caller maps it straight to an HTTP code.
 *
 * Result statuses:
 *  - `{ ok: true, realPath }` — a CONTAINED real path (the normal case), OR a
 *    symlink escape whose REAL target passes the `isSafeMachinePath` denylist and
 *    is not a host OAuth store: the denylist-bounded follow (issue #3145). The
 *    caller then applies the size/binary/dir guards and reads it.
 *  - 400 — a malformed/traversal name (`..`, absolute, NUL, empty), or the name
 *    resolves to the dimension root directory itself (a directory read).
 *  - 403 — a symlink escape whose REAL target is denylisted by `isSafeMachinePath`,
 *    OR is one of the two host OAuth stores (`~/.claude.json`,
 *    `<claudeDir>/.credentials.json`) passed in `oauthStoreCandidates` — the D1(a)
 *    targeted refusal. A bare 403 (no target, no existence confirmation), so a
 *    link to a sensitive location is never even confirmed.
 *  - 404 — the dimension root or the candidate leaf does not exist on disk.
 */
async function resolveContainedRealPath(
  root: string,
  relativeName: string,
  /**
   * Candidate host OAuth-store paths (`~/.claude.json`,
   * `<claudeDir>/.credentials.json`) that must be REFUSED even when they pass
   * `isSafeMachinePath` — the D1(a) carve-out (issue #3145). Realpath'd lazily,
   * ONLY on a symlink escape, so the common contained-read path pays no extra
   * syscall.
   */
  oauthStoreCandidates: readonly string[] = []
): Promise<
  { ok: true; realPath: string } | { ok: false; status: 400 | 403 | 404 }
> {
  // Layer 1 — lexical containment (reuses archiveContainment's battle-tested
  // reject-`..`/absolute/NUL → resolve → `root + sep` prefix → denylist chain).
  let lexical: string;
  try {
    lexical = assertContained(root, relativeName);
  } catch (err) {
    if (err instanceof PathEscapeError) {
      const r = err.reason;
      const malformed =
        r.includes("NUL") ||
        r.includes("empty") ||
        r.includes("absolute") ||
        r.includes("'..' segment");
      return { ok: false, status: malformed ? 400 : 403 };
    }
    return { ok: false, status: 400 };
  }

  // Layer 2 — symlink resolution. realpath BOTH the root (once) and the leaf, so
  // a symlink anywhere in the candidate is neutralised before the prefix check.
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, status: 404 }; // dimension dir absent → nothing installed
    }
    throw err;
  }
  let realPath: string;
  try {
    realPath = await realpath(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, status: 404 }; // candidate leaf absent
    }
    throw err;
  }

  // Prefix form ONLY — equality means the candidate IS the root directory (a
  // directory read, e.g. name="."), which is rejected as malformed.
  if (realPath === realRoot) {
    return { ok: false, status: 400 };
  }
  if (!realPath.startsWith(realRoot + sep)) {
    // Symlink escape — the real target is outside the dimension root. Denylist-
    // bounded follow (issue #3145): FOLLOW (read) the target when it passes the
    // `isSafeMachinePath` denylist AND is not a host OAuth store; otherwise a
    // denylisted target OR one of the two OAuth stores (D1(a)) is a bare 403 — no
    // target, so a link to /etc/… or ~/.ssh/… or a whole-file token store is never
    // even confirmed. 9 of 77 skills are legit operator symlinks into ~/projects/*.
    if (isSafeMachinePath(realPath)) {
      const oauthStores = await resolveExistingRealPaths(oauthStoreCandidates);
      if (!oauthStores.includes(realPath)) {
        return { ok: true, realPath }; // safe, non-OAuth target — follow + read
      }
    }
    return { ok: false, status: 403 };
  }
  return { ok: true, realPath };
}

/** The dimension root + per-dimension leaf resolution for a file read. */
function fileDimensionTarget(
  dimension: FileDimension,
  claudeDir: string,
  name: string
): { root: string; relativeName: string } {
  switch (dimension) {
    case "skills":
      // Skills enumerate as bare DIRECTORY names (`listDimensionEntries`); the
      // readable content file is `<name>/SKILL.md`.
      return {
        root: join(claudeDir, "skills"),
        relativeName: join(name, "SKILL.md"),
      };
    case "hooks":
      // Hooks accept MULTI-SEGMENT relative names (subdir scripts like `lib/x.py`);
      // the client sends the hooks-root-relative path.
      return { root: join(claudeDir, "hooks"), relativeName: name };
    case "agents":
      // Agents are plain files (`bot.md`), read as-is.
      return { root: join(claudeDir, "agents"), relativeName: name };
  }
}

/** #3546 read-back redaction placeholder — a fixed marker, never a real value. */
const REDACTED_VALUE = "••••••••";

/**
 * #3546 (R9 / ADR-0006 §Security): redact credential-bearing VALUES from an MCP
 * stanza before it is read back over `GET /porter/content?dimension=mcp`. Keeps
 * every KEY NAME and the non-secret structure (command/args/type — the review
 * value) but replaces each `env` value, each `headers` value, and the `url` with a
 * fixed placeholder — the three fields that carry MCP secrets (a `__url__`-slot
 * credential lives in `url`). Positional `args` secrets cannot be pinpointed
 * without the export-time manifest (this route reads the live `~/.claude.json`,
 * which carries no slot metadata) and are the documented residual accepted under
 * #2600 for this operator-only, JWT-gated surface.
 */
function redactMcpStanza(server: unknown): unknown {
  if (typeof server !== "object" || server === null) return server;
  const s: Record<string, unknown> = { ...(server as Record<string, unknown>) };
  for (const field of ["env", "headers"] as const) {
    const val = s[field];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      s[field] = Object.fromEntries(
        Object.keys(val as Record<string, unknown>).map(k => [
          k,
          REDACTED_VALUE,
        ])
      );
    }
  }
  if (typeof s.url === "string") s.url = REDACTED_VALUE;
  return s;
}

export function createPorterInstalledRoutes(opts?: {
  /** Override the config root (for tests). Defaults to `CLAUDE_CONFIG_DIR || ~/.claude`. */
  claudeDir?: string;
  /**
   * Override the host `.claude.json` path for the MCP dimension (for tests).
   * Resolved via `resolveHostConfigPath` (#2620/#1551 precedence) otherwise.
   */
  hostConfigPath?: string;
  /** #3590 (K6/D7): shared last-import box; exposes `lastImport` on the response. */
  lastImport?: PorterLastImportBox;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/porter/installed",
    cataloged(
      defineCapability({
        id: "porter.list-installed",
        domain: "porter",
        surface: "rest",
        description:
          "List the host's installed Claude config inventory (skills, agents, hooks, plugins, registrations) — names and validation status, no secrets.",
        whenToUse:
          "When the user reviews what config is installed on this node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/porter/installed",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      const claudeDir = opts?.claudeDir ?? resolveClaudeConfigDir();

      const [skills, agents, files, registrations, validation, plugins] =
        await Promise.all([
          listDimensionEntries(join(claudeDir, "skills")),
          listDimensionEntries(join(claudeDir, "agents")),
          collectHookFiles(join(claudeDir, "hooks")),
          listSettingsHookRegistrations(claudeDir),
          validateHookRegistration(claudeDir),
          readInstalledPlugins(claudeDir),
        ]);

      const response: InstalledConfigResponse = {
        claudeDir,
        skills,
        agents,
        hooks: {
          files,
          registrations,
          orphanFiles: validation.orphanFiles,
          orphanRegistrations: validation.orphanRegistrations,
        },
        plugins,
        lastImport: opts?.lastImport?.current ?? null,
      };
      return c.json(response);
    }
  );

  // GET /porter/content?dimension=<skills|hooks|agents|mcp>&name=<item> (#3116).
  // The Configuration page's preview pane reads ONE installed file's text. See the
  // module doc above `MAX_CONTENT_BYTES` for the three-layer allowlist rationale.
  app.get(
    "/porter/content",
    cataloged(
      defineCapability({
        id: "porter.get-content",
        domain: "porter",
        surface: "rest",
        description:
          "Return the content of one installed config leaf (a single named MCP stanza, skill, agent or hook); never the whole ~/.claude.json.",
        whenToUse:
          "When the user inspects one installed config item's contents.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/porter/content",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      const dimension = c.req.query("dimension");
      const name = c.req.query("name");

      if (typeof name !== "string" || name.length === 0) {
        return c.json({ error: "missing-name" }, 400);
      }
      // A bare `.`/`..` never names a readable leaf; reject before path building.
      if (name === "." || name === "..") {
        return c.json({ error: STATUS_ERROR[400] }, 400);
      }

      const claudeDir = opts?.claudeDir ?? resolveClaudeConfigDir();

      // MCP dimension (#3116 Task 3): extract ONLY the requested server's stanza
      // from `~/.claude.json` — NEVER the whole file (it holds OAuth tokens).
      if (dimension === "mcp") {
        const hostConfigPath = resolveHostConfigPath(
          opts?.hostConfigPath,
          opts?.claudeDir
        );
        let raw: string;
        try {
          raw = await readFile(hostConfigPath, "utf-8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return c.json({ error: STATUS_ERROR[404] }, 404); // host file absent
          }
          return c.json({ error: "read-failed" }, 500);
        }
        let config: Record<string, unknown>;
        try {
          config = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return c.json({ error: "invalid-config" }, 500);
        }
        const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
        // Own-property lookup ONLY — a bare `servers[name]` with name="__proto__"
        // / "constructor" would return inherited junk, never an own stanza.
        if (!Object.hasOwn(servers, name)) {
          return c.json({ error: STATUS_ERROR[404] }, 404);
        }
        // #3546 (R9 / ADR-0006): redact credential VALUES (env / headers / url)
        // before read-back — keep the key names + structure for review, never
        // return a secret value in plaintext.
        const stanza = JSON.stringify(redactMcpStanza(servers[name]), null, 2);
        return c.json({ path: hostConfigPath, content: stanza });
      }

      if (
        dimension !== "skills" &&
        dimension !== "hooks" &&
        dimension !== "agents"
      ) {
        return c.json({ error: "unknown-dimension" }, 400);
      }

      const { root, relativeName } = fileDimensionTarget(
        dimension,
        claudeDir,
        name
      );
      // D1(a) (issue #3145): the two host OAuth stores pass `isSafeMachinePath` but
      // must never be followed — pass them so the escape branch refuses them with a
      // bare 403 (they are realpath'd lazily, only if a symlink actually escapes).
      const oauthStoreCandidates = [
        resolveHostConfigPath(opts?.hostConfigPath, opts?.claudeDir),
        join(claudeDir, ".credentials.json"),
      ];
      const resolved = await resolveContainedRealPath(
        root,
        relativeName,
        oauthStoreCandidates
      );
      if (!resolved.ok) {
        // Every refusal returns the bare status slug (no target). A safe, non-OAuth
        // symlink escape now returns { ok: true } and falls through to the read
        // block below — the denylist-bounded follow (issue #3145).
        return c.json(
          { error: STATUS_ERROR[resolved.status] },
          resolved.status
        );
      }

      // Size + binary guards (never stream a huge or binary blob as text).
      let st;
      try {
        st = await stat(resolved.realPath);
      } catch {
        return c.json({ error: STATUS_ERROR[404] }, 404);
      }
      if (st.isDirectory()) {
        return c.json({ error: "is-a-directory" }, 400);
      }
      if (!st.isFile()) {
        return c.json({ error: "not-a-file" }, 400);
      }
      if (st.size > MAX_CONTENT_BYTES) {
        return c.json({
          path: resolved.realPath,
          content: "",
          truncated: true,
          size: st.size,
        });
      }
      const buf = await readFile(resolved.realPath);
      if (buf.includes(0)) {
        return c.json({ path: resolved.realPath, content: "", binary: true });
      }
      return c.json({
        path: resolved.realPath,
        content: buf.toString("utf-8"),
      });
    }
  );

  return app;
}
