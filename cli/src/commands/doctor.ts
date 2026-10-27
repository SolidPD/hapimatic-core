// SPDX-License-Identifier: AGPL-3.0-only
import {
  findRunawayHappyProcesses,
  killRunawayHappyProcesses,
} from "@/daemon/doctor";
import { runDoctorCommand } from "@/ui/doctor";
import type { CommandDefinition } from "./types";

const CLEAN_USAGE = `Usage: hapi doctor clean [--dry-run]

  (no option)  Kill the daemon, the sessions it started and stuck version checks
  --dry-run    List what would be killed; kill nothing`;

/**
 * `hapi doctor clean [--dry-run]`. Returns the exit code: 0 on success, 1 when
 * a kill failed or the process list could not be read, 2 for an unknown
 * option. Options are checked before anything is listed or killed, so a typo
 * such as `--dryrun` never runs a real clean (#5763).
 */
export async function runDoctorClean(args: string[]): Promise<number> {
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(CLEAN_USAGE);
      return 0;
    } else {
      console.error(`Unknown option for 'hapi doctor clean': ${arg}`);
      console.error(CLEAN_USAGE);
      return 2;
    }
  }

  try {
    if (dryRun) {
      const runaway = await findRunawayHappyProcesses();
      for (const { pid, command } of runaway) {
        console.log(`Would kill PID ${pid}: ${command}`);
      }
      console.log(
        `Dry run: ${runaway.length} runaway process(es) would be killed; nothing was killed.`
      );
      return 0;
    }

    const result = await killRunawayHappyProcesses();
    console.log(`Cleaned up ${result.killed} runaway processes`);
    if (result.errors.length > 0) {
      console.log("Errors:", result.errors);
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(`Could not list processes: ${(error as Error).message}`);
    return 1;
  }
}

export const doctorCommand: CommandDefinition = {
  name: "doctor",
  requiresRuntimeAssets: true,
  run: async ({ commandArgs }) => {
    if (commandArgs[0] === "clean") {
      process.exit(await runDoctorClean(commandArgs.slice(1)));
    }
    await runDoctorCommand();
  },
};
