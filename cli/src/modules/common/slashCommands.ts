// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
// Gemini's builtin slash commands live with the `builtin.agent-gemini`
// extension (issue #1273). v0.1's `CliExtensionHost` has no `slashCommands.add`
// contribution point, so the central map imports them by path instead — an
// accepted v0.1 coupling (Open Risk R-3). The imported module is a type-only
// leaf, so this adds no runtime dependency.
import { geminiSlashCommands } from "@/extensions/agent-gemini/slashCommands";

export interface SlashCommand {
  name: string;
  description?: string;
  source: "builtin" | "user";
  content?: string; // Expanded content for Codex user prompts
}

export interface ListSlashCommandsRequest {
  agent: string;
}

export interface ListSlashCommandsResponse {
  success: boolean;
  commands?: SlashCommand[];
  error?: string;
}

/**
 * Built-in slash commands for each agent type.
 */
const BUILTIN_COMMANDS: Record<string, SlashCommand[]> = {
  claude: [
    {
      name: "clear",
      description: "Clear conversation history",
      source: "builtin",
    },
    {
      name: "compact",
      description: "Compact conversation context",
      source: "builtin",
    },
    {
      name: "context",
      description: "Show context information",
      source: "builtin",
    },
    { name: "cost", description: "Show session cost", source: "builtin" },
    { name: "plan", description: "Toggle plan mode", source: "builtin" },
  ],
  codex: [
    { name: "review", description: "Review code", source: "builtin" },
    { name: "new", description: "Start new conversation", source: "builtin" },
    { name: "compat", description: "Check compatibility", source: "builtin" },
    { name: "undo", description: "Undo last action", source: "builtin" },
  ],
  gemini: geminiSlashCommands,
};

/**
 * Parse frontmatter from a markdown file content.
 * Returns the description (from frontmatter) and the body content.
 */
function parseFrontmatter(fileContent: string): {
  description?: string;
  content: string;
} {
  // Match frontmatter: starts with ---, ends with ---
  const match = fileContent.match(
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
  );
  if (match) {
    const yamlContent = match[1];
    const body = match[2].trim();
    try {
      const parsed = parseYaml(yamlContent) as Record<string, unknown> | null;
      const description =
        typeof parsed?.description === "string"
          ? parsed.description
          : undefined;
      return { description, content: body };
    } catch {
      // Invalid YAML - the --- block is not valid frontmatter, return entire file
      return { content: fileContent.trim() };
    }
  }
  // No frontmatter, entire file is content
  return { content: fileContent.trim() };
}

/**
 * Get the user commands directory for an agent type.
 * Returns null if the agent doesn't support user commands.
 */
function getUserCommandsDir(agent: string): string | null {
  switch (agent) {
    case "claude": {
      const configDir =
        process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
      return join(configDir, "commands");
    }
    case "codex": {
      const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
      return join(codexHome, "prompts");
    }
    default:
      // Gemini and other agents don't have user commands
      return null;
  }
}

/**
 * Extract the first sentence from a potentially multi-line description.
 * Skill SKILL.md files often have long descriptions with trigger lists;
 * we only want the first meaningful sentence for the autocomplete menu.
 */
function firstSentence(desc: string): string {
  // Take the first line, then truncate at first sentence boundary
  const firstLine = desc.split("\n")[0].trim();
  // Split on sentence-ending punctuation followed by space or end
  const sentenceMatch = firstLine.match(/^(.+?[.!])(?:\s|$)/);
  if (sentenceMatch) {
    return sentenceMatch[1];
  }
  // No sentence boundary found — use the whole first line, capped at 120 chars
  if (firstLine.length > 120) {
    return firstLine.slice(0, 117) + "...";
  }
  return firstLine;
}

/**
 * Scan a directory for user-defined commands (*.md files).
 * Reads frontmatter for descriptions (all agents) and content (Codex only).
 * Returns the command names (filename without extension).
 */
async function scanUserCommands(agent: string): Promise<SlashCommand[]> {
  const dir = getUserCommandsDir(agent);
  if (!dir) {
    return [];
  }

  const shouldReadContent = agent === "codex";

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith(".md"));

    // Read all files in parallel
    const commands = await Promise.all(
      mdFiles.map(async (entry): Promise<SlashCommand | null> => {
        const name = entry.name.slice(0, -3);
        if (!name) return null;

        const command: SlashCommand = {
          name,
          description: "Custom command",
          source: "user",
        };

        // Read frontmatter for descriptions (all agents) and content (Codex)
        try {
          const filePath = join(dir, entry.name);
          const fileContent = await readFile(filePath, "utf-8");
          const parsed = parseFrontmatter(fileContent);
          if (parsed.description) {
            command.description = firstSentence(parsed.description);
          }
          if (shouldReadContent) {
            command.content = parsed.content;
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            console.warn(
              `[slashCommands] Failed to read command ${entry.name}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        return command;
      })
    );

    // Filter nulls and sort alphabetically
    return commands
      .filter((cmd): cmd is SlashCommand => cmd !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(
        `[slashCommands] Failed to scan commands directory: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return [];
  }
}

/**
 * Scan ~/.claude/skills/ for user-defined skills.
 * Each skill is a directory containing a SKILL.md with YAML frontmatter.
 */
async function scanSkills(): Promise<SlashCommand[]> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const skillsDir = join(configDir, "skills");

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory());

    const skills = await Promise.all(
      dirs.map(async (entry): Promise<SlashCommand | null> => {
        const skillFile = join(skillsDir, entry.name, "SKILL.md");
        try {
          const content = await readFile(skillFile, "utf-8");
          const parsed = parseFrontmatter(content);

          return {
            name: entry.name,
            description: parsed.description
              ? firstSentence(parsed.description)
              : "Custom skill",
            source: "user",
          };
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            console.warn(
              `[slashCommands] Failed to read skill ${entry.name}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          return null;
        }
      })
    );

    return skills
      .filter((s): s is SlashCommand => s !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(
        `[slashCommands] Failed to scan skills directory: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return [];
  }
}

/**
 * List all available slash commands for an agent type.
 * Returns built-in commands, user-defined commands, and skills.
 */
export async function listSlashCommands(
  agent: string
): Promise<SlashCommand[]> {
  const builtin = BUILTIN_COMMANDS[agent] ?? [];

  // Scan commands and skills in parallel
  const [user, skills] =
    agent === "claude"
      ? await Promise.all([scanUserCommands(agent), scanSkills()])
      : [await scanUserCommands(agent), [] as SlashCommand[]];

  // Deduplicate: if a command and skill share the same name, keep the command
  const commandNames = new Set(user.map(c => c.name));
  const uniqueSkills = skills.filter(s => !commandNames.has(s.name));

  // Combine: built-in first, then commands, then skills
  return [...builtin, ...user, ...uniqueSkills];
}
