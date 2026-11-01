// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import type { AccountHealthEntry } from "@hapi/protocol";
import { Button } from "@/components/ui/button";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { ChevronIcon } from "@/components/icons";
import { NodeBadge } from "@/components/NodeBadge";
import { AccountChip } from "@/components/session/AccountChip";
import { PROVIDER_NODE_ERROR_TEXT } from "@/components/AccountUsage/ProviderSectionBodies";
import { formatRefreshUtc, formatSince } from "./addModalDone";
import type { LoginNode } from "./NodeLoginList";

/**
 * One node's row in the "+ Add" modal's "Subscription login" section (issue
 * #4464 R2, R3): the radio, the node badge, the summary line, and the expanded
 * list of every account the node holds. Moved out of NodeLoginList.tsx by
 * #5467, which added the role segment (S6), the email reveal (S7) and the
 * degraded OpenAI line (S10) and took that file past the 1500-line lint limit.
 */

function accountStatusText(
  a: AccountHealthEntry,
  compact: boolean
): { text: string; tone: "bad" | "muted" } {
  if (a.authKind === "env-token") return { text: "env token", tone: "muted" };
  if (a.needsRelogin) {
    return {
      text: `re-login · ${formatSince(a, { compact }) ?? ""}`.trim(),
      tone: "bad",
    };
  }
  if (a.lastRefreshedAt === null)
    return { text: "never refreshed", tone: "muted" };
  return {
    text: `refreshing · last ${formatRefreshUtc(a.lastRefreshedAt, { compact })}`,
    tone: "muted",
  };
}

function nodeSummary(
  node: LoginNode,
  provider: "anthropic" | "openai"
): {
  text: string;
  bad: boolean;
} {
  const where = node.isUiHost ? "this node" : null;
  // #5467 S6: "this node · hub · 7 accounts" (#4464's spec line).
  const role = node.role ?? null;
  if (provider === "openai") {
    // #5467 S10: a failed read is not an empty list.
    if (openAiReadFailed(node)) {
      return {
        text: [where, role, "logins unavailable"].filter(Boolean).join(" · "),
        bad: false,
      };
    }
    // #6054 SINK-2: an unanswered read is not an empty list either.
    if (openAiLoading(node)) {
      return {
        text: [where, role, "loading logins…"].filter(Boolean).join(" · "),
        bad: false,
      };
    }
    const n = node.openai.length;
    const count = `${n} login${n === 1 ? "" : "s"}`;
    return {
      text: [where, role, count].filter(Boolean).join(" · "),
      bad: false,
    };
  }
  const total = node.accounts.length;
  const dead = node.accounts.filter(a => a.needsRelogin).length;
  if (dead > 0) {
    return { text: `${dead} of ${total} accounts need re-login`, bad: true };
  }
  const count = `${total} account${total === 1 ? "" : "s"}`;
  const tail = total > 0 ? "all refreshing" : null;
  return {
    text: [where, role, count, tail].filter(Boolean).join(" · "),
    bad: false,
  };
}

/** #5467 S10: the provider-auth read for this node failed (`error`: its own
 *  reader; `unreachable`: the hub could not reach it), so its OpenAI logins
 *  are unknown. A node the envelope has no row for keeps the empty list. */
function openAiReadFailed(node: LoginNode): boolean {
  return node.openaiStatus === "error" || node.openaiStatus === "unreachable";
}

/** #6054 SINK-2: the provider-auth read has not answered yet, so this node's
 *  OpenAI logins are unknown. */
function openAiLoading(node: LoginNode): boolean {
  return node.openaiStatus === "loading";
}

/** #5467 S7: the dotted underline that marks a name as revealing its email. */
const REVEAL_UNDERLINE = "underline decoration-dotted underline-offset-2";

export function useIsCompact(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 480
  );
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < 480);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return compact;
}

export function NodeRow(props: {
  node: LoginNode;
  provider: "anthropic" | "openai";
  selected: boolean;
  onSelect: () => void;
  resourceHealth: boolean;
  compact: boolean;
}) {
  const { node, provider, selected, compact } = props;
  const [expanded, setExpanded] = useState(false);
  const summary = nodeSummary(node, provider);
  const disabled = node.disabledReason !== null;
  const radioId = `add-node-${node.nodeId}`;
  return (
    <li
      className={`rounded-md border ${selected ? "border-[var(--app-link)]" : "border-[var(--app-border)]"} bg-[var(--app-secondary-bg)]`}
      data-testid="add-node-row"
      data-node-id={node.nodeId}
      data-disabled={disabled ? "true" : "false"}
    >
      <div className="flex items-center gap-2 px-2.5 py-2">
        <input
          id={radioId}
          type="radio"
          name="add-node"
          checked={selected}
          disabled={disabled && !selected}
          onChange={props.onSelect}
          className="h-4 w-4 shrink-0 accent-[var(--app-link)]"
        />
        <label
          htmlFor={radioId}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <NodeBadge
            nodeId={node.nodeId}
            nodeLabel={node.nodeLabel}
            interactive={false}
            resourceHealth={props.resourceHealth}
            labelAsReceived={node.isUiHost}
            nodeStatus={
              node.status === "offline" || node.status === "unreachable"
                ? "offline"
                : "online"
            }
          />
          <span
            className={`min-w-0 truncate text-[length:var(--text-body-dense)] ${
              disabled || summary.bad
                ? "text-[var(--accent-rose-400)]"
                : "text-[var(--app-hint)]"
            }`}
            data-testid="add-node-summary"
          >
            {disabled ? node.disabledReason : summary.text}
          </span>
        </label>
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} ${node.nodeLabel} accounts`}
          onClick={() => setExpanded(e => !e)}
          className="shrink-0 p-1 text-[var(--app-hint)]"
          data-testid="add-node-expand"
        >
          <ChevronIcon className="h-3.5 w-3.5" collapsed={!expanded} />
        </Button>
      </div>
      {expanded && (
        <ul
          className="flex flex-col gap-1.5 border-t border-[var(--app-border)] px-2.5 py-2"
          data-testid="add-node-accounts"
        >
          {provider === "anthropic" &&
            node.accounts.map(a => {
              const st = accountStatusText(a, compact);
              return (
                <li
                  key={a.accountUuid}
                  className="flex min-w-0 items-center gap-2"
                  data-testid="add-node-account"
                >
                  {/* #5467 S7 (#4464's spec): a dotted nickname; hover, focus
                      or tap reveals the email (a tap-to-reveal popover on a
                      coarse pointer). The chip's own title is off so desktop
                      shows one bubble. */}
                  <HoverTooltipButton
                    type="button"
                    content={a.emailAddress}
                    className="flex max-w-[45%] shrink-0 rounded-sm text-left"
                    data-testid="add-node-account-identity"
                  >
                    <AccountChip
                      email={a.emailAddress}
                      label={a.nickname ?? undefined}
                      monogram={a.monogram ?? undefined}
                      nativeTitle={false}
                      labelClassName={REVEAL_UNDERLINE}
                    />
                  </HoverTooltipButton>
                  <span
                    className={`min-w-0 truncate font-mono text-[length:var(--text-caption)] ${
                      st.tone === "bad"
                        ? "text-[var(--accent-rose-400)]"
                        : "text-[var(--app-hint)]"
                    }`}
                  >
                    {st.text}
                  </span>
                </li>
              );
            })}
          {provider === "openai" && openAiReadFailed(node) && (
            // #5467 S10: the Accounts page's DegradedNodeRow wording.
            <li
              className="text-[length:var(--text-caption)] text-[var(--toast-warning)]"
              data-testid="add-node-openai-degraded"
            >
              {node.nodeLabel}:{" "}
              {node.openaiStatus === "error"
                ? PROVIDER_NODE_ERROR_TEXT
                : "unreachable"}
            </li>
          )}
          {provider === "openai" && openAiLoading(node) && (
            <li
              className="text-[length:var(--text-caption)] text-[var(--app-hint)]"
              data-testid="add-node-openai-loading"
            >
              Loading OpenAI logins…
            </li>
          )}
          {provider === "openai" &&
            !openAiReadFailed(node) &&
            !openAiLoading(node) &&
            node.openai.map((o, i) => (
              <li
                key={`${o.source}:${o.accountUuid ?? i}`}
                className="flex min-w-0 items-center gap-2 text-[length:var(--text-caption)]"
                data-testid="add-node-account"
              >
                {o.label && o.email ? (
                  // #5467 S7: a named login reveals its email the same way.
                  <HoverTooltipButton
                    type="button"
                    content={o.email}
                    className="flex min-w-0 rounded-sm text-left"
                    data-testid="add-node-openai-identity"
                  >
                    <span
                      className={`min-w-0 truncate text-[var(--app-fg)] ${REVEAL_UNDERLINE}`}
                    >
                      {o.label}
                    </span>
                  </HoverTooltipButton>
                ) : (
                  <span className="min-w-0 truncate text-[var(--app-fg)]">
                    {o.label ?? o.email ?? node.nodeLabel}
                  </span>
                )}
                {o.plan && (
                  <span className="text-[var(--app-hint)]">{o.plan}</span>
                )}
                {o.expiresAt && (
                  <span className="font-mono text-[var(--app-hint)]">
                    expires{" "}
                    {formatRefreshUtc(Date.parse(o.expiresAt), { compact })}
                  </span>
                )}
              </li>
            ))}
          {!(
            provider === "openai" &&
            (openAiReadFailed(node) || openAiLoading(node))
          ) &&
            (provider === "anthropic"
              ? node.accounts.length
              : node.openai.length) === 0 && (
              <li className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
                No{" "}
                {provider === "anthropic" ? "Claude accounts" : "OpenAI logins"}{" "}
                on {node.nodeLabel} yet
              </li>
            )}
        </ul>
      )}
    </li>
  );
}
