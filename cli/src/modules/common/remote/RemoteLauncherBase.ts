// SPDX-License-Identifier: AGPL-3.0-only
import { render } from "ink";
import type { ReactElement } from "react";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { restoreTerminalState } from "@/ui/terminalState";
import { NO_META_TEARDOWN } from "@/api/rpc/types";
import type { CapabilityMeta } from "@/api/rpc/types";

export type RemoteLauncherExitReason = "switch" | "exit";

export type RemoteLauncherDisplayContext = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit: () => void | Promise<void>;
  onSwitchToLocal: () => void | Promise<void>;
};

export type RemoteLauncherTerminalHandlers = {
  onExit: () => void | Promise<void>;
  onSwitchToLocal: () => void | Promise<void>;
};

export type RemoteLauncherAbortHandlers = {
  onAbort: () => void | Promise<void>;
  onSwitch: () => void | Promise<void>;
};

type RpcHandlerManagerLike = {
  registerHandler<TRequest = unknown, TResponse = unknown>(
    method: string,
    handler: (params: TRequest) => Promise<TResponse> | TResponse,
    // issue #3742: `meta` is required on the real `RpcHandlerManager`, so this
    // duck-type must require it too (a real manager with three required args is
    // not assignable to a `meta?: CapabilityMeta` shape) — every abort/switch
    // stub here passes the sentinel.
    meta: CapabilityMeta | typeof NO_META_TEARDOWN
  ): void;
};

export abstract class RemoteLauncherBase {
  protected readonly messageBuffer: MessageBuffer;
  protected readonly hasTTY: boolean;
  protected readonly logPath?: string;
  protected exitReason: RemoteLauncherExitReason | null = null;
  protected shouldExit: boolean = false;
  private inkInstance: ReturnType<typeof render> | null = null;

  protected constructor(logPath?: string) {
    this.logPath = logPath;
    this.hasTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    this.messageBuffer = new MessageBuffer();
  }

  protected abstract createDisplay(
    context: RemoteLauncherDisplayContext
  ): ReactElement;

  protected abstract runMainLoop(): Promise<void>;

  protected abstract cleanup(): Promise<void>;

  protected setupTerminal(handlers: RemoteLauncherTerminalHandlers): void {
    if (this.hasTTY) {
      console.clear();
      this.inkInstance = render(
        this.createDisplay({
          messageBuffer: this.messageBuffer,
          logPath: this.logPath,
          onExit: handlers.onExit,
          onSwitchToLocal: handlers.onSwitchToLocal,
        }),
        {
          exitOnCtrlC: false,
          patchConsole: false,
        }
      );
    }

    if (this.hasTTY) {
      process.stdin.resume();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.setEncoding("utf8");
    }
  }

  protected setupAbortHandlers(
    rpcHandlerManager: RpcHandlerManagerLike,
    handlers: RemoteLauncherAbortHandlers,
    // Issue #2421 / #3742: the CapabilityMeta for the `abort` registration so a
    // subclass migrates it through the registry with its OWN accurate meta
    // (ClaudeRemoteLauncher passes ABORT_META). Now REQUIRED (issue #3742 made
    // `registerHandler`'s meta required): codex passes NO_META_TEARDOWN — its
    // abort stays meta-less until its own meta migration, never a Claude-worded
    // meta on a codex session (the self-description-lies drift class, D4-A).
    abortMeta: CapabilityMeta | typeof NO_META_TEARDOWN,
    // Issue #3745 (epic #3740, Sub-Issue E): the CapabilityMeta for the `switch`
    // registration, threaded exactly like `abortMeta` so the sdk-active `switch`
    // announces WITH meta (the audit reads the LIVE registry — a source-only meta
    // elsewhere would still leave the sdk-launcher `switch` a reverse-drift). The
    // Claude launcher passes SWITCH_META; codex passes NO_META_TEARDOWN (never a
    // Claude-worded meta on a codex session, D4-A).
    switchMeta: CapabilityMeta | typeof NO_META_TEARDOWN
  ): void {
    rpcHandlerManager.registerHandler(
      "abort",
      async () => {
        await handlers.onAbort();
      },
      abortMeta
    );

    rpcHandlerManager.registerHandler(
      "switch",
      async () => {
        await handlers.onSwitch();
      },
      switchMeta
    );
  }

  protected clearAbortHandlers(rpcHandlerManager: RpcHandlerManagerLike): void {
    rpcHandlerManager.registerHandler(
      "abort",
      async () => {},
      NO_META_TEARDOWN
    );
    rpcHandlerManager.registerHandler(
      "switch",
      async () => {},
      NO_META_TEARDOWN
    );
  }

  protected async requestExit(
    reason: RemoteLauncherExitReason,
    handler: () => void | Promise<void>
  ): Promise<void> {
    if (!this.exitReason) {
      this.exitReason = reason;
    }
    this.shouldExit = true;
    await handler();
  }

  protected finalizeTerminal(): void {
    restoreTerminalState();
    if (this.hasTTY) {
      try {
        process.stdin.pause();
      } catch {}
    }
    if (this.inkInstance) {
      this.inkInstance.unmount();
    }
    this.messageBuffer.clear();
  }

  protected async start(
    handlers: RemoteLauncherTerminalHandlers
  ): Promise<RemoteLauncherExitReason> {
    this.setupTerminal(handlers);
    try {
      await this.runMainLoop();
    } finally {
      await this.cleanup();
      this.finalizeTerminal();
    }

    return this.exitReason || "exit";
  }
}
