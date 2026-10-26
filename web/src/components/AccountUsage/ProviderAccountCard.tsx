// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ProviderAccountCard — one stored OpenAI (Codex) account on the Accounts page
 * (issue #3982). The OpenAI counterpart of the Anthropic `AccountUsageCard`,
 * built on the per-account, federation-merged `providerUsage[]` row (keyed by
 * `accountUuid`, label-only accounts included) rather than the per-node auth
 * state, so N stored logins render N cards.
 *
 * It is a SHELL: Row 1 names the account, Row 2 carries the nickname/monogram
 * chip (the ONE tap target that opens `AccountMonogramEditor`, as on the
 * Anthropic card) and one provider-aware `NodeChip` per node holding the account
 * (set THAT node's OpenAI default). The body — detail rows + the pacing meter —
 * is the caller's `children`. No Remove control: #4466 Task 9 adds it. The host
 * `~/.codex` login renders `data-readonly="true"` (D2), the marking #4466 reads.
 *
 * Never renders a token or key value — neither prop carries one.
 */
import { useState, type ReactNode } from "react";
import type { ProviderAccountUsage } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { AccountChip } from "@/components/session/AccountChip";
import { ACCOUNT_NICKNAME_MAX_CHARS } from "@/components/session/accountLabel";
import {
  resolveAccountLabelByUuid,
  useAccountLabelsByUuid,
} from "@/hooks/queries/useAccountLabels";
import {
  splitDragHandle,
  type SortableDragHandle,
} from "@/components/SessionList/SortableListEntry";
import { AccountMonogramEditor } from "./AccountMonogramEditor";
import { NodeChip } from "./AccountUsageCard";

export type ProviderAccountCardProps = {
  /** The account's `providerUsage[]` row (provider `openai`). */
  usage: ProviderAccountUsage;
  /** Row-1 text when the login names one (the ChatGPT id-token email). */
  email?: string;
  /** Row-1 caption, e.g. "Per-account" / "Host login (~/.codex)". */
  sourceLabel?: string;
  /** The host `~/.codex` login (D2): read-only — nickname + set-default only. */
  readOnly?: boolean;
  api: ApiClient | null;
  /** `usage.machines` resolved to node ids; labels absent here render plain. */
  nodes: { nodeId: string; nodeLabel: string }[];
  /** #3537-style whole-card drag handle (from `SortableAccountCard`). */
  dragHandle?: SortableDragHandle;
  children?: ReactNode;
};

export function ProviderAccountCard(props: ProviderAccountCardProps) {
  const { usage, email, sourceLabel, readOnly = false, api, nodes } = props;
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
  const nodeByLabel = new Map(nodes.map(n => [n.nodeLabel, n]));
  // A non-federated row carries no `machines`; the caller resolved it to the
  // implicit local node, so show that node's chip instead.
  const machineLabels =
    usage.machines.length > 0 ? usage.machines : nodes.map(n => n.nodeLabel);
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
        /* design-tokens-allow: 13px card radius — matches AccountUsageCard (no --radius token maps to 13px, L3 #3405) */ "select-none rounded-[13px] border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3.5 py-2"
      }
      style={{ WebkitTouchCallout: "none" }}
    >
      {/* ROW 1 — account name · source caption. The a11y drag attributes + the
          keyboard reorder handler ride this row (the card has no chevron). */}
      <div
        {...dragAttributes}
        onKeyDown={dragKeyDown}
        className="flex items-center gap-2.5"
      >
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-label-strong)] font-medium leading-none text-[var(--app-fg)]">
          {primary}
        </span>
        {sourceLabel ? (
          <span className="shrink-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
            {sourceLabel}
          </span>
        ) : null}
      </div>

      {/* ROW 2 — nickname/monogram chip (left) · node chips (right). */}
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[length:var(--text-caption)] leading-none text-[var(--app-hint)]">
        {api != null && isLocal ? (
          <Button
            type="button"
            variant="ghostStatic"
            size="bare"
            onClick={e => {
              e.stopPropagation();
              setEditorOpen(true);
            }}
            onPointerDown={e => e.stopPropagation()}
            aria-label={`Edit account chip for ${primary}`}
            title="Edit account chip (nickname, monogram, color)"
            data-testid="provider-account-monogram-trigger"
            className="min-w-0 shrink rounded-full hover:opacity-80"
          >
            <AccountChip
              email=""
              colorSeed={usage.accountUuid}
              label={label}
              monogram={source?.monogram}
              maxChars={ACCOUNT_NICKNAME_MAX_CHARS}
            />
          </Button>
        ) : (
          // A remote-node account: same chip, no editor (D11 — the nickname /
          // monogram routes are node-local).
          <span className="min-w-0 shrink">
            <AccountChip
              email=""
              colorSeed={usage.accountUuid}
              label={label}
              maxChars={ACCOUNT_NICKNAME_MAX_CHARS}
            />
          </span>
        )}
        {machineLabels.length > 0 && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {machineLabels.map((machine, i) => {
              const node = nodeByLabel.get(machine);
              return (
                <span
                  key={`${machine}:${i}`}
                  className="flex items-center gap-1"
                >
                  {i > 0 && <span>·</span>}
                  {node != null && api != null ? (
                    <NodeChip
                      api={api}
                      nodeId={node.nodeId}
                      nodeLabel={machine}
                      account={{
                        accountUuid: usage.accountUuid,
                        displayLabel: label,
                      }}
                      disableSetActive={false}
                      provider="openai"
                    />
                  ) : (
                    <span className="shrink-0">{machine}</span>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {props.children}

      {api != null && isLocal ? (
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
