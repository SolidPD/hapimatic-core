// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import {
  API_KEY_PROVIDERS,
  getApiKeyProviderUrl,
  type RedactedApiKey,
} from "@hapi/protocol/schemas";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAppContext } from "@/lib/app-context";
import { useApiKeys } from "@/hooks/queries/useApiKeys";
import { useApiKeyActions } from "@/hooks/mutations/useApiKeyActions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { API_KEY_STATUS_META as STATUS_META } from "@/lib/apiKeyStatus";
import { ApiError } from "@/api/client";
import { useShareApiKeysByDefault } from "@/hooks/useShareApiKeysByDefault";
import { ShareAcrossNodesCheckbox } from "@/components/ShareAcrossNodesCheckbox";

/** Issue #5127: the confirm copy for turning a key's sharing off. */
export const UNSHARE_CONFIRM_TEXT =
  "Other nodes can no longer start or restart sessions on this key. Sessions already running there keep it until they stop.";

/** Issue #5127: the server's reason for refusing a sharing change, else a retry line. */
function shareErrorMessage(err: unknown): string {
  if (
    err instanceof ApiError &&
    (err.code === "share_unavailable" || err.code === "share_unsupported") &&
    err.body
  ) {
    try {
      const parsed = JSON.parse(err.body) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.length <= 300) {
        return parsed.error;
      }
    } catch {
      // fall through to the generic line
    }
  }
  return "Could not change sharing — please try again.";
}

const INPUT_CLASS =
  "rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)]";

/**
 * ApiKeysSection — the "Provider API Keys" section of Settings → Provider Accounts
 * (issue #1955, epic #1954; folded from the former `/settings/api-keys` page onto
 * the Keys page by the Settings sidebar reorganization, then onto the Provider
 * Accounts page by #4906).
 *
 * The management-UI half of the secrets vault: list / add / remove node-local
 * provider API keys. Persistence goes through the server's createApiKeysRoutes,
 * which stores keys in settings.json (0600) and returns ONLY masked values
 * (RedactedApiKey) — the raw secret is sent once on add and never rendered after.
 *
 * SECURITY (PM-locked, #1955): the key <input> is type="password"; no code path
 * renders a stored secret after entry — only `maskedKey` from the API is shown.
 *
 * Full-width inside the drawer; does NOT attach its own useSwipeBack (SettingsDrawer
 * owns the single swipe-back handler). Does NOT touch NewSession/ — the future
 * Create-Session key selector (A3 #1950, SEAM-2) is separate, PM-owned work.
 */
export function ApiKeysSection() {
  const { api } = useAppContext();

  const { data: keys = [], isLoading } = useApiKeys(api);
  const { add, update, remove, validate } = useApiKeyActions(api);

  const [provider, setProvider] = useState<string>(API_KEY_PROVIDERS[0]);
  const [keyValue, setKeyValue] = useState("");
  const [label, setLabel] = useState("");
  const [pendingDelete, setPendingDelete] = useState<RedactedApiKey | null>(
    null
  );
  // Issue #5127: the add form's "Make available to all nodes" box (Anthropic
  // only) starts from the preference until touched; the per-key switch below
  // confirms before it stops sharing, and shows the server's refusal reason.
  const shareDefault = useShareApiKeysByDefault(api);
  const [shareNew, setShareNew] = useState(shareDefault.enabled);
  const shareTouchedRef = useRef(false);
  useEffect(() => {
    if (!shareTouchedRef.current) setShareNew(shareDefault.enabled);
  }, [shareDefault.enabled]);
  const [pendingUnshare, setPendingUnshare] = useState<RedactedApiKey | null>(
    null
  );
  const [shareErrors, setShareErrors] = useState<Record<string, string>>({});
  const setShared = async (key: RedactedApiKey, next: boolean) => {
    setShareErrors(prev => {
      const { [key.id]: _drop, ...rest } = prev;
      return rest;
    });
    try {
      await update.mutateAsync({
        id: key.id,
        body: { shareAcrossNodes: next },
      });
    } catch (err) {
      setShareErrors(prev => ({ ...prev, [key.id]: shareErrorMessage(err) }));
    }
  };

  const trimmedKey = keyValue.trim();
  // #5127 (code review F7): an Anthropic add waits for the share preference.
  const canSubmit =
    trimmedKey.length > 0 &&
    !add.isPending &&
    (provider !== "anthropic" ||
      shareDefault.loaded ||
      shareTouchedRef.current);

  // #3812: per-provider "Get your key" link, sourced from the shared registry.
  // `custom` (and any unknown id) yields `undefined` → no link renders.
  const providerKeyUrl = getApiKeyProviderUrl(provider);
  // gemini and google both open Google AI Studio (mirrors the server's
  // VALIDATION_ADAPTERS `google: geminiAdapter` alias) — note it in the copy.
  const sharesAiStudio = provider === "gemini" || provider === "google";

  const handleAdd = () => {
    if (!canSubmit) return;
    add.mutate(
      {
        provider: provider as (typeof API_KEY_PROVIDERS)[number],
        key: trimmedKey,
        ...(label.trim() ? { label: label.trim() } : {}),
        // #5127 (D7): an Anthropic add always says whether to share it.
        ...(provider === "anthropic" ? { shareAcrossNodes: shareNew } : {}),
      },
      {
        onSuccess: () => {
          setKeyValue("");
          setLabel("");
        },
      }
    );
  };

  return (
    <div data-testid="api-keys-section">
      <div className="flex flex-col gap-6">
        {/* Add form */}
        <section className="flex flex-col gap-3">
          <h2 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
            Add a key
          </h2>
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[length:var(--text-body)] text-[var(--app-hint)]">
              Provider
              <select
                value={provider}
                onChange={e => setProvider(e.target.value)}
                style={{ fontSize: "16px" }}
                className={INPUT_CLASS}
                data-testid="api-key-provider"
              >
                {API_KEY_PROVIDERS.map(p => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            {/* #3812: sibling link AFTER the label (never inside it — an anchor
                inside a <label> joins the control's accessible name / click
                semantics). Renders only when the provider has a key page. */}
            {providerKeyUrl && (
              <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                <a
                  href={providerKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--app-link)] underline"
                  data-testid="api-key-provider-link"
                >
                  Get your key
                </a>
                {sharesAiStudio
                  ? " — gemini and google both open Google AI Studio."
                  : ""}
              </p>
            )}
            <label className="flex flex-col gap-1 text-[length:var(--text-body)] text-[var(--app-hint)]">
              API key
              <input
                type="password"
                value={keyValue}
                onChange={e => setKeyValue(e.target.value)}
                placeholder="Paste the provider API key"
                autoComplete="off"
                style={{ fontSize: "16px" }}
                className={INPUT_CLASS}
                data-testid="api-key-value"
              />
            </label>
            <label className="flex flex-col gap-1 text-[length:var(--text-body)] text-[var(--app-hint)]">
              Label (optional)
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="e.g. personal OpenRouter"
                style={{ fontSize: "16px" }}
                className={INPUT_CLASS}
                data-testid="api-key-label"
              />
            </label>
            {provider === "anthropic" && (
              <ShareAcrossNodesCheckbox
                checked={shareNew}
                onChange={next => {
                  shareTouchedRef.current = true;
                  setShareNew(next);
                }}
              />
            )}
            <Button
              variant="accent"
              type="button"
              onClick={handleAdd}
              disabled={!canSubmit}
              className="h-auto self-start px-4 py-2 text-[length:var(--text-label-strong)] text-[var(--app-bg)]"
              data-testid="api-key-add"
            >
              {add.isPending ? "Adding…" : "Add key"}
            </Button>
            <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
              Stored on this node and masked after entry. An Anthropic key made
              available to all nodes can be used by sessions on your other
              nodes; every other key is used on this node only. Adding a key for
              a provider that already has one replaces it (Gemini keys are added
              as separate accounts).
            </p>
            {add.isError && (
              <p
                className="text-[length:var(--text-body)]"
                style={{ color: "var(--status-hot)" }}
                data-testid="api-key-error"
              >
                {/* #5127: a sharing refusal says why (e.g. federation off). */}
                {add.error instanceof ApiError &&
                (add.error.code === "share_unavailable" ||
                  add.error.code === "share_unsupported")
                  ? shareErrorMessage(add.error)
                  : "Failed to add key — please try again."}
              </p>
            )}
          </div>
        </section>

        {/* Stored keys list */}
        <section className="flex flex-col gap-3">
          <h2 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
            Stored keys
          </h2>
          {isLoading ? (
            <p className="text-[length:var(--text-label-strong)] text-[var(--app-hint)]">
              Loading…
            </p>
          ) : keys.length === 0 ? (
            <div
              className="flex flex-col items-center gap-2 rounded-md border border-dashed border-[var(--app-border)] px-4 py-8 text-center"
              data-testid="api-keys-empty"
            >
              <KeyRound className="h-6 w-6 text-[var(--app-hint)]" />
              <p className="text-[length:var(--text-label-strong)] text-[var(--app-fg)]">
                No API keys stored
              </p>
              <p className="text-[length:var(--text-body)] text-[var(--app-hint)]">
                Add a provider key above to get started.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2" role="list">
              {keys.map(k => {
                const meta = STATUS_META[k.status];
                const isValidating =
                  validate.isPending && validate.variables === k.id;
                return (
                  <li
                    key={k.id}
                    className="flex items-center gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2.5"
                    data-testid={`api-key-row-${k.id}`}
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-1.5 text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
                        <span className="truncate">
                          {k.label || k.provider}
                        </span>
                        {/* B4 (#1957): provenance — a key registered via the
                            conversational flow carries descriptor.source. */}
                        {k.descriptor?.source === "conversational" ? (
                          <span
                            className="flex-shrink-0 rounded-sm bg-[var(--app-hover)] px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-normal text-[var(--app-hint)]"
                            title="Registered conversationally via chat"
                            data-testid={`api-key-via-chat-${k.id}`}
                          >
                            via chat
                          </span>
                        ) : null}
                      </span>
                      <span className="truncate text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                        {k.provider} · {k.maskedKey}
                      </span>
                      <span
                        className="mt-0.5 flex items-center gap-1.5 text-[length:var(--text-body-dense)]"
                        style={{ color: meta.color }}
                        data-testid={`api-key-status-${k.id}`}
                        data-status={k.status}
                      >
                        <span
                          className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: meta.color }}
                          aria-hidden="true"
                        />
                        {meta.label}
                      </span>
                      {k.provider === "anthropic" && (
                        <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
                          <Checkbox
                            checked={k.shareAcrossNodes === true}
                            disabled={update.isPending}
                            aria-label={`Make ${k.label || k.maskedKey} available to all nodes`}
                            data-testid={`api-key-share-${k.id}`}
                            onChange={e => {
                              if (e.target.checked) void setShared(k, true);
                              else setPendingUnshare(k);
                            }}
                          />
                          All nodes
                        </label>
                      )}
                      {shareErrors[k.id] && (
                        <span
                          className="mt-0.5 text-[length:var(--text-body-dense)]"
                          style={{ color: "var(--status-hot)" }}
                          data-testid={`api-key-share-error-${k.id}`}
                        >
                          {shareErrors[k.id]}
                        </span>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => validate.mutate(k.id)}
                      disabled={validate.isPending}
                      className="h-auto shrink-0 px-2.5 py-1 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
                      data-testid={`api-key-validate-${k.id}`}
                    >
                      {isValidating ? "Validating…" : "Validate"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      onClick={() => setPendingDelete(k)}
                      aria-label={`Remove ${k.provider} key`}
                      className="shrink-0 rounded-md"
                      data-testid={`api-key-remove-${k.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Remove API key"
        description={
          pendingDelete
            ? `Remove the ${pendingDelete.provider} key${pendingDelete.label ? ` (${pendingDelete.label})` : ""}? This cannot be undone.`
            : ""
        }
        confirmLabel="Remove"
        confirmingLabel="Removing…"
        onConfirm={async () => {
          if (!pendingDelete) return;
          await remove.mutateAsync({
            id: pendingDelete.id,
            provider: pendingDelete.provider,
          });
          setPendingDelete(null);
        }}
        isPending={remove.isPending}
        destructive
      />

      <ConfirmDialog
        isOpen={pendingUnshare !== null}
        onClose={() => setPendingUnshare(null)}
        title="Stop sharing this key?"
        description={UNSHARE_CONFIRM_TEXT}
        confirmLabel="Stop sharing"
        confirmingLabel="Saving…"
        onConfirm={async () => {
          if (!pendingUnshare) return;
          const key = pendingUnshare;
          setPendingUnshare(null);
          await setShared(key, false);
        }}
        isPending={update.isPending}
      />
    </div>
  );
}
