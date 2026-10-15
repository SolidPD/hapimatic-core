// SPDX-License-Identifier: AGPL-3.0-only
import axios from "axios";
import chalk from "chalk";
import { configuration } from "@/configuration";
import type { CommandContext, CommandDefinition } from "./types";
import { authenticateCli } from "./cliAuth";

function authHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
}

async function run(context: CommandContext): Promise<void> {
  const subcommand = context.commandArgs[0];

  if (
    !subcommand ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    printHelp();
    return;
  }

  if (subcommand === "status") {
    await statusCommand();
    return;
  }

  if (subcommand === "drain-node") {
    const nodeId = context.commandArgs[1];
    if (!nodeId) {
      console.error(chalk.red("Usage: hapi federation drain-node <nodeId>"));
      process.exit(1);
    }
    await drainNodeCommand(nodeId);
    return;
  }

  console.error(chalk.red(`Unknown federation subcommand: ${subcommand}`));
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`
${chalk.bold("hapi federation")} — Federation node management

${chalk.bold("Commands:")}
  ${chalk.cyan("status")}          Show federation node status
  ${chalk.cyan("drain-node")} ${chalk.dim("<id>")}  Mark a node as draining (no new sessions)
  ${chalk.cyan("help")}            Show this help

${chalk.bold("Examples:")}
  hapi federation status
  hapi federation drain-node sl7
`);
}

async function statusCommand(): Promise<void> {
  const url = configuration.serverUrl;

  try {
    // Inside the try so a failed login ends in one "failed" line, not the error
    // object (#5098). A 401 for a settings.json token prints #5080's hint first.
    const jwt = await authenticateCli();
    const resp = await axios.get(`${url}/api/federation/nodes`, {
      headers: authHeaders(jwt),
      timeout: 10_000,
    });

    const data = resp.data as {
      enabled: boolean;
      role: string;
      localNode: { nodeId: string; nodeLabel: string } | null;
      nodes: Array<{
        config: { id: string; nodeLabel: string; url: string };
        status: string;
        consecutiveFailures: number;
      }>;
    };

    if (!data.enabled) {
      console.log(chalk.yellow("Federation is not enabled."));
      return;
    }

    console.log(
      chalk.bold("Federation Status") + chalk.dim(` (role: ${data.role})`)
    );

    if (data.localNode) {
      console.log(
        `  Local: ${chalk.green(data.localNode.nodeLabel)} (${data.localNode.nodeId})`
      );
    }

    console.log(chalk.bold("\nRemote Nodes:"));
    if (data.nodes.length === 0) {
      console.log(chalk.dim("  No remote nodes configured"));
      return;
    }

    for (const node of data.nodes) {
      const statusColor =
        node.status === "online"
          ? chalk.green
          : node.status === "degraded"
            ? chalk.yellow
            : chalk.red;
      const failures =
        node.consecutiveFailures > 0
          ? chalk.dim(` (${node.consecutiveFailures} failures)`)
          : "";
      console.log(
        `  ${statusColor("●")} ${node.config.nodeLabel} (${node.config.id}) — ${statusColor(node.status)}${failures}`
      );
      console.log(chalk.dim(`    ${node.config.url}`));
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(chalk.red(`Federation status failed: ${err.message}`));
    } else {
      console.error(
        chalk.red(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
    process.exit(1);
  }
}

async function drainNodeCommand(nodeId: string): Promise<void> {
  const url = configuration.serverUrl;

  try {
    // Inside the try so a failed login ends in one "failed" line, not the error
    // object (#5098). A 401 for a settings.json token prints #5080's hint first.
    const jwt = await authenticateCli();
    const resp = await axios.post(
      `${url}/api/federation/nodes/${encodeURIComponent(nodeId)}/drain`,
      {},
      { headers: authHeaders(jwt), timeout: 10_000 }
    );

    const data = resp.data as {
      ok: boolean;
      nodeId: string;
      status: string;
    };
    if (data.ok) {
      console.log(
        chalk.green(`✓ Node ${chalk.bold(nodeId)} marked as draining`)
      );
      console.log(
        chalk.dim(
          "  Existing sessions will continue. No new sessions will be routed to this node."
        )
      );
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(chalk.red(`Drain failed: ${err.message}`));
    } else {
      console.error(
        chalk.red(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
    process.exit(1);
  }
}

export const federationCommand: CommandDefinition = {
  name: "federation",
  requiresRuntimeAssets: false,
  run,
};
