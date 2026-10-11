// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL skill-projection compiler — the Agent Plugins 1.0.0 packager (issue #3122,
 * Task 3).
 *
 * Agent Plugins 1.0.0 (released 2026-08-06, spec at
 * github.com/agentplugins/agent-plugins-spec) is the vendor-neutral packaging
 * layer wrapping skills + MCP: a plugin is a FOLDER = a required `plugin.json`
 * manifest + an optional `skills/` dir of Agent Skills + an optional `mcp.json`.
 * It is packaging-only — it does not transform SKILL.md content beyond the
 * degradation annotations this compiler appends (KD3).
 *
 * `toAgentPlugin(plan, skillBody)` produces the deterministic on-disk shape for
 * ONE projected skill: the canonical SKILL.md prose (verbatim) plus a generated
 * "Harness Adaptation" section that carries the projection's FUNCTION — the
 * phases (with gates), the per-capability degradation annotations (R2, never
 * silent), and the invariants. Determinism is load-bearing: the input is
 * SHA-pinned, so the output is stable and the golden test (Task 8) can assert
 * against it offline.
 */
import type { ProjectionPlan } from "./types";

/** One file inside the projected plugin folder (path is plugin-root-relative). */
export interface AgentPluginFile {
  /** POSIX path relative to the plugin root, e.g. `skills/<name>/SKILL.md`. */
  path: string;
  content: string;
}

/** The materialized Agent Plugins 1.0.0 folder for one projected skill. */
export interface AgentPlugin {
  /** The parsed `plugin.json` object (also emitted as a file). */
  pluginJson: Record<string, unknown>;
  /** Every file to write, relative to the plugin root (incl. `plugin.json`). */
  files: AgentPluginFile[];
  /** Whether this plugin declared an `mcp.json` (envelope required `mcp`). */
  hasMcp: boolean;
}

const CAPABILITY_LABEL: Record<string, string> = {
  skills: "skills",
  hooks: "hooks",
  mcp: "mcp",
  instruction_file: "instruction file",
  acp: "acp",
  headless_exec: "headless exec",
  subagents: "subagents",
  session_persistence: "session persistence",
  session_roles: "session roles",
  sandboxing: "sandboxing",
};

const OUTCOME_LABEL: Record<string, string> = {
  native: "native",
  emulated: "emulated",
  omitted: "omitted",
};

/**
 * Build the "Harness Adaptation" section appended to the projected SKILL.md.
 * Deterministic — carries the projection's function (phases / gates /
 * degradation / invariants) sourced entirely from the plan (the envelope), so
 * a projection contains ZERO per-skill hand-written content (R4).
 */
export function buildHarnessAdaptationSection(plan: ProjectionPlan): string {
  const lines: string[] = [];
  lines.push("## Harness Adaptation (HAL projection — do not hand-edit)");
  lines.push("");
  lines.push(
    `Projected for the \`${plan.agentId}\` harness by the Hapimatic skill-projection ` +
      `compiler (issue #3122) from canonical sources (skill_sha \`${plan.skillSha}\`). ` +
      `The prose above is the canonical SKILL.md verbatim; this section is generated ` +
      `from the contract envelope.`
  );
  lines.push("");

  lines.push("### Capability degradation");
  lines.push("");
  lines.push(
    "Every required capability carries an explicit projection outcome — never a silent drop (R2):"
  );
  lines.push("");
  for (const cap of plan.capabilities) {
    const label = CAPABILITY_LABEL[cap.capability] ?? cap.capability;
    const outcome = OUTCOME_LABEL[cap.outcome] ?? cap.outcome;
    lines.push(`- **${label}** — ${outcome}: ${cap.reason}`);
  }
  lines.push("");

  lines.push("### Phases");
  lines.push("");
  if (plan.phases.length === 0) {
    lines.push("_This skill declares no explicit phases._");
  } else {
    plan.phases.forEach((phase, index) => {
      const gate =
        phase.gate === "approval"
          ? " — ⛔ approval gate"
          : phase.gate === "hard-stop"
            ? " — ⛔ hard-stop gate"
            : "";
      lines.push(`${index + 1}. ${phase.name} (\`${phase.id}\`)${gate}`);
    });
  }
  lines.push("");

  lines.push("### Invariants (must hold under projection)");
  lines.push("");
  if (plan.invariants.length === 0) {
    lines.push("_This skill references no registered invariants._");
  } else {
    for (const inv of plan.invariants) {
      lines.push(`- **${inv.id}**${inv.note ? ` — ${inv.note}` : ""}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Produce the projected SKILL.md content: the canonical prose body verbatim,
 * followed by a horizontal rule and the generated Harness Adaptation section.
 */
export function buildProjectedSkillMarkdown(
  plan: ProjectionPlan,
  skillBody: string
): string {
  const body = skillBody.replace(/\s*$/, "");
  return `${body}\n\n---\n\n${buildHarnessAdaptationSection(plan)}`;
}

/**
 * Package a single INCLUDED projection plan (`decision !== "omitted"`) as an
 * Agent Plugins 1.0.0 folder. Throws if handed an omitted plan — the
 * materializer must not materialize an omitted skill.
 *
 * `pluginApiVersion` records the Agent Plugins spec version the output targets;
 * `hapiProjection` is a provenance stamp (skill_sha + per-capability outcomes) so
 * a projected plugin is self-describing without reading the sibling provenance
 * file. An `mcp.json` is emitted iff the skill required the `mcp` capability with
 * a non-omitted outcome (KD3).
 */
export function toAgentPlugin(
  plan: ProjectionPlan,
  skillBody: string
): AgentPlugin {
  if (plan.decision === "omitted") {
    throw new Error(
      `toAgentPlugin: refusing to package an omitted skill "${plan.skill}" (${plan.omittedReason ?? "no reason"})`
    );
  }

  const skillName = plan.skill;
  const mcpDecision = plan.capabilities.find(c => c.capability === "mcp");
  const hasMcp = !!mcpDecision && mcpDecision.outcome !== "omitted";

  const pluginJson: Record<string, unknown> = {
    name: skillName,
    version: "0.1.0",
    description: `HAL projection of the ${skillName} skill for the ${plan.agentId} harness.`,
    pluginApiVersion: "1.0.0",
    skills: [skillName],
    ...(hasMcp ? { mcp: "mcp.json" } : {}),
    hapiProjection: {
      issue: 3122,
      agentId: plan.agentId,
      skillSha: plan.skillSha,
      decision: plan.decision,
      capabilities: plan.capabilities.map(c => ({
        capability: c.capability,
        outcome: c.outcome,
        harnessState: c.harnessState,
      })),
    },
  };

  const files: AgentPluginFile[] = [
    {
      path: "plugin.json",
      content: `${JSON.stringify(pluginJson, null, 2)}\n`,
    },
    {
      path: `skills/${skillName}/SKILL.md`,
      content: buildProjectedSkillMarkdown(plan, skillBody),
    },
  ];

  if (hasMcp) {
    // The MCP config for an injected/emulated harness is a spec-shaped stub —
    // the concrete server-set translation (mcpServers ↔ config.toml ↔ …) is
    // #3125's stage against the KD6 seam. Emitting the well-formed empty shape
    // here keeps the Agent Plugin spec-valid without pre-empting #3125.
    const mcpJson = {
      mcpServers: {} as Record<string, unknown>,
      hapiProjection: {
        note: "MCP server-set translation is deferred to #3125 (a ProjectionStage against the KD6 seam).",
        outcome: mcpDecision?.outcome,
      },
    };
    files.push({
      path: "mcp.json",
      content: `${JSON.stringify(mcpJson, null, 2)}\n`,
    });
  }

  return { pluginJson, files, hasMcp };
}
