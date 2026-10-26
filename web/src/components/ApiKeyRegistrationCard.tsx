// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import type { ApiClient } from "@/api/client";
import type { ApiKeyProvider } from "@hapi/protocol/schemas";
import { Button } from "@/components/ui/button";
import { useApiKeys } from "@/hooks/queries/useApiKeys";
import { useApiKeyActions } from "@/hooks/mutations/useApiKeyActions";
import { useShareApiKeysByDefault } from "@/hooks/useShareApiKeysByDefault";
import { ShareAcrossNodesCheckbox } from "@/components/ShareAcrossNodesCheckbox";

const INPUT_CLASS =
  "rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)]";

/**
 * The reusable, NON-SECRET descriptor captured by the conversational flow — read
 * from the `register_service_key` tool-call INPUT (never the secret). Mirrors the
 * tool's argument shape in `cli/.../startHappyServer.ts`.
 */
export type ConversationalDescriptor = {
  provider: string;
  label?: string;
  baseUrl?: string;
  model?: string;
};

/**
 * ApiKeyRegistrationCard — the secure secret-entry surface for the B4 (#1957)
 * conversational key-registration flow (Architecture S).
 *
 * SECURITY (load-bearing): this card is the ONLY place the raw secret is ever
 * typed, and it travels web client → server `POST /api/api-keys` EXACTLY ONCE
 * (via `useApiKeyActions.add`). The secret NEVER passes through the agent, the
 * conversation transcript, or Anthropic — the descriptor (provider/label/config)
 * came from the tool-call input; the key is entered here and posted straight to
 * the #1955 vault. The `<input>` is `type="password"`; after a successful POST
 * only the server's `maskedKey` (••••last4) is shown — the raw value is cleared
 * and never re-rendered (the same discipline as the admin API Keys page).
 *
 * Rendered inline in the chat thread by `ToolMessage.tsx` whenever a
 * `register_service_key` tool call is present. The tool-call block persists in
 * the transcript, so on reload this card re-renders; it reflects the live vault
 * state (via `useApiKeys`) instead of blindly re-prompting.
 */
export function ApiKeyRegistrationCard({
  api,
  descriptor,
}: {
  api: ApiClient | null;
  descriptor: ConversationalDescriptor;
}) {
  const { data: keys = [] } = useApiKeys(api);
  const { add } = useApiKeyActions(api);
  const [secret, setSecret] = useState("");
  const [maskedResult, setMaskedResult] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Issue #5127: "Make available to all nodes" for an Anthropic key — starts
  // from the preference until touched, sent explicitly with the add (D7).
  const isAnthropic = descriptor.provider === "anthropic";
  const shareDefault = useShareApiKeysByDefault(api);
  const [share, setShare] = useState(shareDefault.enabled);
  const shareTouchedRef = useRef(false);
  useEffect(() => {
    if (!shareTouchedRef.current) setShare(shareDefault.enabled);
  }, [shareDefault.enabled]);

  const existing = keys.find(k => k.provider === descriptor.provider);
  const trimmed = secret.trim();
  // #5127 (code review F7): an Anthropic add waits for the share preference.
  const canSubmit =
    trimmed.length > 0 &&
    !add.isPending &&
    maskedResult === null &&
    (!isAnthropic || shareDefault.loaded || shareTouchedRef.current);

  const handleSubmit = () => {
    if (!canSubmit) return;
    add.mutate(
      {
        provider: descriptor.provider as ApiKeyProvider,
        key: trimmed,
        ...(descriptor.label ? { label: descriptor.label } : {}),
        ...(isAnthropic ? { shareAcrossNodes: share } : {}),
        descriptor: {
          source: "conversational",
          ...(descriptor.baseUrl ? { baseUrl: descriptor.baseUrl } : {}),
          ...(descriptor.model ? { model: descriptor.model } : {}),
        },
      },
      {
        onSuccess: redacted => {
          setSecret("");
          setMaskedResult(redacted.maskedKey);
        },
      }
    );
  };

  // Success state — show ONLY the server-provided masked value, never the raw key.
  if (maskedResult !== null) {
    return (
      <div
        className="mt-2 flex items-center gap-2 rounded-md border border-[var(--app-border)] px-3 py-2.5 text-[length:var(--text-body)] text-[var(--accent-emerald-400)]"
        data-testid="api-key-registration-success"
      >
        <KeyRound className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <span>
          Registered the {descriptor.provider} key ({maskedResult}). It's now in
          your Provider API Keys and ready to validate.
        </span>
      </div>
    );
  }

  // User dismissed the card without entering a key.
  if (dismissed) {
    return (
      <div
        className="mt-2 rounded-md border border-dashed border-[var(--app-border)] px-3 py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
        data-testid="api-key-registration-dismissed"
      >
        Key entry cancelled. Ask again to register a {descriptor.provider} key.
      </div>
    );
  }

  return (
    <div
      className="mt-2 flex flex-col gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-3"
      data-testid="api-key-registration-card"
    >
      <div className="flex items-center gap-2">
        <KeyRound
          className="h-4 w-4 flex-shrink-0 text-[var(--app-link)]"
          aria-hidden="true"
        />
        <span className="text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
          Register {descriptor.label || descriptor.provider} key
        </span>
      </div>

      <div className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        <span data-testid="api-key-registration-provider">
          Provider: {descriptor.provider}
        </span>
        {descriptor.baseUrl ? <> · Base URL: {descriptor.baseUrl}</> : null}
        {descriptor.model ? <> · Model: {descriptor.model}</> : null}
      </div>

      {existing ? (
        <p
          className="text-[length:var(--text-body-dense)] text-[var(--status-warn)]"
          data-testid="api-key-registration-replace-note"
        >
          A {descriptor.provider} key is already stored — registering will
          replace it.
        </p>
      ) : null}

      <label className="flex flex-col gap-1 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        API key
        <input
          type="password"
          value={secret}
          onChange={e => setSecret(e.target.value)}
          placeholder="Paste the provider API key"
          autoComplete="off"
          style={{ fontSize: "16px" }}
          className={INPUT_CLASS}
          data-testid="api-key-registration-secret"
        />
      </label>

      {isAnthropic && (
        <ShareAcrossNodesCheckbox
          checked={share}
          onChange={next => {
            shareTouchedRef.current = true;
            setShare(next);
          }}
        />
      )}

      <p className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
        Sent directly to this node's vault and masked after entry — never shared
        with the assistant or stored in this conversation.
      </p>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="accent"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="h-auto self-start rounded-md px-4 py-2 text-[length:var(--text-body)] font-medium text-[var(--app-bg)]"
          data-testid="api-key-registration-submit"
        >
          {add.isPending ? "Registering…" : "Confirm & register"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setDismissed(true)}
          disabled={add.isPending}
          className="h-auto self-start rounded-md px-3 py-2 text-[length:var(--text-body)] text-[var(--app-fg)] hover:bg-[var(--app-bg)]"
          data-testid="api-key-registration-cancel"
        >
          Cancel
        </Button>
      </div>

      {add.isError ? (
        <p
          className="text-[length:var(--text-body-dense)] text-[var(--accent-rose-400)]"
          data-testid="api-key-registration-error"
        >
          Failed to register the key — please try again.
        </p>
      ) : null}
    </div>
  );
}
