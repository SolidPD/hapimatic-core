// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect, type ReactElement } from "react";
import {
  ShieldCheck,
  Check,
  X,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import { useMessage } from "@assistant-ui/react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import {
  APPROVAL_TOKEN_HOOK_ID,
  resolveDenialOutcome,
  type GateDenialOutcome,
} from "@hapi/protocol";
import { SyntaxHighlighter } from "@/components/assistant-ui/shiki-highlighter";
import { useHappyChatContext } from "@/components/AssistantChat/context";
import { useSendMessage } from "@/hooks/mutations/useSendMessage";
import { useMessages } from "@/hooks/queries/useMessages";
import { useApprovalState } from "@/hooks/queries/useApprovalState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * QuickReplies — the generic structured-block "suggested replies" primitive and
 * its first consumer, the approval card (issue #3333, epic #3329).
 *
 * The agent emits a fixed heading (prose) + a fenced code block tagged
 * `hapi_quick_replies` whose body is a JSON {@link QuickRepliesSpec}. The client
 * detects that fence in the assistant TEXT render chain (via `componentsByLanguage`,
 * wired in `markdown-text.tsx`) and hoists it into tappable buttons. A tap sends its
 * exact payload as an ORDINARY user message via the normal `useSendMessage` →
 * `POST /sessions/:id/messages` path — the button is sugar over the protocol, never a
 * second approval path (R4). When the rich renderer is unavailable (CLI, Telegram
 * relay, foreign harness) the same block renders as plain text (heading + fenced
 * token) and stays fully operable.
 *
 * The approval variant renders as the "C2 — compact strip with chips" design + the
 * "D1 — Decline prefills the composer" flow (operator design decision, #3333):
 * inline flow content (the composer is never disabled or covered), a collapsed
 * one-line strip that expands on tap, and a status chip once a later message exists
 * or the challenge is acted on.
 */

/**
 * The wire fence tag. It MUST use underscores, NOT hyphens: assistant-ui extracts a
 * fence's language via `/language-(\w+)/` and `\w` excludes `-`, so a hyphenated tag
 * (`hapi-quick-replies`) would silently truncate to `hapi` and never route here.
 * Co-owned with the agent-emission side (rp1-home#1749).
 */
export const QUICK_REPLIES_FENCE_LANGUAGE = "hapi_quick_replies";

/**
 * The grant-minting token prefix. RedTeam-D invariant: only the `approval` variant's
 * Approve button may carry one — a `menu` entry NEVER may.
 */
const APPROVAL_TOKEN_PREFIX = "USER-APPROVAL-";

/**
 * D1: the composer prefill for a Decline. A decline is a PLAIN user message —
 * nothing is minted, no nonce is involved; the pending challenge stays until the
 * agent re-mints or drops it (registry trust model unchanged). The trailing space
 * leaves the caret ready for the reason.
 */
const DECLINE_PREFILL = "Not approved — ";
/** A user message counts as this card's decline if sent at/after the tap (slack for clock skew). */
const DECLINE_MATCH_TOLERANCE_MS = 2000;

/**
 * Shared pill-chip base sizing for every interactive chip (Approve / Decline / the
 * receded status chip). `min-h-11` is the 44px minimum touch target — kept in ONE
 * place so the a11y floor cannot drift between chips.
 */
const CHIP_CLASS = "min-h-11 rounded-full px-3 text-xs";

export type ApprovalState =
  | "pending"
  | "consumed"
  | "used"
  | "invalidated"
  | "awaiting-overlap-decision";

/** The card's effective presentation status (send-state + the local decline signal). */
type EffectiveStatus =
  | "pending"
  | "consumed"
  | "used"
  | "invalidated"
  | "awaiting-overlap-decision"
  | "declined";

export interface QuickReplyEntry {
  label: string;
  /** The exact text sent as a user message when this entry is tapped. */
  payload: string;
}

export interface MenuSpec {
  variant: "menu";
  summary?: string;
  entries: QuickReplyEntry[];
}

export interface ApprovalSpec {
  variant: "approval";
  summary: string;
  /** The `USER-APPROVAL-` token the Approve button sends as its payload. */
  token: string;
  challengeId?: string;
  /** Server-declared initial state; defaults to `pending`. */
  state?: ApprovalState;
}

export type QuickRepliesSpec = MenuSpec | ApprovalSpec;

const APPROVAL_STATES: ReadonlySet<string> = new Set<ApprovalState>([
  "pending",
  "consumed",
  "used",
  "invalidated",
  "awaiting-overlap-decision",
]);

function isApprovalState(value: unknown): value is ApprovalState {
  return typeof value === "string" && APPROVAL_STATES.has(value);
}

function containsApprovalToken(text: string): boolean {
  return text.includes(APPROVAL_TOKEN_PREFIX);
}

/**
 * Parse the JSON body of a `hapi_quick_replies` fence into a validated spec.
 *
 * Returns `null` for anything that is not a complete, valid spec — INCLUDING a
 * truncated / mid-stream JSON payload (3333-7): the block then renders as an
 * ordinary code fence and never throws.
 *
 * RedTeam-D (Task 5): a `menu` entry may NEVER carry a grant-minting token. Any such
 * entry is stripped here — the parser is the single choke point every render path
 * shares, so a token can never reach a tappable menu button.
 */
export function parseQuickRepliesBlock(code: string): QuickRepliesSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return null; // streaming / invalid → plain fence (R4, 3333-7)
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (obj.variant === "approval") {
    if (typeof obj.token !== "string" || obj.token.length === 0) return null;
    if (typeof obj.summary !== "string") return null;
    return {
      variant: "approval",
      summary: obj.summary,
      token: obj.token,
      challengeId:
        typeof obj.challengeId === "string" ? obj.challengeId : undefined,
      state: isApprovalState(obj.state) ? obj.state : undefined,
    };
  }

  if (obj.variant === "menu") {
    if (!Array.isArray(obj.entries)) return null;
    const entries: QuickReplyEntry[] = [];
    for (const candidate of obj.entries) {
      if (!candidate || typeof candidate !== "object") continue;
      const entry = candidate as Record<string, unknown>;
      const { label, payload } = entry;
      if (typeof label !== "string" || typeof payload !== "string") continue;
      // RedTeam-D: drop any menu entry whose payload embeds a live token.
      if (containsApprovalToken(payload)) continue;
      entries.push({ label, payload });
    }
    if (entries.length === 0) return null;
    return {
      variant: "menu",
      summary: typeof obj.summary === "string" ? obj.summary : undefined,
      entries,
    };
  }

  return null; // unknown variant
}

/** The short receded-chip label + tone for each effective status. */
function statusChipMeta(status: EffectiveStatus): {
  label: string;
  tone: "accent" | "destructive" | "muted";
} {
  switch (status) {
    case "consumed":
      // #3559 R6: grant on disk, gate not yet run — "approved, awaiting the agent"
      // (relabelled from "Approved" so adding `used` below is not misleading).
      return { label: "Approved · waiting for the agent", tone: "accent" };
    case "used":
      // #3559 R6: the gate consumed the grant — the approval was applied.
      return { label: "Used", tone: "accent" };
    case "declined":
      return { label: "Declined", tone: "destructive" };
    case "invalidated":
      return { label: "Invalidated", tone: "destructive" };
    case "awaiting-overlap-decision":
      return { label: "Overlap review", tone: "muted" };
    default:
      return { label: "Pending", tone: "muted" };
  }
}

/**
 * Extract the text of a user message from the transcript (optimistic bubbles carry
 * `content: { role, content }`; server messages may only carry `originalText`).
 */
function userMessageText(
  content: unknown,
  originalText: string | undefined
): {
  isUser: boolean;
  text: string;
} {
  const c = content as { role?: string; content?: unknown } | undefined;
  const isUser = c?.role === "user";
  const text =
    typeof c?.content === "string" ? c.content : (originalText ?? "");
  return { isUser, text };
}

/**
 * The approval-card variant — a compact strip (collapsed one-line → expanded) with
 * Decline + Approve chips, receding to a status chip once a later message exists or
 * the challenge is acted on.
 *
 * Denial awareness (3333-1, security-critical): the tap's outcome is read from the
 * send RESPONSE, not assumed. A server denial (HTTP 200 `{ok:false, denied}`) reaches
 * an explicit `invalidated` state carrying the reason — never a false `consumed`.
 *
 * Decline (D1): tapping Decline sends NOTHING — it prefills the composer with
 * "Not approved — " (when the draft is empty) and focuses it. The card marks itself
 * declined once the user actually sends a "Not approved…" message.
 */
function ApprovalCard({ spec }: { spec: ApprovalSpec }): ReactElement {
  const { api, sessionId, disabled, prefillComposer } = useHappyChatContext();
  const { sendMessage, isSending, sendResult, sendError } = useSendMessage(
    api,
    sessionId
  );
  const { messages } = useMessages(api, sessionId);
  // A later message exists when this assistant message is no longer the last in the
  // thread (reactive — flips when any message arrives after the card). `optional`
  // guards the deep-nested render position (the card is inside MarkdownText): it
  // returns null outside a message context (e.g. a standalone/test render).
  const isLast = useMessage({ optional: true })?.isLast ?? null;

  // #3559 R6: the server-driven gate state (poll). DISABLED for a non-integer
  // challengeId (both routes 400) — then `serverState` is undefined and the card
  // falls back to the tap-response behaviour below (pre-#3559 shape).
  const { state: serverState } = useApprovalState(
    api,
    sessionId,
    spec.challengeId,
    spec.token
  );
  // Hold the last MEANINGFUL server state across a `none` read: the gate can run to
  // completion (grant minted → consumed → deleted) between polls, and a bare `none`
  // must NOT snap the card back to Pending (#3559 R6). `none` never overwrites a
  // prior consumed/used/… .
  const [lastServerState, setLastServerState] = useState<ApprovalState | null>(
    null
  );
  useEffect(() => {
    if (serverState && serverState !== "none") setLastServerState(serverState);
  }, [serverState]);
  const effectiveServer: ApprovalState | null =
    serverState && serverState !== "none" ? serverState : lastServerState;

  const [tapped, setTapped] = useState(false); // Approve tapped (latched)
  const [armedAt, setArmedAt] = useState<number | null>(null); // Decline tap time
  const [expanded, setExpanded] = useState(false); // strip collapsed↔expanded
  const [reOpened, setReOpened] = useState(false); // re-opened a receded pending chip

  // The tap-path denial outcome (3333-1). Prefer the server-resolved `outcome` on
  // the response (resolution is server-side — the web never re-resolves); fall back
  // to a client-side `resolveDenialOutcome` defensively. Either way the copy comes
  // from the #3579 catalogue (jargon-free, V10) — the old hardcoded
  // `approvalDeniedCopy` switch is gone.
  const deniedOutcome: GateDenialOutcome | null =
    sendResult && !sendResult.ok
      ? (sendResult.denied?.outcome ??
        resolveDenialOutcome(
          APPROVAL_TOKEN_HOOK_ID,
          sendResult.denied?.reason ?? "denied",
          sendResult.denied?.params ?? {}
        ))
      : null;

  // #3559 R6: the server poll is the authoritative state SOURCE; the tap response
  // is the IMMEDIATE signal until the first poll lands (the recede/re-open logic
  // below is unchanged). A network error or a server denial on the tap is
  // definitive (`invalidated`) and won't be contradicted by the poll. On a
  // successful tap, prefer the server's POST-approval state (consumed → used →
  // invalidated) once it lands, ignoring a stale `pending` from before the tap so
  // the card never flickers back to actionable.
  const sendState: ApprovalState = sendError
    ? "invalidated"
    : sendResult && !sendResult.ok
      ? "invalidated"
      : sendResult && sendResult.ok
        ? effectiveServer === "consumed" ||
          effectiveServer === "used" ||
          effectiveServer === "invalidated"
          ? effectiveServer
          : "consumed"
        : (effectiveServer ?? spec.state ?? "pending");

  // D1 decline detection: a user "Not approved…" message sent at/after this card's
  // Decline tap. The armedAt timestamp scopes it to THIS card's decline action, so a
  // coincidental "Not approved" for a different card never marks this one declined.
  const declined =
    armedAt != null &&
    messages.some(m => {
      const { isUser, text } = userMessageText(m.content, m.originalText);
      if (!isUser) return false;
      if (m.createdAt < armedAt - DECLINE_MATCH_TOLERANCE_MS) return false;
      return text.trim().toLowerCase().startsWith("not approved");
    });

  const status: EffectiveStatus = declined ? "declined" : sendState;
  const isActionable = status === "pending";
  const laterExists = isLast === false;
  const acted = tapped || sendResult != null || sendError != null || declined;

  // Recede to a compact status chip once acted on, or once a later message exists —
  // unless the user re-opened a still-pending challenge (the challenge stays open).
  const asChip = !isActionable || (laterExists && !reOpened);

  const approveDisabled = disabled || isSending || acted || !isActionable;

  const onApprove = (): void => {
    if (approveDisabled) return;
    setTapped(true);
    sendMessage(spec.token);
  };
  const onDecline = (): void => {
    if (disabled || acted) return;
    // D1: prefill + focus the composer WITHOUT sending. Runs synchronously in the
    // tap so mobile Safari opens the keyboard.
    prefillComposer?.(DECLINE_PREFILL);
    setArmedAt(Date.now());
  };

  // ── Receded status chip ──────────────────────────────────────────────────────
  if (asChip) {
    const { label, tone } = statusChipMeta(status);
    const reopenable = isActionable; // a still-pending receded chip re-opens
    const expandable = status === "invalidated"; // show the denial reason on expand
    const toneClass =
      tone === "accent"
        ? "text-[var(--app-link)]"
        : tone === "destructive"
          ? "text-destructive"
          : "text-[var(--app-hint)]";
    const Icon =
      status === "consumed" || status === "used"
        ? Check
        : status === "declined" || status === "invalidated"
          ? X
          : ShieldCheck;
    return (
      <div
        className="my-2"
        data-testid="quick-replies-approval-card"
        data-state={status}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!reopenable && !expandable}
          aria-expanded={expandable ? expanded : undefined}
          aria-label={
            reopenable
              ? "Re-open approval request"
              : `Approval ${label.toLowerCase()}`
          }
          onClick={() => {
            if (reopenable) setReOpened(true);
            else if (expandable) setExpanded(e => !e);
          }}
          className={cn(
            CHIP_CLASS,
            "flex max-w-full items-center gap-1.5 font-medium",
            "border border-[var(--app-border)] bg-[var(--app-secondary-bg)]",
            toneClass
          )}
        >
          <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span className="flex-shrink-0">{label}</span>
          <span className="text-[var(--app-hint)]" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 truncate text-[var(--app-fg)]">
            {spec.summary}
          </span>
        </Button>
        {expandable && expanded && deniedOutcome ? (
          <div className="mt-1 flex items-start gap-1.5 px-1 text-xs break-words text-destructive">
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
              aria-hidden="true"
            />
            <span>{deniedOutcome.explanation}</span>
          </div>
        ) : null}
      </div>
    );
  }

  // ── Actionable strip (collapsed one-line ↔ expanded) ─────────────────────────
  const declineChip = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || acted}
      aria-label="Decline"
      onClick={onDecline}
      className={cn(CHIP_CLASS, "gap-1")}
    >
      <X className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      {expanded ? <span>Decline</span> : null}
    </Button>
  );
  const approveChip = (
    <Button
      type="button"
      variant="accent"
      size="sm"
      disabled={approveDisabled}
      aria-label="Approve"
      onClick={onApprove}
      className={cn(CHIP_CLASS, "gap-1")}
    >
      <Check className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span>{isSending ? "Approving…" : "Approve"}</span>
    </Button>
  );
  const toggle = (
    <Button
      type="button"
      variant="ghostStatic"
      size="sm"
      aria-expanded={expanded}
      aria-label={
        expanded ? "Collapse approval details" : "Expand approval details"
      }
      onClick={() => setExpanded(e => !e)}
      className={cn(
        "flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-xs font-normal",
        "hover:text-[var(--app-fg)]"
      )}
    >
      <ShieldCheck
        className="h-4 w-4 flex-shrink-0 text-[var(--app-link)]"
        aria-hidden="true"
      />
      <span className="flex-shrink-0 font-semibold text-[var(--app-fg)]">
        Approve?
      </span>
      <span
        className={cn(
          "min-w-0 text-[var(--app-fg)]",
          expanded ? "whitespace-normal break-words" : "truncate"
        )}
      >
        {spec.summary}
      </span>
      <ChevronDown
        className={cn(
          "h-3.5 w-3.5 flex-shrink-0 text-[var(--app-hint)] transition-transform",
          expanded ? "rotate-180" : ""
        )}
        aria-hidden="true"
      />
    </Button>
  );

  return (
    <div
      data-testid="quick-replies-approval-card"
      data-state={status}
      className="my-2 rounded-lg border border-[var(--app-link)] bg-[var(--app-secondary-bg)]"
      // #3333: a 3px accent left edge. Inline style (not a `[3px]` arbitrary class)
      // because no named Tailwind border-l width is 3px AND the design-token gate
      // rejects arbitrary-px classes; the border color is inherited from the class.
      style={{ borderLeftWidth: "3px" }}
    >
      <div
        className={cn("flex gap-2 p-2", expanded ? "flex-col" : "items-center")}
      >
        {toggle}
        <div
          className={cn(
            "flex flex-shrink-0 gap-2",
            expanded ? "justify-end" : ""
          )}
        >
          {declineChip}
          {approveChip}
        </div>
      </div>
      <div className="px-2 pb-1.5 text-xs text-[var(--app-hint)]">
        Tap the text to expand · or type your answer below.
      </div>
    </div>
  );
}

/**
 * The generic numbered decision-menu variant. Each entry SELECTS (sends the option
 * text); menus never carry a live grant-minting token (RedTeam-D, enforced by the
 * parser). The chosen gated option then presents its own challenge in a later turn.
 */
function MenuReplies({ spec }: { spec: MenuSpec }): ReactElement {
  const { api, sessionId, disabled } = useHappyChatContext();
  const { sendMessage, isSending } = useSendMessage(api, sessionId);
  const [selected, setSelected] = useState(false);

  const onSelect = (payload: string): void => {
    if (disabled || isSending || selected) return;
    setSelected(true);
    sendMessage(payload);
  };

  return (
    <div
      data-testid="quick-replies-menu"
      className="my-2 flex flex-col gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3"
    >
      {spec.summary ? (
        <div className="text-sm break-words text-[var(--app-fg)]">
          {spec.summary}
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {spec.entries.map((entry, index) => (
          <Button
            key={index}
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || isSending || selected}
            onClick={() => onSelect(entry.payload)}
            className="min-h-11 justify-start whitespace-normal py-1.5 text-left"
          >
            <span className="mr-2 flex-shrink-0 text-[var(--app-hint)]">
              {index + 1}.
            </span>
            <span className="break-words">{entry.label}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

/** Dispatch a parsed spec to the matching variant renderer. */
export function QuickReplies({
  spec,
}: {
  spec: QuickRepliesSpec;
}): ReactElement {
  return spec.variant === "approval" ? (
    <ApprovalCard spec={spec} />
  ) : (
    <MenuReplies spec={spec} />
  );
}

/**
 * The `SyntaxHighlighter` override registered for the `hapi_quick_replies` fence
 * language. On a valid spec it renders `<QuickReplies>`; on a null parse (streaming
 * / invalid / unknown) it delegates to the real highlighter so the block renders as
 * an ordinary code fence — no throw, plain-text-operable (R4, 3333-7). The fallback
 * path uses no chat context, so a malformed block outside a chat thread degrades
 * cleanly.
 */
export function QuickRepliesFence(props: SyntaxHighlighterProps): ReactElement {
  const spec = parseQuickRepliesBlock(props.code);
  if (!spec) {
    return <SyntaxHighlighter {...props} />;
  }
  return <QuickReplies spec={spec} />;
}

/**
 * Per-language override map wired into `MarkdownText` (Task 4, option a1). Routes a
 * `hapi_quick_replies` fence through `QuickRepliesFence` on EVERY MarkdownText
 * surface at once (full render, narration fold, output-only-collapsed). CodeHeader is
 * suppressed so a rendered card carries no stray language header / copy button.
 */
export const QUICK_REPLIES_COMPONENTS_BY_LANGUAGE = {
  [QUICK_REPLIES_FENCE_LANGUAGE]: {
    SyntaxHighlighter: QuickRepliesFence,
    CodeHeader: (): null => null,
  },
} as const;
