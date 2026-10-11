// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
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
import { API_KEY_STATUS_META as STATUS_META } from "@/lib/apiKeyStatus";

const INPUT_CLASS =
  "rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)]";

/**
 * ApiKeysSection — the "API Keys" section of Settings → Keys (issue #1955,
 * epic #1954; folded from the former `/settings/api-keys` page by the Settings
 * sidebar reorganization).
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
  const { add, remove, validate } = useApiKeyActions(api);

  const [provider, setProvider] = useState<string>(API_KEY_PROVIDERS[0]);
  const [keyValue, setKeyValue] = useState("");
  const [label, setLabel] = useState("");
  const [pendingDelete, setPendingDelete] = useState<RedactedApiKey | null>(
    null
  );

  const trimmedKey = keyValue.trim();
  const canSubmit = trimmedKey.length > 0 && !add.isPending;

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
              Stored on this node only and masked after entry. Adding a key for
              a provider that already has one replaces it.
            </p>
            {add.isError && (
              <p
                className="text-[length:var(--text-body)]"
                style={{ color: "var(--status-hot)" }}
                data-testid="api-key-error"
              >
                Failed to add key — please try again.
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
                    className="flex items-center gap-3 rounded-md border border-[var(--app-border)] px-3 py-2.5"
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
                            className="flex-shrink-0 rounded-sm bg-[var(--app-secondary-bg)] px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-normal text-[var(--app-hint)]"
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
                    </div>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => validate.mutate(k.id)}
                      disabled={validate.isPending}
                      className="h-auto shrink-0 px-2.5 py-1 text-[length:var(--text-body-dense)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
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
                      className="shrink-0 rounded-md hover:bg-[var(--app-secondary-bg)]"
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
          await remove.mutateAsync(pendingDelete.id);
          setPendingDelete(null);
        }}
        isPending={remove.isPending}
        destructive
      />
    </div>
  );
}
