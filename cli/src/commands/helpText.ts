// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Help text for `hapi --help` and `hapi server --help` (#5180 F7, F10).
 *
 * Pure builders, so the wording is testable without starting anything:
 * `hapi server --help` used to import the server and mint a token (F7), and
 * the root help still carried the upstream product's strings (F10).
 */
import chalk from "chalk";

/**
 * Usage for `hapi server`. The server reads no flags, only environment
 * variables (`server/src/configuration.ts`), so the usage lists those.
 */
export function buildServerHelpText(): string {
  return `
${chalk.bold("Usage:")} hapi server

Starts the Hapimatic server: the web app and the API, on port 3006 on every
network interface. Apart from the web app's files and a few status endpoints,
every request needs this machine's access token.

${chalk.bold("Environment variables:")}
  WEBAPP_PORT          Port to listen on (default: 3006)
  HAPI_HOME            Data directory (default: ~/.hapi)
  CLI_API_TOKEN        Access token (generated and saved on first run)
  CORS_ORIGINS         Comma-separated origins allowed to call the API
  WEBAPP_URL           Public URL of the web app
  TELEGRAM_BOT_TOKEN   Telegram bot token (optional)

See https://hapimatic.com/docs/guide/installation
`;
}

/** Root usage for `hapi --help` / `hapi -h`. */
export function buildRootHelpText(): string {
  return `
${chalk.bold("hapi")} — the Hapimatic command line

${chalk.bold("Usage:")}
  hapi [options]         Start a Claude Code session connected to your Hapimatic server
  hapi auth              Manage this machine's access token
  hapi codex             Start a Codex session
  hapi gemini            Start a Gemini CLI session
  hapi opencode          Start an OpenCode session
  hapi mcp               Start the MCP stdio bridge
  hapi server            Start the Hapimatic server (web app and API)
  hapi daemon            Manage the background service that starts sessions
                            from the web app
  hapi doctor            Check this machine and troubleshoot

${chalk.bold("Examples:")}
  hapi                    Start a session (asks for the access token if not set)
  hapi auth login         Set the access token interactively
  hapi --yolo             Start with permission prompts skipped
                            (short for --dangerously-skip-permissions)
  hapi auth status        Show how this machine connects to the server
  hapi doctor             Run the checks

${chalk.bold("hapi passes every other option to Claude Code")}
  Use any claude flag with hapi as you would with claude, for example:

  hapi --resume

${chalk.gray("─".repeat(60))}
${chalk.bold.cyan("Claude Code Options (from `claude --help`):")}
`;
}
