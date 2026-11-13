// SPDX-License-Identifier: AGPL-3.0-only
export type CommandContext = {
  args: string[];
  subcommand?: string;
  commandArgs: string[];
};

export type CommandDefinition = {
  name: string;
  requiresRuntimeAssets: boolean;
  run: (context: CommandContext) => Promise<void>;
  /**
   * The command takes the end-of-options marker `--` (hapimatic-private#5348). A
   * command that sets it handles `--` itself, and no token after it may set a mode,
   * a model, an effort or any posture. Every other command refuses a `--` in `runCli`
   * before it runs. Only the claude default command and `companion` set it, and
   * `registerCommand` refuses it, so no extension can opt in.
   */
  acceptsEndOfOptions?: true;
};
