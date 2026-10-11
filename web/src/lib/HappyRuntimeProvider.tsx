// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { useExternalStoreRuntime } from "@assistant-ui/react";
import {
  TurnDurationsContext,
  TurnStatusTextsContext,
  TurnTokensContext,
  TurnWorkflowContext,
  type TurnTokens,
  type WorkflowChip,
} from "@/lib/assistant-runtime";

/**
 * Wrapper that provides the AssistantRuntimeProvider, TurnDurationsContext
 * for bake-time display, TurnStatusTextsContext for background task status, and
 * TurnTokensContext for per-turn token + API-value footer display (issue #1671).
 */
export function HappyRuntimeProvider(props: {
  runtime: ReturnType<typeof useExternalStoreRuntime>;
  turnDurations: Map<string, number>;
  turnStatusTexts: Map<string, string>;
  turnTokens: Map<string, TurnTokens>;
  turnWorkflow: Map<string, WorkflowChip[]>;
  children: ReactNode;
}) {
  return (
    <TurnDurationsContext value={props.turnDurations}>
      <TurnStatusTextsContext value={props.turnStatusTexts}>
        <TurnTokensContext value={props.turnTokens}>
          <TurnWorkflowContext value={props.turnWorkflow}>
            <AssistantRuntimeProvider runtime={props.runtime}>
              {props.children}
            </AssistantRuntimeProvider>
          </TurnWorkflowContext>
        </TurnTokensContext>
      </TurnStatusTextsContext>
    </TurnDurationsContext>
  );
}
