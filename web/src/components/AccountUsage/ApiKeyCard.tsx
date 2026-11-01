// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ApiKeyCard — one stored provider API key as a card in its provider's section
 * on the Accounts page (issue #4466, R9a/R9b, E-7 = 1).
 *
 * Row 1 is the shared contract (`AccountCardRow1`): monogram · name · masked key
 * · "API key" · status pill · chevron; no score and no alert. Expanded, in
 * order: the local node pill; the last probe ("validated <ago> · N models
 * reachable"); the caller's usage region (`children`: a Gemini key's token
 * counter), else — for an Anthropic or OpenAI key — the note that the provider
 * exposes no quota through an API key; the storage line (R19); an Anthropic
 * key's "All nodes" switch (#5127, with its unshare confirm); "Re-test" (R20);
 * and "Remove Key" at the lower left (R8).
 *
 * `readOnlyRemote` is a peer node's Gemini key, known only from its usage row
 * (R9b): the key slot reads "on <node>", and there is no status, editor,
 * Re-test or Remove.
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
import { formatRelativeTime } from "@/lib/sessionHelpers";
import {
  AccountCardRow1,
  ApiKeyStatusPill,
  rowMonogram,
} from "./AccountCardRow1";
import { AccountMonogramEditor } from "./AccountMonogramEditor";
import { CardRemoveButton } from "./CardRemoveButton";

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
};

export function ApiKeyCard(props: ApiKeyCardProps) {
  const {
    apiKey,
    api,
    localNode,
    children,
    defaultExpanded = false,
    readOnlyRemote,
  } = props;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editorOpen, setEditorOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmUnshare, setConfirmUnshare] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const { update, remove, validate } = useApiKeyActions(api);

  const name = apiKeyCardName(apiKey);
  const local = readOnlyRemote == null;
  const editable = local && api != null;
  const isAnthropic = apiKey.provider === "anthropic";
  const isGoogle = apiKey.provider === "gemini" || apiKey.provider === "google";
  const shared = isAnthropic && apiKey.shareAcrossNodes === true;
  const probe = local ? validatedLine(apiKey) : null;

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
            secondary={
              readOnlyRemote
                ? `on ${readOnlyRemote.nodeLabel}`
                : apiKey.maskedKey
            }
            secondaryMono={local}
            planLabel="API key"
            statusPill={
              local ? <ApiKeyStatusPill status={apiKey.status} /> : undefined
            }
            statusPillWraps={
              apiKey.status === "unverified" || apiKey.status === "none"
            }
            expanded={expanded}
            onToggle={() => setExpanded(e => !e)}
            toggleLabel={`Toggle details for ${name}`}
          />
        </div>
        {expanded && (
          <div
            data-testid="api-key-card-body"
            className="flex flex-col gap-2 border-t border-[var(--app-border)] px-3.5 py-2"
          >
            {/* 1. The node row: the vault key lives on the UI host. */}
            {local && localNode.nodeId ? (
              <div className="flex">
                <NodeBadge
                  nodeId={localNode.nodeId}
                  nodeLabel={localNode.nodeLabel}
                  labelAsReceived
                />
              </div>
            ) : null}
            {/* 2. The usage region. */}
            {probe ? (
              <p data-testid="api-key-validated" className={DETAIL_TEXT}>
                {probe}
              </p>
            ) : null}
            {children != null ? (
              <div data-testid="api-key-usage">{children}</div>
            ) : !isGoogle ? (
              <p data-testid="api-key-no-quota" className={DETAIL_TEXT}>
                The provider exposes no quota through an API key
              </p>
            ) : null}
            {/* 3. Storage (R19), the #5127 switch, Re-test (R20). */}
            {local ? (
              <p data-testid="api-key-storage" className={DETAIL_TEXT}>
                {`Stored on ${localNode.nodeLabel} · ${
                  shared ? "available to all nodes" : "used on this node only"
                }`}
              </p>
            ) : null}
            {local && isAnthropic && api != null ? (
              <div className="flex flex-col gap-0.5">
                <label className="flex cursor-pointer items-center gap-1.5 text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
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
                {shareError ? (
                  <span
                    data-testid="api-key-card-share-error"
                    className="text-[length:var(--text-body-dense)] text-[var(--status-hot)]"
                  >
                    {shareError}
                  </span>
                ) : null}
              </div>
            ) : null}
            {editable ? (
              <div className="flex items-center justify-between gap-2 pt-1">
                {/* 4. Remove Key (R8): plain-weight deep red, lower left. */}
                <CardRemoveButton
                  label="Remove Key"
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
                  className="h-auto shrink-0 px-2.5 py-1 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
                >
                  {validate.isPending ? "Re-testing…" : "Re-test"}
                </Button>
              </div>
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
