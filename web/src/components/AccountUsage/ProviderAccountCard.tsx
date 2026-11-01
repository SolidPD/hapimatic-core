// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ProviderAccountCard — one stored OpenAI (Codex) account on the Accounts page
 * (issue #3982; on the shared card contract since #4466). The OpenAI
 * counterpart of the Anthropic `AccountUsageCard`, built on the per-account,
 * federation-merged `providerUsage[]` row (keyed by `accountUuid`, label-only
 * accounts included) rather than the per-node auth state, so N stored logins
 * render N cards.
 *
 * Row 1 is `AccountCardRow1`: monogram (the editor trigger for a local record)
 * · nickname · email · plan ("API key (Codex)" for an API-key login) · pacing
 * score · chevron. There is no alert: a re-login flag is Anthropic-only.
 * Expanded: the node row (`AccountNodeRow`, setting THAT node's OpenAI
 * default), the source caption, the caller's usage region (`children`: the
 * detail rows and the one `OpenAiUsageMeter`), then "Remove Account" when the
 * caller passes `onRemove`. The host `~/.codex` login renders
 * `data-readonly="true"` and never offers Remove (#3982 D2).
 *
 * Never renders a token or key value — neither prop carries one.
 */
import { useState, type ReactNode } from "react";
import type { OpenAiAuthState, ProviderAccountUsage } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import {
  resolveAccountLabelByUuid,
  useAccountLabelsByUuid,
} from "@/hooks/queries/useAccountLabels";
import {
  splitDragHandle,
  type SortableDragHandle,
} from "@/components/SessionList/SortableListEntry";
import { AccountMonogramEditor } from "./AccountMonogramEditor";
import { AccountCardRow1, rowMonogram } from "./AccountCardRow1";
import { AccountNodeRow, type AccountNodeItem } from "./AccountNodeRow";
import { CardRemoveButton } from "./CardRemoveButton";

export type ProviderAccountCardProps = {
  /** The account's `providerUsage[]` row (provider `openai`). */
  usage: ProviderAccountUsage;
  /** The login's email (the ChatGPT id-token email), when it names one. */
  email?: string;
  /** The auth row's plan ("Plus", "Pro", …). */
  plan?: string;
  /** The auth row's mode; an API-key login's plan chip reads "API key (Codex)". */
  mode?: OpenAiAuthState["mode"];
  /** The source caption, e.g. "Per-account" / "Host login (~/.codex)". */
  sourceLabel?: string;
  /** The host `~/.codex` login (D2): read-only — nickname + set-default only. */
  readOnly?: boolean;
  api: ApiClient | null;
  /** The node row's items (#4466 R6). */
  nodeItems: AccountNodeItem[];
  /** #3537-style whole-card drag handle (from `SortableAccountCard`). */
  dragHandle?: SortableDragHandle;
  defaultExpanded?: boolean;
  /** #4466 R8: render "Remove Account"; the caller owns the confirm. */
  onRemove?: () => void;
  /** The usage region: detail rows + the pacing meter. */
  children?: ReactNode;
};

export function ProviderAccountCard(props: ProviderAccountCardProps) {
  const {
    usage,
    email,
    plan,
    mode,
    sourceLabel,
    readOnly = false,
    api,
    nodeItems,
    defaultExpanded = true,
    onRemove,
  } = props;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editorOpen, setEditorOpen] = useState(false);
  // The node-local label/monogram sources (GET /api/accounts). A uuid present
  // here is a LOCAL record — the only kind the nickname/monogram PATCH routes
  // accept (D11: remote editing stays local-only).
  const labels = useAccountLabelsByUuid(api, api != null);
  const source = labels.get(usage.accountUuid);
  const isLocal = source !== undefined;
  // The usage row's nickname first: it is the one useSetAccountNickname patches
  // optimistically (the labels query only refreshes on the refetch).
  const label =
    usage.nickname?.trim() ||
    resolveAccountLabelByUuid(usage.accountUuid, usage.displayLabel, labels);
  const primary = email || usage.displayLabel;
  // Row 1's second slot is the email. An email-less login (an API-key Codex
  // login) shows its display label there when that differs from the nickname,
  // else its source caption, so row 1 never repeats one string.
  const secondary =
    email ||
    (usage.displayLabel !== label
      ? usage.displayLabel
      : sourceLabel || usage.displayLabel);
  const captionInRow = !email && usage.displayLabel === label && !!sourceLabel;
  const editable = api != null && isLocal;
  const {
    attributes: dragAttributes,
    rowListeners: dragRowListeners,
    keyDown: dragKeyDown,
  } = splitDragHandle(props.dragHandle);

  return (
    <div
      {...dragRowListeners}
      data-testid="provider-account-card"
      data-account-uuid={usage.accountUuid}
      data-readonly={readOnly ? "true" : undefined}
      className={
        /* design-tokens-allow: 13px card radius — matches AccountUsageCard (no --radius token maps to 13px, L3 #3405) */ "select-none rounded-[13px] border border-[var(--app-border)] bg-[var(--app-secondary-bg)]"
      }
      style={{ WebkitTouchCallout: "none" }}
    >
      <div className="px-3.5 py-1.5">
        <AccountCardRow1
          monogram={rowMonogram({
            override: source?.monogram,
            label,
            seed: usage.accountUuid,
          })}
          onMonogramTap={editable ? () => setEditorOpen(true) : undefined}
          monogramLabel={`Edit account chip for ${primary}`}
          nickname={label}
          revealText={primary}
          secondary={secondary}
          planLabel={mode === "api-key" ? "API key (Codex)" : plan}
          score={usage.score ?? null}
          expanded={expanded}
          onToggle={() => setExpanded(e => !e)}
          toggleLabel={`Toggle details for ${label}`}
          dragAttributes={dragAttributes}
          dragKeyDown={dragKeyDown}
        />
      </div>

      {expanded && (
        <>
          {api != null && nodeItems.length > 0 ? (
            <div className="border-t border-[var(--app-border)] px-3.5 py-2">
              <AccountNodeRow
                items={nodeItems}
                accountUuid={usage.accountUuid}
                accountLabel={label}
                provider="openai"
                api={api}
              />
            </div>
          ) : null}
          <div className="border-t border-[var(--app-border)] px-3.5 py-2">
            {sourceLabel && !captionInRow ? (
              <p
                data-testid="provider-account-source"
                className="text-[length:var(--text-caption)] text-[var(--app-hint)]"
              >
                {sourceLabel}
              </p>
            ) : null}
            {props.children}
          </div>
          {onRemove && !readOnly ? (
            <div className="flex px-3.5 pb-2 pt-1">
              <CardRemoveButton
                label="Remove Account"
                testId="account-remove"
                onRemove={onRemove}
              />
            </div>
          ) : null}
        </>
      )}

      {editable ? (
        <AccountMonogramEditor
          api={api}
          uuid={usage.accountUuid}
          email=""
          nickname={source?.nickname}
          monogram={source?.monogram}
          fallback={usage.displayLabel}
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}
    </div>
  );
}
