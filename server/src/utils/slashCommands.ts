// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

interface SlashCommand {
  name: string;
  description?: string;
  source: "builtin" | "user";
}

/**
 * Extract the first sentence from a potentially multi-line description.
 */
function firstSentence(desc: string): string {
  const firstLine = desc.split("\n")[0].trim();
  const sentenceMatch = firstLine.match(/^(.+?[.!])(?:\s|$)/);
  if (sentenceMatch) {
    return sentenceMatch[1];
  }
  if (firstLine.length > 120) {
    return firstLine.slice(0, 117) + "...";
  }
  return firstLine;
}

/**
 * Extract the description field from YAML frontmatter without a YAML parser.
 * Handles both single-line (`description: text`) and multi-line block scalar
 * (`description: |\n  line1\n  line2`) formats.
 */
function extractDescription(fileContent: string): string | undefined {
  const fmMatch = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return undefined;

  const yaml = fmMatch[1];

  // Match "description:" at the start of a line
  const descMatch = yaml.match(/^description:\s*(.*)$/m);
  if (!descMatch) return undefined;

  const inlineValue = descMatch[1].trim();

  // Single-line: `description: some text here`
  if (inlineValue && inlineValue !== "|" && inlineValue !== ">") {
    // Strip surrounding quotes if present
    if (
      (inlineValue.startsWith('"') && inlineValue.endsWith('"')) ||
      (inlineValue.startsWith("'") && inlineValue.endsWith("'"))
    ) {
      return inlineValue.slice(1, -1);
    }
    return inlineValue;
  }

  // Block scalar (| or >): collect indented continuation lines
  const lines = yaml.split("\n");
  const descIdx = lines.findIndex(l => /^description:\s/.test(l));
  if (descIdx < 0) return undefined;

  const blockLines: string[] = [];
  for (let i = descIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // Block continues while lines are indented (2+ spaces)
    if (/^\s{2,}/.test(line)) {
      blockLines.push(line.replace(/^\s+/, ""));
    } else {
      break;
    }
  }

  return blockLines.length > 0 ? blockLines.join("\n") : undefined;
}

/**
 * Scan ~/.claude/commands/ for user-defined commands.
 */
async function scanCommands(configDir: string): Promise<SlashCommand[]> {
  const dir = join(configDir, "commands");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith(".md"));

    const commands = await Promise.all(
      mdFiles.map(async (entry): Promise<SlashCommand | null> => {
        const name = entry.name.slice(0, -3);
        if (!name) return null;

        let description = "Custom command";
        try {
          const content = await readFile(join(dir, entry.name), "utf-8");
          const desc = extractDescription(content);
          if (desc) {
            description = firstSentence(desc);
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            console.warn(
              `[slashCommands] Failed to read command ${entry.name}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        return { name, description, source: "user" };
      })
    );

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
 */
async function scanSkills(configDir: string): Promise<SlashCommand[]> {
  const skillsDir = join(configDir, "skills");
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory());

    const skills = await Promise.all(
      dirs.map(async (entry): Promise<SlashCommand | null> => {
        try {
          const content = await readFile(
            join(skillsDir, entry.name, "SKILL.md"),
            "utf-8"
          );
          const desc = extractDescription(content);
          return {
            name: entry.name,
            description: desc ? firstSentence(desc) : "Custom skill",
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
 * Server-side filesystem scan for slash commands and skills.
 * Used as a fallback when the CLI RPC is unavailable (offline sessions).
 */
export async function scanSlashCommandsFromFilesystem(): Promise<{
  success: boolean;
  commands: SlashCommand[];
}> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

  const [commands, skills] = await Promise.all([
    scanCommands(configDir),
    scanSkills(configDir),
  ]);

  // Deduplicate: commands take priority over skills with the same name
  const commandNames = new Set(commands.map(c => c.name));
  const uniqueSkills = skills.filter(s => !commandNames.has(s.name));

  return {
    success: true,
    commands: [...commands, ...uniqueSkills],
  };
}
