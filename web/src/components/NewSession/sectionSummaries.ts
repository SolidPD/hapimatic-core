// SPDX-License-Identifier: AGPL-3.0-only
import type { Machine } from "@/types/api";
import type { LinkedIssue } from "@hapi/protocol/types";
import { getPermissionModeLabel } from "@hapi/protocol/modes";
import type { PermissionMode } from "@hapi/protocol/modes";
import type { AgentType, SessionMode } from "./types";
import {
  getMachineTitle,
  type RemoteNode,
  type SpawnTarget,
} from "./MachineSelector";

/**
 * Per-section colored group-accents for the Create-Session accordion — the
 * LOCKED V1 mock-up palette (`docs/design/create-page/create-page-mockups.html`):
 * Machine = blue, Model = green, GitHub = violet, Session = amber.
 */
export const SECTION_ACCENTS = {
  machine: "var(--accent-blue-400)",
  model: "var(--accent-pink-400)",
  github: "var(--accent-purple-400)",
  session: "var(--accent-amber-400)",
} as const;

/** CLI-harness display labels (the mock-up's "CLI Harness" field values). */
export const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude Code CLI",
  codex: "OpenAI Codex CLI",
  gemini: "Gemini CLI",
  opencode: "OpenCode CLI",
};

/** Slot-meter label for the selected spawn target ("This machine" vs node). */
export function buildMeterTargetLabel(
  spawnTarget: SpawnTarget | null,
  remoteNodes?: RemoteNode[]
): string {
  if (spawnTarget?.kind === "remote") {
    return (
      remoteNodes?.find(n => n.nodeId === spawnTarget.nodeId)?.nodeLabel ??
      "Remote node"
    );
  }
  return "This machine";
}

/**
 * Collapsed-accordion one-line summaries for the Machine / Model / Session
 * sections. Pure derivation extracted from `index.tsx` (Create-page defaults
 * round) to keep the container under the 1,500-line `max-lines` guardrail.
 * (The GitHub summary lives in `GitHubAccountRepoSelector.buildGitHubSummary`
 * so it shares wording with the expanded field.)
 */
export function buildSectionSummaries(args: {
  spawnTarget: SpawnTarget | null;
  machines: Machine[];
  remoteNodes?: RemoteNode[];
  directory: string;
  agent: AgentType;
  launcher: string;
  selectedModel: string;
  linkedIssue: LinkedIssue | null;
  sessionEmoji: string | null;
  sessionName: string;
  permissionMode: PermissionMode;
  safeMode: boolean;
  sessionMode: SessionMode;
}): { machine: string; model: string; session: string } {
  // The actual machine/node NAME — local targets resolve to the machine's
  // display title (displayName → host → id), NOT the generic slot-meter label.
  let machineDisplayName: string | null = null;
  if (args.spawnTarget?.kind === "remote") {
    const t = args.spawnTarget;
    machineDisplayName =
      args.remoteNodes?.find(n => n.nodeId === t.nodeId)?.nodeLabel ?? t.nodeId;
  } else if (args.spawnTarget?.kind === "local") {
    const t = args.spawnTarget;
    const m = args.machines.find(mm => mm.id === t.machineId);
    machineDisplayName = m ? getMachineTitle(m) : t.machineId.slice(0, 8);
  }

  const dir = args.directory.trim();
  const machine =
    !args.spawnTarget || !machineDisplayName
      ? "No machine selected"
      : dir
        ? `${machineDisplayName} · ${dir}`
        : machineDisplayName;

  const model = [
    HARNESS_LABELS[args.agent] ?? args.agent,
    args.launcher,
    args.selectedModel || "default model",
  ].join(" · ");

  const parts: string[] = [];
  if (args.linkedIssue) parts.push(`#${args.linkedIssue.number}`);
  const name =
    `${args.sessionEmoji ? `${args.sessionEmoji} ` : ""}${args.sessionName.trim()}`.trim();
  if (name) parts.push(name);
  parts.push(getPermissionModeLabel(args.permissionMode));
  if (args.safeMode) parts.push("Safe");
  if (args.sessionMode === "scheduled") parts.push("Scheduled");
  const session = parts.join(" · ") || "New session";

  return { machine, model, session };
}
