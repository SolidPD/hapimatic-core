// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { Bot, Compass, LifeBuoy, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export type SupportAgent = "claude" | "codex" | "gemini" | "opencode";

export const SUPPORT_AGENT_OPTIONS: ReadonlyArray<{
  value: SupportAgent;
  label: string;
}> = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "opencode", label: "OpenCode" },
];

interface HelpMenuProps {
  agent: SupportAgent;
  onAgentChange: (agent: SupportAgent) => void;
  onAskAssistant: () => void;
  onReplayTour: () => void;
  onContactHuman: () => void;
  /** True while the support session is being opened. */
  opening: boolean;
  /** An error from opening the support session, shown under the first action. */
  openError: string | null;
}

function HelpAction(props: {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  children?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
      <Button
        type="button"
        variant="ghost"
        onClick={props.onClick}
        disabled={props.disabled}
        data-testid={props.testId}
        className="flex h-auto min-h-11 w-full items-start justify-start gap-3 p-0 text-left hover:bg-transparent disabled:opacity-50"
      >
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--brand-accent)]" />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-[var(--app-fg)]">
            {props.title}
          </span>
          <span className="whitespace-normal text-sm font-normal text-[var(--app-hint)]">
            {props.description}
          </span>
        </span>
      </Button>
      {props.children}
    </li>
  );
}

/**
 * HelpMenu — the three Help actions (issue #4371 Task 6, R1/R5): the
 * assistant first, the first-run tour, and the human lifeline as the
 * follow-on step. Presentational: the `/settings/help` page owns the actions.
 */
export function HelpMenu(props: HelpMenuProps) {
  return (
    <ul className="flex flex-col gap-3" data-testid="help-menu">
      <HelpAction
        icon={Bot}
        title={props.opening ? "Opening the assistant…" : "Ask the assistant"}
        description="Answers from the Hapimatic guide, and checks your install when you ask. It runs on your own model account."
        onClick={props.onAskAssistant}
        disabled={props.opening}
        testId="help-ask-assistant"
      >
        <label className="flex items-center gap-2 pl-8 text-sm text-[var(--app-hint)]">
          Agent
          <select
            value={props.agent}
            onChange={e => props.onAgentChange(e.target.value as SupportAgent)}
            data-testid="help-agent-select"
            className="min-h-9 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-sm text-[var(--app-fg)]"
          >
            {SUPPORT_AGENT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {props.openError ? (
          <p
            data-testid="help-open-error"
            className="pl-8 text-sm text-[var(--app-hint)]"
          >
            {props.openError}
          </p>
        ) : null}
      </HelpAction>
      <HelpAction
        icon={Compass}
        title="Replay the tour"
        description="The five-card tour of where your sessions live and how to start one."
        onClick={props.onReplayTour}
        testId="help-replay-tour"
      />
      <HelpAction
        icon={LifeBuoy}
        title="Contact a human"
        description="When the assistant cannot help. You see exactly what is sent before anything goes."
        onClick={props.onContactHuman}
        testId="help-contact-human"
      />
    </ul>
  );
}
