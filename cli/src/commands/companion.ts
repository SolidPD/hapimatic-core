// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hapi companion` — the local hardware companion (issue #4352).
 *
 * On the bench machine:  start | stop | status
 * On the cloud VM:       pair | list | ssh | ssh-config | revoke
 *
 * Design: docs/internal/architecture/hardware-companion.md. Customer guide:
 * docs/guide/hardware-companion.md.
 */
import chalk from "chalk";
import type { CommandDefinition } from "./types";
import {
  runCompanionStart,
  runCompanionStatus,
  runCompanionStop,
} from "@/companion/helper";
import {
  runCompanionList,
  runCompanionPair,
  runCompanionRevoke,
  runCompanionSsh,
} from "@/companion/vmClient";

export const COMPANION_HELP = `hapi companion — reach a local bench machine from a cloud session over SSH

On the bench machine (macOS or Linux; the account you run it as is the account granted):
  hapi companion start --server <vm url> [--listen <tailnet address>] [--port <first port>]
                       [--sshd <path>] [--approve-for-pairing] [--yes]
      Pair with the VM, then run until Stop. Shows a pairing code, asks you to approve each
      cloud session that wants in, shows every live connection. Keys: a approve, d deny, s stop.
  hapi companion stop       Stop the running helper (from another terminal)
  hapi companion status     Show the running helper's state

On the cloud VM (inside a Hapimatic session):
  hapi companion pair <code> [--yes]       Confirm the code the bench shows
  hapi companion list                      Show paired bench machines and connections
  hapi companion ssh [--pairing <id>] [--session <id>] [--wait <seconds>] [<ssh args or command>]
      Everything after the options goes to ssh (for example: hapi companion ssh uname -a).
      Quote a remote command that contains --: hapi companion ssh 'git diff -- src'
  hapi companion ssh-config [--pairing <id>] [--session <id>] [--wait <seconds>]
      Print a short-lived ssh config path for scp, sftp and port forwarding (ssh -F <path>)
  hapi companion revoke <pairing id>       End a pairing

Stopping the helper removes the access it created. It does not undo commands already run on
the bench, and it does not make attached hardware safe.`;

type Parsed = {
  positionals: string[];
  flags: Map<string, string | true>;
  /** Passed through to ssh: everything after `ssh`'s own options. */
  rest: string[];
};

const VALUE_FLAGS = new Set([
  "server",
  "listen",
  "port",
  "sshd",
  "pairing",
  "session",
  "wait",
]);
const BOOLEAN_FLAGS = new Set(["approve-for-pairing", "yes", "help"]);

export function parseCompanionArgs(args: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      rest = args.slice(i + 1);
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2) as [
        string,
        string | undefined,
      ];
      if (VALUE_FLAGS.has(name)) {
        const value = inline ?? args[++i];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`--${name} needs a value`);
        }
        flags.set(name, value);
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true);
      } else {
        throw new Error(`Unknown option --${name}`);
      }
      continue;
    }
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    // `ssh` takes its ssh arguments or remote command straight after its own
    // options, like `ssh host cmd`: the first one starts the pass-through. A
    // `--` cannot be relied on, because the top-level argument normalizer
    // (`utils/cliArgs.ts`) drops everything before the first `--`.
    if (positionals[0] === "ssh") {
      rest = args.slice(i);
      break;
    }
    positionals.push(arg);
  }
  return { positionals, flags, rest };
}

const value = (p: Parsed, name: string): string | undefined => {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

function integerFlag(p: Parsed, name: string): number | undefined {
  const v = value(p, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer`);
  return n;
}

export async function runCompanionCommand(args: string[]): Promise<number> {
  const parsed = parseCompanionArgs(args);
  const [sub, ...positionals] = parsed.positionals;
  if (!sub || sub === "help" || parsed.flags.has("help")) {
    process.stdout.write(`${COMPANION_HELP}\n`);
    return sub || parsed.flags.has("help") ? 0 : 2;
  }
  switch (sub) {
    case "start": {
      const server = value(parsed, "server");
      if (!server) throw new Error("start needs --server <vm url>");
      return runCompanionStart({
        server,
        listen: value(parsed, "listen"),
        portBase: integerFlag(parsed, "port"),
        sshd: value(parsed, "sshd"),
        approveForPairing: parsed.flags.has("approve-for-pairing"),
        yes: parsed.flags.has("yes"),
      });
    }
    case "stop":
      return runCompanionStop();
    case "status":
      return runCompanionStatus();
    case "pair": {
      const code = positionals[0];
      if (!code) throw new Error("pair needs the code the bench shows");
      return runCompanionPair(code, parsed.flags.has("yes"));
    }
    case "list":
      return runCompanionList();
    case "revoke": {
      const id = positionals[0];
      if (!id)
        throw new Error("revoke needs a pairing id (see hapi companion list)");
      return runCompanionRevoke(id);
    }
    case "ssh":
    case "ssh-config":
      return runCompanionSsh({
        pairingId: value(parsed, "pairing"),
        session: value(parsed, "session"),
        waitSeconds: integerFlag(parsed, "wait") ?? 120,
        sshArgs: parsed.rest,
        configOnly: sub === "ssh-config",
      });
    default:
      throw new Error(`Unknown companion command: ${sub}`);
  }
}

export const companionCommand: CommandDefinition = {
  name: "companion",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    let code: number;
    try {
      code = await runCompanionCommand(commandArgs);
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : String(error)
      );
      code = 1;
    }
    process.exit(code);
  },
};
