// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ARGS_SECRET_SLOT_PREFIX,
  URL_SECRET_SLOT,
  type PorterSourceId,
} from "@hapi/protocol/porter";

/**
 * Test-only source HOME for the Configuration Porter end-to-end suite (issue
 * #5165, Task 1). Seeds one machine that holds all three supported sources —
 * Claude Code (`~/.claude` + `~/.claude.json`), Cursor (`~/.cursor/mcp.json`)
 * and Claude Desktop (the Linux XDG candidate, `sources.ts`) — plus credential
 * decoys and MCP secrets that must never travel, and returns the inventory the
 * suite asserts against. Imported ONLY by `*.test.ts` (like `testArchive.ts`).
 *
 * Only Claude Code contributes files, hooks, settings and plugins; Cursor and
 * Claude Desktop contribute MCP servers only (`commitSelection.ts`).
 *
 * Every stdio MCP server runs `bash` and is told apart by its `args`: the
 * importer excludes a server whose `command` does not resolve on the
 * destination PATH (`resolveMcpCommand`, #2640), so a made-up binary name would
 * be dropped as dead-on-arrival instead of exercising the dedupe precedence.
 *
 * Marker strings only: the secret values carry a token prefix or a secret
 * keyword so the exporter treats them as credentials, but none is a real one.
 */

/** A source file the export must carry and the commit must land byte-identical. */
export interface FixtureFile {
  /** Path relative to the source (and destination) `.claude` directory. */
  rel: string;
  /** sha256 (hex) of the seeded bytes. */
  sha256: string;
  /** True for the scripts settings or hooks run; they must land owner-executable. */
  executable: boolean;
}

/** One MCP secret slot: the server, its slot name, and the value seeded at the source. */
export interface FixtureSecretSlot {
  server: string;
  slot: string;
  sourceValue: string;
}

/** The definition a non-secret MCP server must land with, exactly. */
export interface FixtureMcpDefinition {
  command: string;
  args: string[];
}

export interface FixtureInventory {
  /** The seeded source HOME. */
  home: string;
  /** Every file under `.claude` that must arrive at the destination. */
  files: FixtureFile[];
  /**
   * Hook registrations the export records as missing files: a `~/.claude`
   * script that does not exist, and a `$HOME/...` reference outside `~/.claude`
   * that the exporter cannot resolve (both exporters expand `$HOME` only in
   * `~/.claude` paths). Neither is R6's outside-root case: an existing script
   * outside `~/.claude` written as an absolute path is carried today (#4331),
   * which PR-1 does not cover.
   */
  droppedHookCommands: { missing: string; unresolvable: string };
  /** The `$HOME/.claude/<rel>` scripts that hooks/statusLine/apiKeyHelper run and the export carries. */
  carriedScripts: string[];
  /** MCP server names seeded per source, before cross-source dedupe. */
  mcpBySource: Record<PorterSourceId, string[]>;
  /** Every MCP server name the destination must hold after dedupe. */
  mcpLanded: string[];
  /** The definition each non-secret server must land with (Claude Code's `shared` wins). */
  mcpDefinitions: Record<string, FixtureMcpDefinition>;
  /** The name both Claude Code and Cursor define; Claude Code's must win. */
  dedupe: {
    name: string;
    winnerArgs: string[];
    loserArgs: string[];
    cursorDuplicates: number;
  };
  /** Every MCP secret slot (env, args, url, header); none of their source values may travel. */
  secretSlots: FixtureSecretSlot[];
  /** Marker written into every decoy; it must reach neither archive nor destination. */
  decoyMarker: string;
  /** Decoy paths relative to `home` (credential-bearing; never exported). */
  decoys: string[];
  /** The `settings.json` env entry the script exporter drops (`exportShared.ts`). */
  droppedEnvKey: string;
  /** The untrusted plugin marketplace seeded so the plugin-install gate is reachable (R9). */
  plugin: { marketplace: string; source: string; plugin: string };
  /** Settings references the `outsideReferences` variant seeds (D5 and the credential refusal). */
  outside?: {
    apiKeyHelper: string;
    apiKeyHelperPath: string;
    statusLine: string;
  };
}

export interface SeedOptions {
  /**
   * The second-run variant (#5165 D5): `apiKeyHelper` names a file outside
   * `~/.claude` (it lands verbatim and is reported, never carried), and
   * `statusLine` runs a credential-named script inside `~/.claude` (the carry
   * path refuses it). Neither script travels, so neither is in `files`.
   */
  outsideReferences?: boolean;
}

export const FIXTURE_DECOY_MARKER = "DECOY-5165-must-not-travel";

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

function put(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

const bashServer = (marker: string): FixtureMcpDefinition => ({
  command: "bash",
  args: ["-c", `echo ${marker}`],
});

/** Seed the three-source source HOME under `home` and return its inventory. */
export function seedThreeSourceHome(
  home: string,
  opts: SeedOptions = {}
): FixtureInventory {
  const claude = join(home, ".claude");

  const carried: { rel: string; content: string; executable?: boolean }[] = [
    {
      rel: "skills/demo-skill/SKILL.md",
      content:
        "---\nname: demo-skill\ndescription: E2E fixture skill (#5165)\n---\n# demo-skill\n",
    },
    { rel: "skills/demo-skill/ref/notes.md", content: "# demo-skill notes\n" },
    { rel: "agents/reviewer.md", content: "# reviewer agent (#5165)\n" },
    { rel: "commands/ship.md", content: "# /ship command (#5165)\n" },
    { rel: "rules/style.md", content: "# style rule (#5165)\n" },
    {
      rel: "output-styles/terse.md",
      content: "# terse output style (#5165)\n",
    },
    {
      // The second include names a credential file at the config root: the
      // include resolver must refuse it and the decoy must not travel (#4172).
      rel: "CLAUDE.md",
      content:
        "# E2E fixture instructions (#5165)\n\n@ROOT-INC.md\n@.credentials.json\n",
    },
    { rel: "ROOT-INC.md", content: "Included from CLAUDE.md (#5165).\n" },
    {
      rel: "hooks/pre.sh",
      content:
        '#!/bin/sh\n. "$HOME/.claude/hooks/lib/util.sh"\necho INERT-5165-pre-hook\n',
      executable: true,
    },
    {
      rel: "hooks/lib/util.sh",
      content: "# INERT-5165 hook support file\n",
    },
    {
      rel: "statusline-command.sh",
      content: "#!/bin/sh\necho INERT-5165-statusline\n",
      executable: true,
    },
    {
      rel: "key-helper.sh",
      content: "#!/bin/sh\necho INERT-5165-key-helper\n",
      executable: true,
    },
  ];
  for (const f of carried) {
    put(join(claude, f.rel), f.content, f.executable ? 0o755 : undefined);
  }

  // Credential decoys. `.credentials.json` is a named non-portable surface
  // (reached through the CLAUDE.md include above), `.env` is credential-bearing
  // by name, and the link reaches `~/.aws` from inside the skills dimension (#4172).
  const decoy = `${FIXTURE_DECOY_MARKER}\n`;
  const decoys = [
    ".claude/.credentials.json",
    ".claude/skills/demo-skill/.env",
    ".aws/credentials",
  ];
  for (const rel of decoys) put(join(home, rel), decoy);
  symlinkSync("../../.aws", join(claude, "skills/aws-link"));
  decoys.push(".claude/skills/aws-link");

  // Neither script is seeded: the exporter cannot resolve the second one's
  // literal `$HOME` outside `~/.claude`, so a seeded file would never be read.
  const droppedHookCommands = {
    missing: "bash $HOME/.claude/hooks/missing.sh",
    unresolvable: "bash $HOME/tools/unresolvable-hook.sh",
  };
  const outside = opts.outsideReferences
    ? {
        apiKeyHelper: "/opt/hapi-e2e-5165/key-helper --print",
        apiKeyHelperPath: "/opt/hapi-e2e-5165/key-helper",
        statusLine: 'bash "$HOME/.claude/.env.sh"',
      }
    : undefined;
  if (outside) {
    // A credential-named script the settings-script carry path must refuse.
    put(
      join(claude, ".env.sh"),
      `#!/bin/sh\necho ${FIXTURE_DECOY_MARKER}\n`,
      0o755
    );
    decoys.push(".claude/.env.sh");
  }
  put(
    join(claude, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "bash $HOME/.claude/hooks/pre.sh" },
              ],
            },
            {
              matcher: "Read",
              hooks: [
                { type: "command", command: droppedHookCommands.missing },
              ],
            },
            {
              matcher: "Glob",
              hooks: [
                { type: "command", command: droppedHookCommands.unresolvable },
              ],
            },
          ],
        },
        statusLine: {
          type: "command",
          command:
            outside?.statusLine ?? 'bash "$HOME/.claude/statusline-command.sh"',
        },
        apiKeyHelper: outside?.apiKeyHelper ?? "$HOME/.claude/key-helper.sh",
        permissions: { allow: ["Bash(ls:*)"] },
        env: { FOO: "bar" },
      },
      null,
      2
    )
  );

  // A plugin from a marketplace that is NOT on the trust allowlist: the export
  // carries its descriptor, so the plugin-install gate is reachable (R9), and an
  // install attempt would stop at `skipped-untrusted` (`pluginInstall.ts`).
  const plugin = {
    marketplace: "e2e-untrusted",
    source: "hapi-e2e-fixture/untrusted-marketplace",
    plugin: "demo-plugin",
  };
  put(
    join(claude, "plugins/known_marketplaces.json"),
    JSON.stringify({
      [plugin.marketplace]: {
        source: { source: "github", repo: plugin.source },
      },
    })
  );
  put(
    join(claude, "plugins/installed_plugins.json"),
    JSON.stringify({
      plugins: {
        [`${plugin.plugin}@${plugin.marketplace}`]: { version: "1.0.0" },
      },
    })
  );

  // MCP servers. Every secret slot type is seeded once — env (Claude Code), a
  // token-bearing url and a header (Cursor remote), a credential argument
  // (Claude Desktop) — each with a source value that must never travel.
  const argSlot = `${ARGS_SECRET_SLOT_PREFIX}2__`;
  const secretSlots: FixtureSecretSlot[] = [
    {
      server: "with-secret",
      slot: "API_KEY",
      sourceValue: "sk-fixture-SOURCE-VALUE-must-not-travel",
    },
    {
      server: "cursor-remote",
      slot: URL_SECRET_SLOT,
      sourceValue:
        "https://mcp.fixture.invalid/rpc?token=fixture-url-SOURCE-VALUE-must-not-travel",
    },
    {
      server: "cursor-remote",
      slot: "X-Api-Key",
      sourceValue: "fixture-header-SOURCE-VALUE-must-not-travel",
    },
    {
      server: "desktop-secret",
      slot: argSlot,
      sourceValue: "--api-key=fixture-arg-SOURCE-VALUE-must-not-travel",
    },
  ];
  const valueOf = (server: string, slot: string): string =>
    secretSlots.find(s => s.server === server && s.slot === slot)!.sourceValue;

  const definitions: Record<string, FixtureMcpDefinition> = {
    "cc-only": bashServer("cc-only"),
    shared: bashServer("cc-shared"),
    "cursor-only": bashServer("cursor-only"),
    "desktop-only": bashServer("desktop-only"),
  };
  const loser = bashServer("cursor-shared");
  const desktopSecret = bashServer("desktop-secret");
  put(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "cc-only": definitions["cc-only"],
        shared: definitions.shared,
        "with-secret": {
          ...bashServer("with-secret"),
          env: { API_KEY: valueOf("with-secret", "API_KEY") },
        },
      },
    })
  );
  put(
    join(home, ".cursor/mcp.json"),
    JSON.stringify({
      mcpServers: {
        "cursor-only": definitions["cursor-only"],
        shared: loser,
        "cursor-remote": {
          url: valueOf("cursor-remote", URL_SECRET_SLOT),
          headers: { "X-Api-Key": valueOf("cursor-remote", "X-Api-Key") },
        },
      },
    })
  );
  put(
    join(home, ".config/Claude/claude_desktop_config.json"),
    JSON.stringify({
      mcpServers: {
        "desktop-only": definitions["desktop-only"],
        "desktop-secret": {
          command: desktopSecret.command,
          args: [...desktopSecret.args, valueOf("desktop-secret", argSlot)],
        },
      },
    })
  );

  const carriedFiles = outside
    ? carried.filter(
        f => f.rel !== "statusline-command.sh" && f.rel !== "key-helper.sh"
      )
    : carried;
  return {
    home,
    files: carriedFiles.map(f => ({
      rel: f.rel,
      sha256: sha256(f.content),
      executable: f.executable === true,
    })),
    droppedHookCommands,
    carriedScripts: outside
      ? ["hooks/pre.sh"]
      : ["hooks/pre.sh", "statusline-command.sh", "key-helper.sh"],
    mcpBySource: {
      "claude-code": ["cc-only", "shared", "with-secret"],
      cursor: ["cursor-only", "shared", "cursor-remote"],
      "claude-desktop": ["desktop-only", "desktop-secret"],
    },
    mcpLanded: [
      "cc-only",
      "cursor-only",
      "cursor-remote",
      "desktop-only",
      "desktop-secret",
      "shared",
      "with-secret",
    ],
    mcpDefinitions: definitions,
    dedupe: {
      name: "shared",
      winnerArgs: definitions.shared.args,
      loserArgs: loser.args,
      cursorDuplicates: 1,
    },
    secretSlots,
    decoyMarker: FIXTURE_DECOY_MARKER,
    decoys,
    droppedEnvKey: "FOO",
    plugin,
    outside,
  };
}
