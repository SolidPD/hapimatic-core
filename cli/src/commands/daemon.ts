// SPDX-License-Identifier: AGPL-3.0-only
import chalk from "chalk";
import { runCleanupWorktreesCli } from "@/daemon/cleanupWorktreesCli";
import { startDaemon } from "@/daemon/run";
import {
  checkIfDaemonRunningAndCleanupStaleState,
  listDaemonSessions,
  readDaemonBuildSkew,
  stopDaemon,
  stopDaemonSession,
} from "@/daemon/controlClient";
import { getLatestDaemonLog } from "@/ui/logger";
import { spawnHappyCLI } from "@/utils/spawnHappyCLI";
import { writeStdout } from "@/utils/stdout";
import { runDoctorCommand } from "@/ui/doctor";
import { initializeToken } from "@/ui/tokenInit";
import { formatDaemonBuildSkew } from "@/version";
import type { CommandDefinition } from "./types";

export const daemonCommand: CommandDefinition = {
  name: "daemon",
  requiresRuntimeAssets: true,
  run: async ({ commandArgs }) => {
    const daemonSubcommand = commandArgs[0];

    if (daemonSubcommand === "list") {
      try {
        const sessions = await listDaemonSessions();

        if (sessions.length === 0) {
          console.log(
            "No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)"
          );
        } else {
          console.log("Active sessions:");
          writeStdout(JSON.stringify(sessions, null, 2));
        }
      } catch {
        console.log("No daemon running");
      }
      return;
    }

    if (daemonSubcommand === "stop-session") {
      const sessionId = commandArgs[1];
      if (!sessionId) {
        console.error("Session ID required");
        process.exit(1);
      }

      try {
        const success = await stopDaemonSession(sessionId);
        console.log(success ? "Session stopped" : "Failed to stop session");
      } catch {
        console.log("No daemon running");
      }
      return;
    }

    if (daemonSubcommand === "start") {
      // Issue #4594 (D-4594-1 A): a live daemon of any build is left running.
      // Say so (and name a build skew) instead of spawning a start-sync that
      // exits 0 and then reporting "started successfully".
      const existing = await readDaemonBuildSkew();
      if (existing.running) {
        console.log(`Daemon already running (pid ${existing.pid})`);
        const skewLine = formatDaemonBuildSkew(existing);
        if (skewLine) {
          console.log(chalk.yellow(skewLine));
        }
        process.exit(0);
      }

      const child = spawnHappyCLI(["daemon", "start-sync"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();

      let started = false;
      for (let i = 0; i < 50; i++) {
        if (await checkIfDaemonRunningAndCleanupStaleState()) {
          started = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (started) {
        console.log("Daemon started successfully");
      } else {
        console.error("Failed to start daemon");
        process.exit(1);
      }
      process.exit(0);
    }

    if (daemonSubcommand === "start-sync") {
      await initializeToken();
      await startDaemon();
      process.exit(0);
    }

    if (daemonSubcommand === "stop") {
      await stopDaemon();
      process.exit(0);
    }

    if (daemonSubcommand === "status") {
      await runDoctorCommand("daemon");
      process.exit(0);
    }

    if (daemonSubcommand === "logs") {
      const latest = await getLatestDaemonLog();
      if (!latest) {
        console.log("No daemon logs found");
      } else {
        console.log(latest.path);
      }
      process.exit(0);
    }

    if (daemonSubcommand === "cleanup-worktrees") {
      // #1385 Task 4: TS implementation of the bash crons' teardown loop.
      // Discovers failed/expired worktree instances and tears them down via
      // tearDownWorktreeInstance. Output mirrors the bash cron log format.
      // The bash crons (worktree-crash-recovery.sh, worktree-ttl-cleanup.sh)
      // will be reduced to thin wrappers around this subcommand by Task 5.
      const exitCode = await runCleanupWorktreesCli(commandArgs.slice(1));
      process.exit(exitCode);
    }

    console.log(`
${chalk.bold("hapi daemon")} - Daemon management

${chalk.bold("Usage:")}
  hapi daemon start              Start the daemon (detached)
  hapi daemon stop               Stop the daemon (sessions stay alive)
  hapi daemon status             Show daemon status
  hapi daemon list               List active sessions
  hapi daemon cleanup-worktrees  Stop failed/expired worktree instances (cron-driven)

  If you want to kill all hapi related processes run 
  ${chalk.cyan("hapi doctor clean")}

${chalk.bold("Note:")} The daemon runs in the background and manages Claude sessions.

${chalk.bold("To clean up runaway processes:")} Use ${chalk.cyan("hapi doctor clean")}
`);
  },
};
