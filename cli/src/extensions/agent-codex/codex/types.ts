// SPDX-License-Identifier: MIT
/**
 * Type definitions for Codex MCP integration
 */

export interface CodexSessionConfig {
  prompt: string;
  "approval-policy"?: "untrusted" | "on-request" | "never";
  "base-instructions"?: string;
  config?: Record<string, unknown>;
  cwd?: string;
  "include-plan-tool"?: boolean;
  model?: string;
  profile?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface CodexToolResponse {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: unknown;
    mimeType?: string;
  }>;
  isError?: boolean;
}
