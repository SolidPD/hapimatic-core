// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Design decisions:
 * - Logging should be done only through file for debugging, otherwise we might disturb the claude session when in interactive mode
 * - Use info for logs that are useful to the user - this is our UI
 * - File output location: ~/.handy/logs/<date time in local timezone>.log
 */

import chalk from "chalk";
import { appendFileSync } from "fs";
import { configuration } from "@/configuration";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { readDaemonState } from "@/persistence";

/**
 * Consistent date/time formatting functions
 */
function createTimestampForFilename(date: Date = new Date()): string {
  return (
    date
      .toLocaleString("sv-SE", {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
      .replace(/[: ]/g, "-")
      .replace(/,/g, "") +
    "-pid-" +
    process.pid
  );
}

function createTimestampForLogEntry(date: Date = new Date()): string {
  return date.toLocaleTimeString("en-US", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

/**
 * Serialize a log argument to string.
 * Handles Error objects specially since JSON.stringify(new Error(...)) produces "{}"
 * (Error properties like message and stack are non-enumerable).
 */
function serializeLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) {
    return arg.stack ?? arg.message;
  }
  return JSON.stringify(arg);
}

function getSessionLogPath(): string {
  const timestamp = createTimestampForFilename();
  const filename = configuration.isDaemonProcess
    ? `${timestamp}-daemon.log`
    : `${timestamp}.log`;
  return join(configuration.logsDir, filename);
}

class Logger {
  constructor(public readonly logFilePath = getSessionLogPath()) {}

  // Use local timezone for simplicity of locating the logs,
  // in practice you will not need absolute timestamps
  localTimezoneTimestamp(): string {
    return createTimestampForLogEntry();
  }

  debug(message: string, ...args: unknown[]): void {
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, ...args);

    // NOTE: @kirill does not think its a good ideas,
    // as it will break us using claude in interactive mode.
    // Instead simply open the debug file in a new editor window.
    //
    // Also log to console in development mode
    // if (process.env.DEBUG) {
    //   this.logToConsole('debug', '', message, ...args)
    // }
  }

  debugLargeJson(
    message: string,
    object: unknown,
    maxStringLength: number = 100,
    maxArrayLength: number = 10
  ): void {
    if (!process.env.DEBUG) {
      this.debug(`In production, skipping message inspection`);
      return;
    }

    // Some of our messages are huge, but we still want to show them in the logs
    const truncateStrings = (obj: unknown): unknown => {
      if (typeof obj === "string") {
        return obj.length > maxStringLength
          ? obj.substring(0, maxStringLength) + "... [truncated for logs]"
          : obj;
      }

      if (Array.isArray(obj)) {
        const truncatedArray = obj
          .map(item => truncateStrings(item))
          .slice(0, maxArrayLength);
        if (obj.length > maxArrayLength) {
          truncatedArray.push(
            `... [truncated array for logs up to ${maxArrayLength} items]` as unknown
          );
        }
        return truncatedArray;
      }

      if (obj && typeof obj === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
          if (key === "usage") {
            // Drop usage, not generally useful for debugging
            continue;
          }
          result[key] = truncateStrings(value);
        }
        return result;
      }

      return obj;
    };

    const truncatedObject = truncateStrings(object);
    const json = JSON.stringify(truncatedObject, null, 2);
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, "\n", json);
  }

  info(message: string, ...args: unknown[]): void {
    this.logToConsole("info", "", message, ...args);
    this.debug(message, ...args);
  }

  infoDeveloper(message: string, ...args: unknown[]): void {
    // Always write to debug
    this.debug(message, ...args);

    // Write to info if DEBUG mode is on
    if (process.env.DEBUG) {
      this.logToConsole("info", "[DEV]", message, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    this.logToConsole("warn", "", message, ...args);
    this.debug(`[WARN] ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.logToConsole("error", "", message, ...args);
    this.debug(`[ERROR] ${message}`, ...args);
  }

  /**
   * Report an error to the server's error logging system.
   * Fire-and-forget — never blocks, never throws.
   */
  reportError(options: {
    message: string;
    stack?: string | null;
    category: string;
    severity?: "debug" | "info" | "warn" | "error" | "fatal";
    sessionId?: string | null;
    context?: string | null;
  }): void {
    this.debug(`[REPORT] ${options.severity ?? "error"}: ${options.message}`);

    const serverUrl = configuration.serverUrl;
    const token = configuration.cliApiToken;
    if (!serverUrl || !token) return;

    fetch(`${serverUrl}/cli/error-reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: options.message.slice(0, 2000),
        stack: options.stack?.slice(0, 5000) ?? null,
        category: options.category,
        severity: options.severity ?? "error",
        sessionId: options.sessionId ?? null,
        context: options.context ?? null,
      }),
    }).catch(() => {
      // Silently discard — avoid disrupting the CLI session
    });
  }

  /**
   * Report a caught error to the server's error logging system.
   * Normalizes unknown values into {message, stack} before delegating to reportError.
   * Fire-and-forget — never blocks, never throws.
   */
  reportCaught(
    error: unknown,
    options: {
      category: string;
      severity?: "debug" | "info" | "warn" | "error" | "fatal";
      sessionId?: string | null;
      context?: string | null;
      messagePrefix?: string;
    }
  ): void {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const message = options.messagePrefix
      ? `${options.messagePrefix}: ${baseMessage}`
      : baseMessage;
    this.reportError({
      message,
      stack: error instanceof Error ? (error.stack ?? null) : null,
      category: options.category,
      severity: options.severity,
      sessionId: options.sessionId,
      context: options.context,
    });
  }

  getLogPath(): string {
    return this.logFilePath;
  }

  private logToConsole(
    level: "debug" | "error" | "info" | "warn",
    prefix: string,
    message: string,
    ...args: unknown[]
  ): void {
    switch (level) {
      case "debug": {
        console.log(chalk.gray(prefix), message, ...args);
        break;
      }

      case "error": {
        console.error(chalk.red(prefix), message, ...args);
        break;
      }

      case "info": {
        console.log(chalk.blue(prefix), message, ...args);
        break;
      }

      case "warn": {
        console.log(chalk.yellow(prefix), message, ...args);
        break;
      }

      default: {
        this.debug("Unknown log level:", level);
        console.log(chalk.blue(prefix), message, ...args);
        break;
      }
    }
  }

  private logToFile(prefix: string, message: string, ...args: unknown[]): void {
    const logLine = `${prefix} ${message} ${args
      .map(arg => serializeLogArg(arg))
      .join(" ")}\n`;

    // Handle async file path
    try {
      appendFileSync(this.logFilePath, logLine);
    } catch (appendError) {
      if (process.env.DEBUG) {
        console.error(
          "[DEV MODE ONLY THROWING] Failed to append to log file:",
          appendError
        );
        throw appendError;
      }
      // In production, fail silently to avoid disturbing Claude session
    }
  }
}

// Will be initialized immideately on startup
export let logger = new Logger();

/**
 * Information about a log file on disk
 */
export type LogFileInfo = {
  file: string;
  path: string;
  modified: Date;
};

/**
 * List daemon log files in descending modification time order.
 * Returns up to `limit` entries; empty array if none.
 */
export async function listDaemonLogFiles(
  limit: number = 50
): Promise<LogFileInfo[]> {
  try {
    const logsDir = configuration.logsDir;
    if (!existsSync(logsDir)) {
      return [];
    }

    const logs = readdirSync(logsDir)
      .filter(file => file.endsWith("-daemon.log"))
      .map(file => {
        const fullPath = join(logsDir, file);
        const stats = statSync(fullPath);
        return { file, path: fullPath, modified: stats.mtime } as LogFileInfo;
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());

    // Prefer the path persisted by the daemon if present (return 0th element if present)
    try {
      const state = await readDaemonState();

      if (!state) {
        return logs;
      }

      if (state.daemonLogPath && existsSync(state.daemonLogPath)) {
        const stats = statSync(state.daemonLogPath);
        const persisted: LogFileInfo = {
          file: basename(state.daemonLogPath),
          path: state.daemonLogPath,
          modified: stats.mtime,
        };
        const idx = logs.findIndex(l => l.path === persisted.path);
        if (idx >= 0) {
          const [found] = logs.splice(idx, 1);
          logs.unshift(found);
        } else {
          logs.unshift(persisted);
        }
      }
    } catch {
      // Ignore errors reading daemon state; fall back to directory listing
    }

    return logs.slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

/**
 * Get the most recent daemon log file, or null if none exist.
 */
export async function getLatestDaemonLog(): Promise<LogFileInfo | null> {
  const [latest] = await listDaemonLogFiles(1);
  return latest || null;
}
