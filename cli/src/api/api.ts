// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import axios from "axios";
import type {
  AgentState,
  CreateMachineResponse,
  CreateSessionResponse,
  DaemonState,
  Machine,
  MachineMetadata,
  Metadata,
  Session,
} from "@/api/types";
import {
  AgentStateSchema,
  CreateMachineResponseSchema,
  CreateSessionResponseSchema,
  DaemonStateSchema,
  MachineMetadataSchema,
  MetadataSchema,
} from "@/api/types";
import { configuration } from "@/configuration";
import { getAuthToken } from "@/api/auth";
import { ApiMachineClient } from "./apiMachine";
import { ApiSessionClient, type ApiSessionClientOptions } from "./apiSession";
import type { AccountCaptureNotice } from "@/accounts/credentialsWatcher";

export class ApiClient {
  static async create(): Promise<ApiClient> {
    return new ApiClient(getAuthToken());
  }

  private constructor(private readonly token: string) {}

  /**
   * Attach to (or create) the session record. `deliveryFloorSeq` is the seq
   * after which this wrapper takes delivery of user messages (#4682), or
   * `null` from an older server that does not send it.
   */
  async getOrCreateSession(opts: {
    tag: string;
    metadata: Metadata;
    state: AgentState | null;
  }): Promise<{ session: Session; deliveryFloorSeq: number | null }> {
    const response = await axios.post<CreateSessionResponse>(
      `${configuration.serverUrl}/cli/sessions`,
      {
        tag: opts.tag,
        metadata: opts.metadata,
        agentState: opts.state,
      },
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        timeout: 60_000,
      }
    );

    const parsed = CreateSessionResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error("Invalid /cli/sessions response");
    }

    const raw = parsed.data.session;

    const metadata = (() => {
      if (raw.metadata == null) return null;
      const parsedMetadata = MetadataSchema.safeParse(raw.metadata);
      return parsedMetadata.success ? parsedMetadata.data : null;
    })();

    const agentState = (() => {
      if (raw.agentState == null) return null;
      const parsedAgentState = AgentStateSchema.safeParse(raw.agentState);
      return parsedAgentState.success ? parsedAgentState.data : null;
    })();

    const session: Session = {
      id: raw.id,
      namespace: raw.namespace,
      seq: raw.seq,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      active: raw.active,
      activeAt: raw.activeAt,
      metadata,
      metadataVersion: raw.metadataVersion,
      agentState,
      agentStateVersion: raw.agentStateVersion,
      thinking: raw.thinking,
      thinkingAt: raw.thinkingAt,
      todos: raw.todos,
      permissionMode: raw.permissionMode,
      modelMode: raw.modelMode,
    };
    return {
      session,
      deliveryFloorSeq: parsed.data.deliveryFloorSeq ?? null,
    };
  }

  async getOrCreateMachine(opts: {
    machineId: string;
    metadata: MachineMetadata;
    daemonState?: DaemonState;
  }): Promise<Machine> {
    const response = await axios.post<CreateMachineResponse>(
      `${configuration.serverUrl}/cli/machines`,
      {
        id: opts.machineId,
        metadata: opts.metadata,
        daemonState: opts.daemonState ?? null,
      },
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        timeout: 60_000,
      }
    );

    const parsed = CreateMachineResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error("Invalid /cli/machines response");
    }

    const raw = parsed.data.machine;

    const metadata = (() => {
      if (raw.metadata == null) return null;
      const parsedMetadata = MachineMetadataSchema.safeParse(raw.metadata);
      return parsedMetadata.success ? parsedMetadata.data : null;
    })();

    const daemonState = (() => {
      if (raw.daemonState == null) return null;
      const parsedDaemonState = DaemonStateSchema.safeParse(raw.daemonState);
      return parsedDaemonState.success ? parsedDaemonState.data : null;
    })();

    return {
      id: raw.id,
      seq: raw.seq,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      active: raw.active,
      activeAt: raw.activeAt,
      metadata,
      metadataVersion: raw.metadataVersion,
      daemonState,
      daemonStateVersion: raw.daemonStateVersion,
    };
  }

  sessionSyncClient(
    session: Session,
    options?: ApiSessionClientOptions
  ): ApiSessionClient {
    return new ApiSessionClient(this.token, session, options);
  }

  machineSyncClient(machine: Machine): ApiMachineClient {
    return new ApiMachineClient(this.token, machine);
  }

  async updateMcpStatus(
    status: import("@hapi/protocol").McpStatusUpdate
  ): Promise<void> {
    await axios.post(`${configuration.serverUrl}/cli/mcp-status`, status, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    });
  }

  /**
   * Issue #6171: per-server MCP RAM (the daemon's sampler) or context cost (a
   * session's turn-end reply) for the New Session picker. Names and numbers
   * only: never argv, environ or a URL.
   */
  async updateMcpCosts(
    update: import("@hapi/protocol/schemas").McpCostsUpdate
  ): Promise<void> {
    await axios.post(`${configuration.serverUrl}/cli/mcp-costs`, update, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    });
  }

  /**
   * Issue #1449: relay a redacted account-capture notice to the server, which
   * broadcasts an account-captured SSE so the web UI updates the account
   * dropdown live. Mirrors updateMcpStatus (daemon-side POST to a /cli route).
   * The notice carries identity ONLY — never a token (R5/R10).
   */
  async reportAccountCaptured(notice: AccountCaptureNotice): Promise<void> {
    await axios.post(
      `${configuration.serverUrl}/cli/account-captured`,
      notice,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      }
    );
  }
}
