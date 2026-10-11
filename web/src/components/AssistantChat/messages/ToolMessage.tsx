// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { ChatBlock } from "@/chat/types";
import type { ToolCallBlock } from "@/chat/types";
import { getEventPresentation, resolveSectionHints } from "@/chat/presentation";
import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/CodeBlock";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { LazyRainbowText } from "@/components/LazyRainbowText";
import { MessageStatusIndicator } from "@/components/AssistantChat/messages/MessageStatusIndicator";
import { ToolCard } from "@/components/ToolCard/ToolCard";
import { showsPermissionFooter } from "@/components/ToolCard/showsPermissionFooter";
import { getToolIcon } from "@/components/ToolCard/knownTools";
import { useHappyChatContext } from "@/components/AssistantChat/context";
import { useMessageDetailOverride } from "@/components/AssistantChat/messages/HiddenToolSummary";
import { CompactChevron } from "@/components/AssistantChat/messages/CompactChevron";
import { CliOutputBlock } from "@/components/CliOutputBlock";
import {
  extractImagesFromResult,
  collectImagesDeep,
  renderHoistedImages,
} from "@/components/AssistantChat/messages/toolImages";
import {
  ApiKeyRegistrationCard,
  type ConversationalDescriptor,
} from "@/components/ApiKeyRegistrationCard";
import { Button } from "@/components/ui/button";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

// B4 (#1957): conversational API-key registration. The web detects the
// `register_service_key` tool call by name (mirroring `isChangeTitleToolName`)
// and reads the NON-SECRET descriptor from the tool INPUT — the secret is NEVER
// part of the tool call. ToolMessage renders <ApiKeyRegistrationCard> for the
// secure secret entry, so the raw key never enters the conversation.
function isRegisterServiceKeyToolName(name: string): boolean {
  return (
    name === "mcp__hapi__register_service_key" ||
    name === "hapi__register_service_key"
  );
}

function extractRegisterDescriptor(
  block: ToolCallBlock
): ConversationalDescriptor | null {
  if (!isRegisterServiceKeyToolName(block.tool.name)) return null;
  const input = block.tool.input;
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  const provider = rec.provider;
  if (typeof provider !== "string" || provider.trim().length === 0) return null;
  const out: ConversationalDescriptor = {
    provider: provider.trim().toLowerCase(),
  };
  if (typeof rec.label === "string" && rec.label.trim())
    out.label = rec.label.trim();
  if (typeof rec.baseUrl === "string" && rec.baseUrl.trim())
    out.baseUrl = rec.baseUrl.trim();
  if (typeof rec.model === "string" && rec.model.trim())
    out.model = rec.model.trim();
  return out;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const stringified = JSON.stringify(value, null, 2);
    return typeof stringified === "string" ? stringified : String(value);
  } catch {
    return String(value);
  }
}

export function isToolCallBlock(value: unknown): value is ToolCallBlock {
  if (!isObject(value)) return false;
  if (value.kind !== "tool-call") return false;
  if (typeof value.id !== "string") return false;
  if (value.localId !== null && typeof value.localId !== "string") return false;
  if (typeof value.createdAt !== "number") return false;
  if (!Array.isArray(value.children)) return false;
  if (!isObject(value.tool)) return false;
  if (typeof value.tool.name !== "string") return false;
  if (!("input" in value.tool)) return false;
  if (
    value.tool.description !== null &&
    typeof value.tool.description !== "string"
  )
    return false;
  if (
    value.tool.state !== "pending" &&
    value.tool.state !== "running" &&
    value.tool.state !== "completed" &&
    value.tool.state !== "error"
  )
    return false;
  return true;
}

function isPendingPermissionBlock(block: ChatBlock): boolean {
  return (
    block.kind === "tool-call" && block.tool.permission?.status === "pending"
  );
}

function splitTaskChildren(block: ToolCallBlock): {
  pending: ChatBlock[];
  rest: ChatBlock[];
} {
  const pending: ChatBlock[] = [];
  const rest: ChatBlock[] = [];

  for (const child of block.children) {
    if (isPendingPermissionBlock(child)) {
      pending.push(child);
    } else {
      rest.push(child);
    }
  }

  return { pending, rest };
}

/**
 * Safety floor (#2625, R4 / rulings D2 + 1B): a tool block must ALWAYS render —
 * exempt from the `compact`/`output-only` hide at every detail level — when it
 * carries an actionable or explanatory permission footer, or an errored result,
 * on the block ITSELF or any descendant in `block.children`.
 *
 * The permission test delegates to `showsPermissionFooter`
 * (`ToolCard/showsPermissionFooter.ts`; byte-parity origin was `ToolCard.tsx:435`):
 * `pending`, OR (`denied`/`canceled` WITH a reason). The recursion is
 * load-bearing: `splitTaskChildren` exists precisely because a Task's child
 * sub-tools carry their own pending permission prompts — a Task whose own
 * permission is granted but whose child is still pending must NOT be hidden, or
 * the prompt would be unreachable and the session would stall. Hiding is
 * presentation-only; the `ChatBlock[]` is never filtered.
 */
export function mustAlwaysRender(block: ChatBlock): boolean {
  if (block.kind !== "tool-call") return false;
  if (showsPermissionFooter(block)) return true;
  if (block.tool.state === "error") return true;
  return block.children.some(child => mustAlwaysRender(child));
}

/**
 * Permission-only floor (#3015): a group must force itself open + lock its
 * collapse toggle when a member carries an ACTIONABLE/EXPLANATORY permission
 * footer — pending, OR denied/canceled WITH a reason — on the block itself or
 * any descendant. Delegates to `showsPermissionFooter`
 * (`ToolCard/showsPermissionFooter.ts`; byte-parity origin was `ToolCard.tsx:435`).
 * Unlike `mustAlwaysRender` this EXCLUDES `state === "error"`: a completed error is
 * informational, not an actionable prompt, so it must not bury the group.
 */
export function hasPermissionFloor(block: ChatBlock): boolean {
  if (block.kind !== "tool-call") return false;
  if (showsPermissionFooter(block)) return true;
  return block.children.some(child => hasPermissionFloor(child));
}

// #2989 (S2, coordination b2): re-exported so existing `from "…/ToolMessage"`
// importers keep working. The definition moved to its own pure module
// (`CompactChevron.tsx`) so an incomplete `ToolMessage` mock can't poison it
// under the web suite's `isolate: false` shared registry (a CI-only failure).
// `ToolMessage` itself uses it in `CompactToolRow` below.
export { CompactChevron };

/**
 * `compact` single-line collapsed tool row (#2625, R2). A tap expands to the
 * full tool body. Reused by both `HappyToolMessage` (message path) and
 * `HappyNestedBlockList` (nested Task children). The full `<ToolCard>` (passed as
 * `children`) is only mounted while open, so a collapsed row is cheap.
 */
function CompactToolRow(props: {
  toolName: string;
  state: string;
  /** Per-tool icon (#2991, S4/R4) — the same icon the full ToolCard renders. */
  icon?: ReactNode;
  /**
   * #3003 F1: ghost a lone `hidden` tool at 70% opacity so it renders
   * consistently with a hidden multi-tool run (ToolRunGroup applies the same
   * `opacity-70` to its `CollapsibleSectionRow`). The row still starts closed and
   * expands to the full card on tap — a reveal, NOT the nested path's `return null`
   * total hide.
   */
  ghost?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("min-w-0 max-w-full", props.ghost && "opacity-70")}>
      {/* #3268 (operator pick S-a): px-0 (was px-2) so the tool-row chevron joins
          the shared 8px chevron column that round 14 set for the tool-group
          header, System, reasoning and narration rows. */}
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="flex h-auto w-full items-center justify-start gap-2 rounded px-0 py-1 text-left text-xs font-normal text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
      >
        <CompactChevron open={open} />
        {props.icon ? (
          <span className="shrink-0 text-[var(--app-hint)]" aria-hidden="true">
            {props.icon}
          </span>
        ) : null}
        <span className="min-w-0 truncate font-mono">{props.toolName}</span>
        <span className="ml-auto shrink-0 opacity-70">{props.state}</span>
      </Button>
      {open ? <div className="mt-1">{props.children}</div> : null}
    </div>
  );
}

function HappyNestedBlockList(props: { blocks: ChatBlock[] }) {
  const ctx = useHappyChatContext();
  // Detail gate for NESTED children (#2625, ruling D1): `HappyNestedBlockList`
  // keeps its own `output-only`/`compact` gate. When the message-layer reveal
  // affordance is open (override mode `full`), the effective level is `full` for the whole
  // revealed subtree.
  const { mode } = useMessageDetailOverride();
  const hints = resolveSectionHints(mode, ctx.chatSections);

  return (
    <div className="flex flex-col gap-3">
      {props.blocks.map(block => {
        if (block.kind === "user-text") {
          const userBubbleClass =
            "w-fit max-w-[92%] ml-auto rounded-xl bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)] shadow-sm";
          const status = block.status;
          const canRetry =
            status === "failed" &&
            typeof block.localId === "string" &&
            Boolean(ctx.onRetryMessage);
          const onRetry = canRetry
            ? () => ctx.onRetryMessage!(block.localId!)
            : undefined;

          return (
            <div key={`user:${block.id}`} className={userBubbleClass}>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <LazyRainbowText text={block.text} />
                </div>
                {status ? (
                  <div className="shrink-0 self-end pb-0.5">
                    <MessageStatusIndicator status={status} onRetry={onRetry} />
                  </div>
                ) : null}
              </div>
            </div>
          );
        }

        if (block.kind === "agent-text") {
          return (
            <div key={`agent:${block.id}`} className="px-1">
              <MarkdownRenderer content={block.text} />
            </div>
          );
        }

        if (block.kind === "cli-output") {
          const alignClass =
            block.source === "user" ? "ml-auto w-full max-w-[92%]" : "";
          return (
            <div
              key={`cli:${block.id}`}
              className="px-1 min-w-0 max-w-full overflow-x-hidden"
            >
              <div className={alignClass}>
                <CliOutputBlock text={block.text} />
              </div>
            </div>
          );
        }

        if (block.kind === "agent-event") {
          const presentation = getEventPresentation(block.event);
          return (
            <div key={`event:${block.id}`} className="py-1">
              <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                <span className="inline-flex items-center gap-1">
                  {presentation.icon ? (
                    <span aria-hidden="true">{presentation.icon}</span>
                  ) : null}
                  <span>{presentation.text}</span>
                </span>
              </div>
            </div>
          );
        }

        if (block.kind === "tool-call") {
          // Detail gate (#2625): in `output-only` hide a non-safety-floor nested
          // tool entirely (presentation-only — the block is NOT filtered); in
          // `compact` collapse it to a single expandable row. `mustAlwaysRender`
          // (recursive) keeps any pending/errored descendant always visible.
          const forceFull = mustAlwaysRender(block);
          // #3269: a `hidden` nested tool UNMOUNTS its body (and children), so it
          // cannot render its own image. Surface any image it OR a descendant carries
          // via a deep collect (finding 3269-4) so a folded parent never buries a
          // screenshot (R2). Guarded so a non-image hidden tool renders literally
          // nothing — an unguarded `py-1` wrapper would be a phantom in-flow flex
          // item (finding 3269-3, R3). Hoisted above the early return so the render
          // here has the variable it references.
          if (hints.toolCards === "hidden" && !forceFull) {
            const hiddenImages = collectImagesDeep(block);
            return hiddenImages.length ? (
              <div key={`tool:${block.id}`} className="py-1">
                {renderHoistedImages(hiddenImages)}
              </div>
            ) : null;
          }
          const isTask = block.tool.name === "Task";
          const taskChildren = isTask ? splitTaskChildren(block) : null;
          // #3269: this tool's OWN hoisted image renders as an always-visible sibling
          // of the collapsible row (below), NOT inside toolBody — so a compact or
          // collapsed row still shows it (R1). OWN images only: a mounted child
          // renders its own image, so a deep collect here would double-render it (V4).
          const hoistedImages = extractImagesFromResult(block.tool.result);
          const registerDescriptor = extractRegisterDescriptor(block);

          const toolBody = (
            <>
              <ToolCard
                api={ctx.api}
                sessionId={ctx.sessionId}
                metadata={ctx.metadata}
                disabled={ctx.disabled}
                onDone={ctx.onRefresh}
                block={block}
              />
              {registerDescriptor ? (
                <ApiKeyRegistrationCard
                  api={ctx.api}
                  descriptor={registerDescriptor}
                />
              ) : null}
              {block.children.length > 0 ? (
                isTask ? (
                  <>
                    {taskChildren && taskChildren.pending.length > 0 ? (
                      <div className="mt-2 pl-3">
                        <HappyNestedBlockList blocks={taskChildren.pending} />
                      </div>
                    ) : null}
                    {taskChildren && taskChildren.rest.length > 0 ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                          Task details ({taskChildren.rest.length})
                        </summary>
                        <div className="mt-2 pl-3">
                          <HappyNestedBlockList blocks={taskChildren.rest} />
                        </div>
                      </details>
                    ) : null}
                  </>
                ) : (
                  <div className="mt-2 pl-3">
                    <HappyNestedBlockList blocks={block.children} />
                  </div>
                )
              ) : null}
            </>
          );

          const useCompact = hints.toolCards === "compact" && !forceFull;

          return (
            <div key={`tool:${block.id}`} className="py-1">
              {useCompact ? (
                <CompactToolRow
                  toolName={block.tool.name}
                  state={block.tool.state}
                  icon={getToolIcon(block.tool.name, ctx.metadata)}
                >
                  {toolBody}
                </CompactToolRow>
              ) : (
                toolBody
              )}
              {renderHoistedImages(hoistedImages)}
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

export function HappyToolMessage(props: ToolCallMessagePartProps) {
  const ctx = useHappyChatContext();
  // Detail gate (#2625, ruling D1): on the MESSAGE path, `HappyToolMessage` NEVER
  // hides — the `output-only` hide + reveal affordance is owned by the
  // message-layer wrapper (HiddenToolSummary). Here we only apply the `compact`
  // single-row collapse. When the reveal affordance is open (override mode `full`), the
  // effective level is `full` for this subtree. `compact` gating exempts a
  // safety-floor tool (pending/errored permission or error) so a prompt is never
  // buried behind a collapsed row.
  const { mode } = useMessageDetailOverride();
  const hints = resolveSectionHints(mode, ctx.chatSections);
  const artifact = props.artifact;

  if (!isToolCallBlock(artifact)) {
    const argsText =
      typeof props.argsText === "string" ? props.argsText.trim() : "";
    const hasArgsText = argsText.length > 0;
    const hasResult = props.result !== undefined;
    const resultText = hasResult ? safeStringify(props.result) : "";

    const fallbackBody = (
      <div className="rounded-xl bg-[var(--app-secondary-bg)] p-3 shadow-sm">
        <div className="flex items-center gap-2 text-xs">
          <div className="font-mono text-[var(--app-hint)]">
            Tool: {props.toolName}
          </div>
          {props.isError ? <span className="text-red-500">Error</span> : null}
          {props.status.type === "running" && !hasResult ? (
            <span className="text-[var(--app-hint)]">Running…</span>
          ) : null}
        </div>

        {hasArgsText ? (
          <div className="mt-2">
            <CodeBlock code={argsText} language="json" />
          </div>
        ) : null}

        {hasResult ? (
          <div className="mt-2">
            <CodeBlock
              code={resultText}
              language={typeof props.result === "string" ? "text" : "json"}
            />
          </div>
        ) : null}
      </div>
    );

    // `compact` collapses the fallback box to a single row too, so it cannot leak
    // a raw tool box; an errored fallback (`props.isError`) always renders full
    // (safety floor — the non-block path has no `permission`/`children` to walk).
    const useCompact = hints.toolCards === "compact" && !props.isError;

    return (
      <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
        {useCompact ? (
          <CompactToolRow
            toolName={props.toolName}
            state={props.status?.type ?? "tool"}
            icon={getToolIcon(props.toolName, ctx.metadata)}
          >
            {fallbackBody}
          </CompactToolRow>
        ) : (
          fallbackBody
        )}
      </div>
    );
  }

  const block = artifact;
  const isTask = block.tool.name === "Task";
  const taskChildren = isTask ? splitTaskChildren(block) : null;
  // #3269: OWN hoisted image renders as an always-visible sibling below (not inside
  // toolBody) so a compact or `hidden`-ghosted row still shows it (R1). OWN images
  // only: a mounted child renders its own image, so a deep collect here would
  // double-render it (V4). The message-level output-only hide is handled separately
  // by OutputOnlyToolPart (AssistantMessage.tsx), so region B never needs a deep collect.
  const hoistedImages = extractImagesFromResult(block.tool.result);
  const registerDescriptor = extractRegisterDescriptor(block);

  const toolBody = (
    <>
      <ToolCard
        api={ctx.api}
        sessionId={ctx.sessionId}
        metadata={ctx.metadata}
        disabled={ctx.disabled}
        onDone={ctx.onRefresh}
        block={block}
      />
      {registerDescriptor ? (
        <ApiKeyRegistrationCard api={ctx.api} descriptor={registerDescriptor} />
      ) : null}
      {block.children.length > 0 ? (
        isTask ? (
          <>
            {taskChildren && taskChildren.pending.length > 0 ? (
              <div className="mt-2 pl-3">
                <HappyNestedBlockList blocks={taskChildren.pending} />
              </div>
            ) : null}
            {taskChildren && taskChildren.rest.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                  Task details ({taskChildren.rest.length})
                </summary>
                <div className="mt-2 pl-3">
                  <HappyNestedBlockList blocks={taskChildren.rest} />
                </div>
              </details>
            ) : null}
          </>
        ) : (
          <div className="mt-2 pl-3">
            <HappyNestedBlockList blocks={block.children} />
          </div>
        )
      ) : null}
    </>
  );

  // `compact` collapses the card to a single expandable row; `hidden` (#3003 F1)
  // collapses it to the SAME row but GHOSTED (opacity-70) so a lone hidden tool
  // renders consistently with a hidden multi-tool run (ToolRunGroup's opacity-70
  // CollapsibleSectionRow) instead of a full card — a reveal, NOT the nested
  // path's `return null` total hide. A safety-floor tool (pending/errored
  // permission or an errored descendant) stays full in both.
  const forceFull = mustAlwaysRender(block);
  const useCompact = hints.toolCards === "compact" && !forceFull;
  const useHidden = hints.toolCards === "hidden" && !forceFull;

  return (
    <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
      {useCompact || useHidden ? (
        <CompactToolRow
          toolName={block.tool.name}
          state={block.tool.state}
          icon={getToolIcon(block.tool.name, ctx.metadata)}
          ghost={useHidden}
        >
          {toolBody}
        </CompactToolRow>
      ) : (
        toolBody
      )}
      {renderHoistedImages(hoistedImages)}
    </div>
  );
}
