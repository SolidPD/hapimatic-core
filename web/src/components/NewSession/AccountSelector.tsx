// SPDX-License-Identifier: AGPL-3.0-only
import { FormField } from "./FormField";
import { CONTROL_BASE, ControlChevron } from "./controls";
import { Button } from "@/components/ui/button";
import type { RedactedAccount } from "@/types/api";
import type { RedactedApiKey } from "@hapi/protocol/schemas";
import { apiKeyDisplayName } from "@/lib/apiKeyStatus";
import { apiKeyCredentialLabel } from "@/hooks/queries/useSessionAccountEmail";

/**
 * Issue #4568: how an API-key credential is named on the create page —
 * "Anthropic API · <label>", else the masked key. Composes the session view's
 * format ({@link apiKeyCredentialLabel}) with the shared key-name rule, so the
 * create page and the running session name a key identically. Label-only by
 * construction: the redacted view carries no key material.
 */
export function apiKeySessionLabel(
  key: Pick<RedactedApiKey, "label" | "maskedKey">
): string {
  return apiKeyCredentialLabel(apiKeyDisplayName(key));
}

/**
 * The account-store snapshot's access token is past expiry. NON-AUTHORITATIVE
 * for non-host accounts (#1658): the snapshot rots by design post-#1635 (the
 * scheduler defers isolated accounts machine-globally, native Claude Code
 * consumes-and-blanks the isolated copy, and only the host-default account is
 * watcher-synced). This predicate therefore means "snapshot is stale", NOT
 * "account unusable" — spawn-time recovery/refresh decides usability. Gate
 * selection on `unrefreshable` instead; use this only for the informational
 * "Stale" badge.
 *
 * #3392: NO production consumer — test-only (`AccountSelector.test.tsx`); do NOT
 * use it to gate selection. Availability is the live `resolveToken` result +
 * `unrefreshable`, never the store-cache `expiresAt` this reads.
 */
export function isAccountExpired(account: RedactedAccount): boolean {
  return account.expiresAt <= Date.now();
}

/**
 * Account selector for the create-session form (epic #1446, Sub-Issue I #1455,
 * unified in #1496).
 *
 * A field-button (NOT a `<select>`): it shows a compact summary of the currently
 * selected account and opens the shared `AccountSelectorModal` (in `"spawn"`
 * scope) on click so account rows, the ✕ remove control, and the "Log in
 * manually" flow match the session-detail surface (R4). The node-default account
 * is marked with a `(default)` suffix; when no node default is set, the
 * pre-selected account shows `(no default)` (R2/R3). The consumer renders this
 * ONLY for local spawn targets (R8) and gates the account query so it does not
 * fire on remote targets.
 */
export function AccountSelector(props: {
  accounts: RedactedAccount[];
  selectedUuid: string | null;
  /** The node's default (active) account uuid — drives the (default)/(no default) suffix. */
  activeAccountUuid: string | null;
  isLoading?: boolean;
  isDisabled: boolean;
  /**
   * Field label — defaults to "Account". #1950 (A3) relabels this to "API Key"
   * for non-Claude agents (a STATIC placeholder relabel; no real stored-key
   * wiring — that lands with Epic #1954 / B2-B3, SEAM-2).
   */
  label?: string;
  /** Empty store but the node env carries a Claude credential (cloud-VM case,
   * #2095): show the real spawn default instead of a confusing empty state. */
  envCredentialFallback?: boolean;
  /**
   * Issue #4568: the node's Anthropic vault keys offered beside the accounts
   * (Claude, local target) — the redacted view only — and the one picked as the
   * session's credential, if any. A picked key wins the summary.
   */
  apiKeys?: RedactedApiKey[];
  selectedApiKeyId?: string | null;
  onOpen: () => void;
}) {
  const {
    accounts,
    selectedUuid,
    activeAccountUuid,
    isLoading,
    isDisabled,
    label,
    envCredentialFallback,
    apiKeys,
    selectedApiKeyId,
    onOpen,
  } = props;

  const selected = accounts.find(a => a.accountUuid === selectedUuid) ?? null;
  const noAccounts = accounts.length === 0;
  const selectedKey =
    (selectedApiKeyId && apiKeys?.find(k => k.id === selectedApiKeyId)) || null;
  // A key-only node (no stored account, ≥1 vault key) still opens the picker.
  const hasKeys = (apiKeys?.length ?? 0) > 0;

  // Compact summary text for the field-button.
  let summary: string;
  if (selectedKey) {
    summary = apiKeySessionLabel(selectedKey);
  } else if (isLoading && noAccounts) {
    summary = "Loading accounts…";
  } else if (noAccounts && envCredentialFallback) {
    // The credential installed during onboarding IS the spawn default — display
    // it (non-changeable) rather than an empty field (#2095 friction entry 7).
    summary = "Instance credential (default)";
  } else if (noAccounts && hasKeys) {
    summary = "Select an API key";
  } else if (noAccounts) {
    summary = "No accounts available";
  } else if (selected) {
    const org = selected.organizationName
      ? ` — ${selected.organizationName}`
      : "";
    // R3: (default) when the selection equals the node default; (no default)
    // when there is no node default at all; no suffix for a non-default choice.
    const suffix =
      activeAccountUuid === null
        ? " (no default)"
        : selected.accountUuid === activeAccountUuid
          ? " (default)"
          : "";
    // #3808 Task 5: an OpenAI/Google account is keyed by `displayName` (its
    // operator label), not email — `emailAddress` is empty for them, so keying the
    // summary off email alone renders the selected provider account identity-less
    // (a bare "(no default)"). Fall back to `displayName`, matching the modal row
    // (`displayName || emailAddress`). Anthropic accounts always carry an email, so
    // this is byte-identical for them.
    const identity = selected.emailAddress || selected.displayName;
    summary = `${identity}${org}${suffix}`;
  } else {
    summary = "Select account";
  }

  return (
    <FormField
      label={label ?? "Provider Account"}
      tooltip="The provider subscription account this session signs in with and draws its usage limits from — or, for Claude Code, a stored Anthropic API key, billed per token to whoever owns that key. (default) marks the node's default account. Rate limits are per-account, so spreading concurrent sessions across accounts multiplies available throughput."
      bookmarkId="account"
    >
      <Button
        type="button"
        variant="ghost"
        onClick={onOpen}
        disabled={isDisabled || (noAccounts && !hasKeys && !isLoading)}
        className={`${CONTROL_BASE} flex items-center justify-between gap-2 px-2.5 text-left font-normal hover:bg-[var(--app-bg)]`}
      >
        <span className="truncate">{summary}</span>
        <ControlChevron className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
      </Button>
    </FormField>
  );
}
