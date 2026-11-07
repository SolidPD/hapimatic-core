// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ApiKeyCard — one stored provider API key as a card in its provider's section
 * on the Accounts page (issue #4466, R9a/R9b, E-7 = 1; re-laid out for API key
 * budgets).
 *
 * Row 1 is the shared contract (`AccountCardRow1`): monogram · name (its whole
 * label, never capped — it fades only when the row is truly too narrow) · masked
 * key (hidden on a phone) · "Use first" · a status pill ONLY when the key is
 * unverified or never probed · the credit column · chevron. The credit column
 * is the key's budget: a meter, the estimated dollars left and the days to the
 * next top-up; or "Key rejected · 401" / "Out of credit"; or "Set budget".
 *
 * Expanded is ONE line that wraps on a phone: the local node pill and an
 * Anthropic key's "All nodes" switch (#5127, with its unshare confirm), the
 * facts (last probe, spend since the period started, the top-up), then Budget,
 * Remove and Re-test (R20) on the right. A Gemini key's usage region
 * (`children`) sits below that line.
 *
 * `readOnlyRemote` is a peer node's Gemini key, known only from its usage row
 * (R9b): the key slot reads "on <node>", and there is no status, editor,
 * budget, Re-test or Remove.
 *
 * Key material never renders beyond `maskedKey` (R15). Key cards sit outside the
 * page's drag context, and the dialogs render as siblings of the card.
 */
import { useState, type ReactNode } from "react";
import type { RedactedApiKey } from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { NodeBadge } from "@/components/NodeBadge";
import {
  UNSHARE_CONFIRM_TEXT,
  shareErrorMessage,
} from "@/components/settings/sections/ApiKeysSection";
import { useApiKeyActions } from "@/hooks/mutations/useApiKeyActions";
import {
  budgetFraction,
  budgetLevel,
  daysUntil,
  formatShortDate,
  formatUsd,
  providerHasBudget,
  topUpPhrase,
  type BudgetLevel,
} from "@/lib/apiKeyBudget";
import { formatRelativeTime } from "@/lib/sessionHelpers";
import {
  AccountCardRow1,
  ApiKeyStatusPill,
  rowMonogram,
} from "./AccountCardRow1";
import { AccountMonogramEditor } from "./AccountMonogramEditor";
import { ApiKeyBudgetDialog } from "./ApiKeyBudgetDialog";
import { CardRemoveButton } from "./CardRemoveButton";
import { LEVEL_COLOR } from "./UsageBar";

const PROVIDER_NAME: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  google: "Google",
};

/** "Anthropic key", "OpenAI key", …: a key with no label is named by its provider. */
export function apiKeyCardName(
  key: Pick<RedactedApiKey, "label" | "provider">
) {
  return (
    key.label?.trim() || `${PROVIDER_NAME[key.provider] ?? key.provider} key`
  );
}

/** The key's last probe, or `null` before the first one. */
export function validatedLine(
  key: Pick<RedactedApiKey, "lastValidatedAt" | "lastValidation">
): string | null {
  if (!key.lastValidatedAt) return null;
  const at = Date.parse(key.lastValidatedAt);
  const ago = formatRelativeTime(at) ?? key.lastValidatedAt;
  const count = key.lastValidation?.modelCount;
  if (count == null) return `validated ${ago}`;
  const capped = key.lastValidation?.modelCountCapped ? "+" : "";
  return `validated ${ago} · ${count}${capped} models reachable`;
}

const DETAIL_TEXT =
  "text-[length:var(--text-body-dense)] leading-snug text-[var(--app-hint)]";
const ALERT_TEXT =
  "shrink-0 whitespace-nowrap text-[length:var(--text-body-dense)] font-semibold text-[var(--status-hot)]";

/** The meter colour for a budget level (the account gauges' palette). */
const BUDGET_COLOR: Record<BudgetLevel, string> = LEVEL_COLOR;

/**
 * Row 1's credit column. A rejected key or one the provider called out of
 * credit says so; a key with a budget shows the meter (from `sm`), the
 * estimated dollars left and the days to its next top-up; an editable
 * paid-credit key with no budget offers "Set budget".
 */
function CreditColumn(props: {
  apiKey: RedactedApiKey;
  nowMs: number;
  onEdit?: () => void;
}) {
  const { apiKey, nowMs, onEdit } = props;
  if (apiKey.status === "invalid") {
    const code = apiKey.lastValidation?.httpStatus;
    return (
      <span
        data-testid="api-key-credit"
        data-state="rejected"
        className={ALERT_TEXT}
      >
        {code ? `Key rejected · ${code}` : "Key rejected"}
      </span>
    );
  }
  if (apiKey.outOfCredit) {
    const title =
      "The provider answered that this key's credit balance is too low.";
    // An empty key is exactly the one the operator needs to top up, so the
    // column opens the budget dialog like every other budget state.
    return onEdit ? (
      <Button
        type="button"
        variant="ghostStatic"
        size="bare"
        data-testid="api-key-credit"
        data-state="out-of-credit"
        title={`${title} Tap to enter the credit you added.`}
        aria-label="Out of credit: enter the credit you added"
        onClick={onEdit}
        onPointerDown={e => e.stopPropagation()}
        className={`${ALERT_TEXT} hover:opacity-80`}
      >
        Out of credit
      </Button>
    ) : (
      <span
        data-testid="api-key-credit"
        data-state="out-of-credit"
        className={ALERT_TEXT}
        title={title}
      >
        Out of credit
      </span>
    );
  }
  const status = apiKey.budgetStatus;
  if (status) {
    const fraction = budgetFraction(status);
    const color = BUDGET_COLOR[budgetLevel(fraction)];
    const days = daysUntil(status.nextTopUpAt, nowMs);
    const title = [
      `≈ ${formatUsd(status.remainingUsd)} left of ${formatUsd(
        status.periodStartBalanceUsd
      )}`,
      `estimated from ${formatUsd(status.spentUsd)} Hapimatic metered on this key since ${formatShortDate(
        status.periodStart
      )}`,
      status.nextTopUpAt
        ? `next top-up ${formatShortDate(status.nextTopUpAt)}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const body = (
      <>
        <span
          aria-hidden="true"
          className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-[var(--app-subtle-bg)] sm:block"
        >
          <span
            className="block h-full rounded-full"
            style={{ width: `${fraction * 100}%`, backgroundColor: color }}
          />
        </span>
        <span
          className="shrink-0 whitespace-nowrap text-right text-[length:var(--text-body-dense)] font-bold tabular-nums sm:min-w-16"
          style={{ color }}
        >
          <span className="font-normal text-[var(--app-hint)]">≈</span>
          {formatUsd(status.remainingUsd)}
        </span>
        {days !== null ? (
          <span className="w-8 shrink-0 text-right text-[length:var(--text-caption-xs)] tabular-nums text-[var(--app-hint)]">
            {days}d
          </span>
        ) : null}
      </>
    );
    return onEdit ? (
      <Button
        type="button"
        variant="ghostStatic"
        size="bare"
        data-testid="api-key-credit"
        data-state="budget"
        title={title}
        aria-label={`Budget: ${title}`}
        onClick={onEdit}
        onPointerDown={e => e.stopPropagation()}
        className="flex shrink-0 items-center gap-2 font-normal hover:opacity-80"
      >
        {body}
      </Button>
    ) : (
      <span
        data-testid="api-key-credit"
        data-state="budget"
        title={title}
        className="flex shrink-0 items-center gap-2"
      >
        {body}
      </span>
    );
  }
  if (onEdit && providerHasBudget(apiKey.provider)) {
    return (
      <Button
        type="button"
        variant="ghostStatic"
        size="bare"
        data-testid="api-key-credit"
        data-state="unset"
        onClick={onEdit}
        onPointerDown={e => e.stopPropagation()}
        className="shrink-0 text-[length:var(--text-body-dense)] font-normal hover:text-[var(--app-accent)]"
      >
        Set budget
      </Button>
    );
  }
  return null;
}

export type ApiKeyCardProps = {
  apiKey: RedactedApiKey;
  api: ApiClient | null;
  /** The node serving this UI, where the vault key is stored. */
  localNode: { nodeId?: string; nodeLabel: string };
  /** The usage region: a Gemini key's joined token counter (R9a/R9b). */
  children?: ReactNode;
  defaultExpanded?: boolean;
  /** R9b: a peer node's key, read-only. */
  readOnlyRemote?: { nodeLabel: string };
  /** The key to spend first in its section (`pickUseFirstKeyId`). */
  useFirst?: boolean;
  /** Test seam: the clock for days-to-top-up. */
  nowMs?: number;
};

export function ApiKeyCard(props: ApiKeyCardProps) {
  const {
    apiKey,
    api,
    localNode,
    children,
    defaultExpanded = false,
    readOnlyRemote,
    useFirst = false,
  } = props;
  const nowMs = props.nowMs ?? Date.now();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editorOpen, setEditorOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmUnshare, setConfirmUnshare] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const { update, remove, validate } = useApiKeyActions(api);

  const name = apiKeyCardName(apiKey);
  const local = readOnlyRemote == null;
  const editable = local && api != null;
  const isAnthropic = apiKey.provider === "anthropic";
  const budgetEditable = editable && providerHasBudget(apiKey.provider);
  const shared = isAnthropic && apiKey.shareAcrossNodes === true;
  const probe = local ? validatedLine(apiKey) : null;
  const status = apiKey.budgetStatus;
  // A valid key needs no pill (its credit says it works); a rejected key says
  // so in the credit column.
  const showPill =
    local && (apiKey.status === "unverified" || apiKey.status === "none");

  const setShared = async (next: boolean) => {
    setShareError(null);
    try {
      await update.mutateAsync({
        id: apiKey.id,
        body: { shareAcrossNodes: next },
      });
    } catch (err) {
      setShareError(shareErrorMessage(err));
    }
  };

  const facts = [
    probe,
    status
      ? `${formatUsd(status.spentUsd)} used since ${formatShortDate(status.periodStart)}`
      : null,
    apiKey.budgetRecurrence ? topUpPhrase(apiKey.budgetRecurrence) : null,
  ].filter((f): f is string => f !== null);

  return (
    <>
      <div
        data-testid="api-key-card"
        data-api-key-id={apiKey.id}
        data-provider={apiKey.provider}
        data-readonly={local ? undefined : "true"}
        className={
          /* design-tokens-allow: 13px card radius — matches AccountUsageCard (no --radius token maps to 13px, L3 #3405) */ "rounded-[13px] border border-[var(--app-border)] bg-[var(--app-secondary-bg)]"
        }
      >
        <div className="px-3.5 py-1.5">
          <AccountCardRow1
            monogram={rowMonogram({
              override: apiKey.monogram,
              label: name,
              seed: apiKey.id,
            })}
            onMonogramTap={editable ? () => setEditorOpen(true) : undefined}
            monogramLabel={`Edit name and monogram for ${name}`}
            nickname={name}
            revealText={name}
            nicknameUncapped
            secondary={
              readOnlyRemote
                ? `on ${readOnlyRemote.nodeLabel}`
                : apiKey.maskedKey
            }
            secondaryMono={local}
            secondaryFromSm={local}
            statusPill={
              showPill ? (
                <span className="inline-flex items-center gap-1.5">
                  {useFirst ? <UseFirstChip /> : null}
                  <ApiKeyStatusPill status={apiKey.status} />
                </span>
              ) : useFirst ? (
                <UseFirstChip />
              ) : undefined
            }
            statusPillWraps={showPill}
            trailing={
              local ? (
                <CreditColumn
                  apiKey={apiKey}
                  nowMs={nowMs}
                  onEdit={
                    budgetEditable ? () => setBudgetOpen(true) : undefined
                  }
                />
              ) : undefined
            }
            expanded={expanded}
            onToggle={() => setExpanded(e => !e)}
            toggleLabel={`Toggle details for ${name}`}
          />
        </div>
        {expanded && (
          <div
            data-testid="api-key-card-body"
            className="flex flex-col gap-1.5 border-t border-[var(--app-border)] px-3.5 py-1.5"
          >
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {/* The vault key lives on the UI host. */}
              {local && localNode.nodeId ? (
                <NodeBadge
                  nodeId={localNode.nodeId}
                  nodeLabel={localNode.nodeLabel}
                  labelAsReceived
                />
              ) : null}
              {local && isAnthropic && api != null ? (
                <label
                  className="flex cursor-pointer items-center gap-1.5 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
                  title={`Stored on ${localNode.nodeLabel} · ${
                    shared ? "available to all nodes" : "used on this node only"
                  }`}
                >
                  <Checkbox
                    checked={shared}
                    disabled={update.isPending}
                    aria-label={`Make ${name} available to all nodes`}
                    data-testid="api-key-card-share"
                    onChange={e => {
                      if (e.target.checked) void setShared(true);
                      else setConfirmUnshare(true);
                    }}
                  />
                  All nodes
                </label>
              ) : null}
              {facts.length > 0 ? (
                // Below sm the facts take their own full-width line, so the
                // actions stay up beside the node pill (one row saved).
                <span
                  data-testid="api-key-facts"
                  className={`order-last basis-full sm:order-none sm:basis-auto ${DETAIL_TEXT}`}
                >
                  {facts.join(" · ")}
                </span>
              ) : null}
              {editable ? (
                <span className="ml-auto flex items-center gap-3">
                  {budgetEditable ? (
                    <Button
                      type="button"
                      variant="ghostStatic"
                      size="bare"
                      data-testid="api-key-budget"
                      onClick={() => setBudgetOpen(true)}
                      // On a phone the credit column opens the same dialog;
                      // hiding this keeps the actions beside the node pill.
                      className="hidden text-[length:var(--text-body-dense)] font-normal hover:text-[var(--app-fg)] sm:inline-flex"
                    >
                      Budget
                    </Button>
                  ) : null}
                  {/* R8: plain-weight deep red. */}
                  <CardRemoveButton
                    label="Remove"
                    testId="api-key-remove"
                    onRemove={() => setConfirmRemove(true)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="api-key-retest"
                    aria-label={`Re-test ${name}`}
                    disabled={validate.isPending}
                    onClick={() =>
                      validate.mutate({ id: apiKey.id, force: true })
                    }
                    className="h-auto shrink-0 px-2.5 py-0.5 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
                  >
                    {validate.isPending ? "Re-testing…" : "Re-test"}
                  </Button>
                </span>
              ) : null}
            </div>
            {shareError ? (
              <span
                data-testid="api-key-card-share-error"
                className="text-[length:var(--text-body-dense)] text-[var(--status-hot)]"
              >
                {shareError}
              </span>
            ) : null}
            {children != null ? (
              <div data-testid="api-key-usage">{children}</div>
            ) : null}
            {editable && validate.isError ? (
              <p
                data-testid="api-key-retest-error"
                className="text-[length:var(--text-body-dense)] text-[var(--status-hot)]"
              >
                Couldn&apos;t re-test the key — please try again.
              </p>
            ) : null}
          </div>
        )}
      </div>

      {editable ? (
        <AccountMonogramEditor
          api={api}
          subject={{ kind: "key", id: apiKey.id, seed: apiKey.id }}
          nickname={apiKey.label}
          monogram={apiKey.monogram}
          fallback={`${PROVIDER_NAME[apiKey.provider] ?? apiKey.provider} key`}
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}
      {budgetEditable ? (
        <ApiKeyBudgetDialog
          apiKey={apiKey}
          name={name}
          api={api}
          open={budgetOpen}
          onClose={() => setBudgetOpen(false)}
        />
      ) : null}
      {editable ? (
        <ConfirmDialog
          isOpen={confirmRemove}
          onClose={() => setConfirmRemove(false)}
          title="Remove API key"
          description={`Remove ${name} (${apiKey.maskedKey})? This cannot be undone.`}
          confirmLabel="Remove Key"
          confirmingLabel="Removing…"
          onConfirm={async () => {
            await remove.mutateAsync({
              id: apiKey.id,
              provider: apiKey.provider,
            });
            setConfirmRemove(false);
          }}
          isPending={remove.isPending}
          destructive
        />
      ) : null}
      {editable && isAnthropic ? (
        <ConfirmDialog
          isOpen={confirmUnshare}
          onClose={() => setConfirmUnshare(false)}
          title="Stop sharing this key?"
          description={UNSHARE_CONFIRM_TEXT}
          confirmLabel="Stop sharing"
          confirmingLabel="Saving…"
          onConfirm={async () => {
            setConfirmUnshare(false);
            await setShared(false);
          }}
          isPending={update.isPending}
        />
      ) : null}
    </>
  );
}

/** The "spend this key first" marker. */
function UseFirstChip() {
  return (
    <span
      data-testid="api-key-use-first"
      title="Spend this key first: its credit is the most at risk of expiring unused."
      className="inline-flex shrink-0 items-center rounded-full border border-[color-mix(in_srgb,var(--app-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--app-accent)_12%,transparent)] px-1.5 py-0 text-[length:var(--text-caption-xs)] font-semibold leading-none text-[var(--app-accent)]"
    >
      Use first
    </span>
  );
}
