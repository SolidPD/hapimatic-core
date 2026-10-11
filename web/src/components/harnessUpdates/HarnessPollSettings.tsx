// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from "@/api/client";
import { useHarnessPollConfig } from "@/hooks/queries/useHarnessPollConfig";
import { useHarnessActions } from "@/hooks/mutations/useHarnessActions";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Cadence presets (#1775, Sub-Issue F). All values are ≥ the server's 1h minimum,
 * so a change made through this control can never submit an abusive value (R2 is
 * unviolatable from the UI). Value is milliseconds; label is human-readable.
 */
const CADENCE_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1 * HOUR_MS, label: "Every hour" },
  { value: 6 * HOUR_MS, label: "Every 6 hours" },
  { value: 12 * HOUR_MS, label: "Every 12 hours" },
  { value: 24 * HOUR_MS, label: "Every 24 hours" },
  { value: 48 * HOUR_MS, label: "Every 2 days" },
];

const DEFAULT_CADENCE_MS = 24 * HOUR_MS;

/**
 * Poll-cadence settings control (#1775 Sub-Issue F — R2/R3/R5). A minimal preset
 * `<select>` bound to the persisted cadence: changing it persists via
 * `PUT /api/harness/poll-config` and takes effect on the next poll cycle without a
 * server restart (R3). Rendered ONCE at the panel level because v1's cadence is a
 * single global value (KD-2), not per-harness. Kept as its own component (mirroring
 * #1774's `HarnessUpdateActions`) so the panel edit stays a one-line render.
 */
export function HarnessPollSettings({ api }: { api: ApiClient | null }) {
  const { config, isLoading } = useHarnessPollConfig(api);
  const { setPollConfig, isSavingConfig } = useHarnessActions(api);

  // Snap the persisted cadence to a preset for the select's value. An off-grid
  // value (e.g. a hand-edit to settings.json) falls back to the 24h option so the
  // control always renders a sensible selection rather than an empty one.
  const current = config?.pollIntervalMs;
  const selected =
    current != null && CADENCE_PRESETS.some(p => p.value === current)
      ? current
      : DEFAULT_CADENCE_MS;

  const disabled = api == null || isLoading || isSavingConfig;

  return (
    <section
      data-testid="harness-poll-settings"
      className="flex flex-col gap-1.5 rounded-md border border-[var(--app-secondary-bg)] bg-[var(--app-secondary-bg)]/40 px-3 py-2.5"
    >
      <label
        htmlFor="harness-poll-cadence"
        className="text-[length:var(--text-body)] font-medium text-[var(--app-fg)]"
      >
        Check for updates
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id="harness-poll-cadence"
          data-testid="harness-poll-cadence-select"
          className="rounded-md border border-[var(--app-secondary-bg)] bg-[var(--app-bg)] px-2 py-1 text-[length:var(--text-body)] text-[var(--app-fg)] disabled:opacity-50"
          value={selected}
          disabled={disabled}
          onChange={e => {
            const ms = Number(e.target.value);
            if (Number.isFinite(ms)) void setPollConfig(ms);
          }}
        >
          {CADENCE_PRESETS.map(p => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        {isSavingConfig && (
          <span
            data-testid="harness-poll-saving"
            className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
          >
            Saving…
          </span>
        )}
      </div>
      <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        Minimum interval is 1 hour. Changes take effect on the next poll cycle.
      </p>
    </section>
  );
}
