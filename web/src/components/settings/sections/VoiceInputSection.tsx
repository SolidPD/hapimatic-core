// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Settings → Preferences → Voice input (issue #4707).
 *
 * Installs, configures and removes the on-node speech engine (NVIDIA Parakeet
 * via sherpa-onnx). Owns its own <section id="voice-input"> (deep-linked from
 * the composer's "not installed" message) and renders nothing when voice input
 * is unavailable on this node (the builtin.voice-input extension is disabled).
 */
import { useEffect, useState } from "react";
import { Mic } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { VoiceModelId, VoiceStatusResponse } from "@hapi/protocol/voice";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconSectionHeading } from "@/components/settings/IconSectionHeading";
import { useVoiceStatus } from "@/hooks/queries/useVoiceStatus";
import { queryKeys } from "@/lib/query-keys";
import { tokens } from "@/design/tokens";

function mb(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

export function describeVoiceState(status: VoiceStatusResponse): string {
  const minutes = Math.round(status.idleUnloadSeconds / 60);
  switch (status.state) {
    case "not_installed":
      // The install route answers before the install runs, so this is the
      // only place the user learns why an install failed.
      return status.error
        ? `Not installed. The last install failed: ${status.error}`
        : "Not installed.";
    case "installing":
      return "Installing…";
    case "installed":
      return `Installed. The engine loads when you use the mic and unloads after ${minutes} min without use.`;
    case "loading":
      return "Loading the speech engine…";
    case "loaded":
      return `Loaded (about 1.1 GB of memory). It unloads after ${minutes} min without use.`;
    case "error":
      return status.error ?? "The speech engine is unavailable.";
    default:
      return "";
  }
}

export function VoiceInputSection(props: { api: ApiClient | null }) {
  const { api } = props;
  const queryClient = useQueryClient();
  const { status } = useVoiceStatus(api);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [idleDraft, setIdleDraft] = useState("");

  useEffect(() => {
    if (status) setIdleDraft(String(Math.round(status.idleUnloadSeconds / 60)));
  }, [status?.idleUnloadSeconds]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!status || !api) return null;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.voiceStatus });

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const selected = status.models.find(m => m.id === status.model);
  const anyInstalled = status.models.some(m => m.installed);
  const unsupported =
    status.state === "error" && !anyInstalled && !status.install;
  const canInstall =
    !unsupported && status.state === "not_installed" && !status.install;
  const progress = status.install;
  const idleMinutes = Number(idleDraft);
  const idleValid =
    Number.isInteger(idleMinutes) && idleMinutes >= 1 && idleMinutes <= 60;

  return (
    <section
      id="voice-input"
      aria-label="Voice input"
      className="flex scroll-mt-2 flex-col gap-3 border-t border-[var(--app-border)] pt-6"
      data-testid="voice-input-section"
    >
      <IconSectionHeading
        icon={Mic}
        accent={tokens.accent}
        title="Voice input"
      />
      <p className="text-xs text-[var(--app-hint)]">
        Dictate into the prompt box with the mic button. Speech is transcribed
        on this node by a free speech engine — no account or cloud service, and
        audio never leaves the node. The microphone only works on an HTTPS
        address.
      </p>

      <p className="text-sm text-[var(--app-fg)]" data-testid="voice-state">
        {describeVoiceState(status)}
      </p>

      {progress ? (
        <div
          className="flex flex-col gap-1"
          data-testid="voice-install-progress"
        >
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--app-secondary-bg)]">
            <div
              className="h-full bg-[var(--app-link)] transition-[width]"
              style={{
                width: `${progress.bytesTotal > 0 ? Math.round((progress.bytesDone / progress.bytesTotal) * 100) : 0}%`,
              }}
            />
          </div>
          <p className="text-xs text-[var(--app-hint)]">
            {progress.phase} — {mb(progress.bytesDone)} of{" "}
            {mb(progress.bytesTotal)}
          </p>
        </div>
      ) : null}

      <label className="flex flex-col gap-1 text-sm text-[var(--app-fg)]">
        Speech model
        <select
          className="rounded-md bg-[var(--app-secondary-bg)] px-2 py-1 text-sm text-[var(--app-fg)] disabled:opacity-50"
          value={status.model}
          disabled={busy || Boolean(progress)}
          onChange={e =>
            void run(() =>
              api.updateVoiceSettings({ model: e.target.value as VoiceModelId })
            )
          }
          aria-label="Speech model"
        >
          {status.models.map(model => (
            <option key={model.id} value={model.id}>
              {model.label}
              {model.installed ? " — installed" : ""}
            </option>
          ))}
        </select>
      </label>

      {canInstall ? (
        <div className="flex flex-col gap-1">
          <Button
            variant="accent"
            size="dense"
            type="button"
            disabled={busy}
            onClick={() => void run(() => api.installVoiceEngine(status.model))}
            data-testid="voice-install"
            className="self-start disabled:opacity-40"
          >
            Install {selected?.label ?? "voice engine"}
          </Button>
          <p className="text-xs text-[var(--app-hint)]">
            Downloads about {mb((selected?.downloadBytes ?? 0) + 15_000_000)} to
            this node. While loaded the engine uses about 1.1 GB of memory.
          </p>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-[var(--app-fg)]">
          Unload after
          <input
            type="number"
            min={1}
            max={60}
            value={idleDraft}
            onChange={e => setIdleDraft(e.target.value)}
            className="w-16 rounded-md bg-[var(--app-secondary-bg)] px-2 py-1 text-sm tabular-nums text-[var(--app-fg)]"
            aria-label="Unload after minutes"
          />
          min without use
        </label>
        <Button
          variant="accent"
          size="dense"
          type="button"
          disabled={
            busy || !idleValid || idleMinutes * 60 === status.idleUnloadSeconds
          }
          onClick={() =>
            void run(() =>
              api.updateVoiceSettings({ idleUnloadSeconds: idleMinutes * 60 })
            )
          }
          className="disabled:opacity-40"
        >
          Apply
        </Button>
      </div>

      {anyInstalled ? (
        <Button
          variant="outline"
          size="dense"
          type="button"
          disabled={busy || Boolean(progress)}
          onClick={() => setConfirmRemove(true)}
          className="self-start disabled:opacity-40"
          data-testid="voice-remove"
        >
          Remove voice engine
        </Button>
      ) : null}

      {actionError ? (
        <p className="text-xs text-[var(--app-badge-error-text)]" role="alert">
          {actionError}
        </p>
      ) : null}

      <p className="text-xs text-[var(--app-hint)]">{status.attribution}</p>

      <ConfirmDialog
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove the voice engine?"
        description="This deletes the downloaded speech engine and models from this node (shared by all Hapimatic instances on it). You can install it again later."
        confirmLabel="Remove"
        confirmingLabel="Removing…"
        isPending={busy}
        destructive
        onConfirm={async () => {
          await api.removeVoiceEngine();
          setConfirmRemove(false);
          await refresh();
        }}
      />
    </section>
  );
}
