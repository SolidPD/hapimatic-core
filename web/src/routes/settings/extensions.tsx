// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Puzzle, Store as StoreIcon } from "lucide-react";
import type { ExtensionRuntime, ExtensionSummary } from "@hapi/protocol/ext";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useExtensionRegistry } from "@/hooks/queries/useExtensionRegistry";
import { useExtensionPrefActions } from "@/hooks/mutations/useExtensionPrefActions";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { ChevronIcon } from "@/components/icons";

/**
 * CLI-harness extension id prefixes (issue #3313). A "CLI" entry is an agent
 * backend (`builtin.agent-*`) or a catalog harness (`catalog.harness-*`). These
 * are the entries grouped under the collapsible "CLIs" section (Task 4) and the
 * ones whose version render prefers the PROBED installed version over the flat
 * wrapper manifest `0.1.0` (Task 3). Every other extension keeps its meaningful
 * manifest version and its flat rendering.
 */
const CLI_ID_PREFIXES = ["builtin.agent-", "catalog.harness-"] as const;
function isCliExtension(id: string): boolean {
  return CLI_ID_PREFIXES.some(prefix => id.startsWith(prefix));
}

/**
 * Human label for each runtime chip.
 *
 * Keyed by `ExtensionRuntime` (not `string`) so the map is EXHAUSTIVE: adding a
 * fourth runtime to the union fails the build here instead of silently rendering
 * the raw key as a chip label.
 */
const RUNTIME_LABELS: Record<ExtensionRuntime, string> = {
  server: "Server",
  web: "Web",
  cli: "CLI",
};

/**
 * Per-runtime scope of a toggle (issue #2329, requirement R8).
 *
 * This is a DELIVERABLE, not filler. An Admin toggle that appears to work while a
 * runtime ignores it is a user-visible lie — worse than no toggle at all. Every
 * clause below is evidence-backed against the loaders:
 *
 *   - web  — `web/src/ext/loader.ts` reads `GET /api/extension-prefs` at bootstrap.
 *   - server — `server/src/ext/loader.ts` reads the store at boot; there is no
 *     teardown machinery in P1, so a change lands on restart.
 *   - cli  — `cli/src/ext/loader.ts:88-93` reads the SAME database via
 *     `readCliExtensionPref` (the §5g gap CLOSED by #1290), on every invocation.
 *   - daemon — `cli/src/daemon/sessionSpawner.ts` deep-imports the codex
 *     extension and never consults enablement (#2232 Gap 3).
 *
 * The two caveats are the OPEN halves of #2232. Three of the four clauses are
 * positive precisely because #2232's Gap 1 already closed — so this must not be
 * written as a blanket disclaimer that undersells what works.
 */
const RUNTIME_SCOPE: { runtime: string; effect: string; caveat?: string }[] = [
  { runtime: "Web", effect: "takes effect when you reload the page." },
  { runtime: "Server", effect: "takes effect on server restart." },
  {
    runtime: "CLI",
    effect: "takes effect on the next `hapi` invocation.",
    caveat:
      "A disabled agent extension's command name still launches Claude instead of erroring (e.g. `hapi codex`) — tracked in #2232.",
  },
  {
    runtime: "Daemon",
    effect: "does not yet honor enablement for codex spawn behavior.",
    caveat: "Tracked in #2232.",
  },
];

function RuntimeChips({ runtimes }: { runtimes: readonly ExtensionRuntime[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {runtimes.map(r => (
        <span
          key={r}
          className="rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium uppercase tracking-wide text-[var(--app-hint)]"
        >
          {RUNTIME_LABELS[r]}
        </span>
      ))}
    </span>
  );
}

function ExtensionRow(props: {
  ext: ExtensionSummary;
  pending: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { ext } = props;
  // `requiredAtBuild` short-circuits the enable check in all three loaders, so a
  // persisted `false` row would be inert. Render a disabled control with an
  // explicit reason — never a control that silently no-ops.
  const locked = ext.requiredAtBuild;

  // Task 3 (#3313): for a CLI entry the PRIMARY version is the probed installed
  // binary version (#1769); the wrapper manifest version (`0.1.0`) is demoted to
  // a detail line below and is NEVER promoted back to primary — a CLI with no
  // probed version shows an honest "version not detected" fallback (ruling
  // D4(a)/R3). Non-CLI extensions keep their meaningful manifest version.
  const isCli = isCliExtension(ext.id);
  const primaryVersion = isCli
    ? ext.probedVersion
      ? `v${ext.probedVersion}`
      : "version not detected"
    : `v${ext.version}`;

  return (
    <li className="flex items-start justify-between gap-3 border-b border-[var(--app-border)] py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-[var(--app-fg)]">
            {ext.displayName}
          </span>
          <RuntimeChips runtimes={ext.runtimes} />
        </div>
        <div
          className="mt-0.5 font-mono text-[length:var(--text-caption)] text-[var(--app-hint)]"
          data-testid={`ext-version-${ext.id}`}
        >
          {ext.id} · {primaryVersion}
        </div>
        {isCli && (
          <div className="font-mono text-[length:var(--text-caption-xs)] text-[var(--app-hint)] opacity-70">
            manifest v{ext.version}
          </div>
        )}
        <p className="mt-1 text-xs text-[var(--app-hint)]">{ext.description}</p>
        {locked && (
          <p
            className="mt-1 text-xs font-medium text-[var(--app-hint)]"
            data-testid={`ext-required-${ext.id}`}
          >
            Required — cannot be disabled. Core features depend on this
            extension, so it always loads.
          </p>
        )}
      </div>
      <label
        className={`flex flex-shrink-0 items-center gap-2 ${
          locked ? "cursor-not-allowed" : "cursor-pointer"
        }`}
      >
        <span className="text-xs text-[var(--app-hint)]">
          {ext.enabled ? "On" : "Off"}
        </span>
        <input
          type="checkbox"
          checked={ext.enabled}
          disabled={locked || props.pending}
          onChange={e => props.onToggle(e.target.checked)}
          aria-label={`${ext.displayName} enabled`}
          data-testid={`ext-toggle-${ext.id}`}
          className="h-5 w-5 accent-[var(--app-link)] disabled:opacity-40"
        />
      </label>
    </li>
  );
}

/**
 * ExtensionsAdminPage — the `/settings/extensions` route (issue #2329, Sub-Issue D
 * of epic #2325). The user-accessible control plane for the extension system
 * epic #1264 built.
 *
 * Reads `GET /api/extension-registry` (authenticated) rather than the pre-auth
 * `GET /api/extension-prefs`: the latter is built from the SERVER registry alone,
 * so it cannot see web-only or CLI-only extensions and carries no
 * `requiredAtBuild` flag.
 *
 * Distinct from `/extensions`, which is the COMMUNITY marketplace (browse +
 * install from a remote catalog). This page manages what is already in the build.
 *
 * Full-width inside the drawer; does NOT attach its own `useSwipeBack`
 * (SettingsDrawer owns the single swipe-back handler).
 */
export default function ExtensionsAdminPage() {
  const { api } = useAppContext();
  useDocumentTitle("Extensions - Hapimatic");
  useEmojiFavicon(null);
  const navigate = useNavigate();

  const {
    data: extensions = [],
    isLoading,
    isError,
  } = useExtensionRegistry(api);
  const { setEnabled } = useExtensionPrefActions(api);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Task 4 (#3313): CLI harnesses collapse under one "CLIs" group. Default
  // EXPANDED so the newly-probed versions are visible without an extra tap (the
  // whole point of the fix), while still decluttering the flat list.
  const [cliExpanded, setCliExpanded] = useState(true);

  // Partition: CLI harnesses (grouped, collapsible) vs everything else (flat).
  const cliExtensions = extensions.filter(e => isCliExtension(e.id));
  const otherExtensions = extensions.filter(e => !isCliExtension(e.id));

  const handleToggle = (ext: ExtensionSummary, next: boolean) => {
    // Belt-and-braces for R6. The control is already rendered `disabled`, and a
    // real browser emits no click for a disabled input — but the requirement is
    // that a requiredAtBuild extension is NEVER a control that silently no-ops,
    // so refuse structurally rather than relying on the attribute alone. (A
    // synthetic event — jsdom's `fireEvent.click`, an automation harness, or a
    // future refactor that drops `disabled` — would otherwise reach the server
    // and earn a 409.)
    if (ext.requiredAtBuild) return;
    setError(null);
    setPendingId(ext.id);
    setEnabled.mutate(
      { id: ext.id, enabled: next },
      {
        onError: (err: Error) => setError(err.message),
        onSettled: () => setPendingId(null),
      }
    );
  };

  return (
    <div
      data-testid="settings-extensions-root"
      className="h-full overflow-y-auto"
    >
      <SettingsSectionHeader
        icon={<TitleChip icon={Puzzle} accent="var(--accent-indigo-400)" />}
        title="Extensions"
      />
      <div className="mx-auto w-full max-w-content px-4 pb-6">
        {/* R8 — per-runtime scope. Deliberately above the toggles: the honest
            scope of a toggle is part of the control, not a footnote. */}
        <section className="mb-4 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3">
          <h2 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
            When a change takes effect
          </h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            {RUNTIME_SCOPE.map(s => (
              <li key={s.runtime} className="text-xs text-[var(--app-hint)]">
                <span className="font-medium text-[var(--app-fg)]">
                  {s.runtime}
                </span>{" "}
                — {s.effect}
                {s.caveat && (
                  <span className="block pl-3 text-[var(--app-hint)]">
                    ⚠️ {s.caveat}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* Marketplace link-through — a DIFFERENT surface from this page. */}
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate({ to: "/extensions" })}
          data-testid="ext-marketplace-link"
          className="mb-4 flex h-auto w-full items-center justify-start gap-2.5 whitespace-normal rounded-md px-3 py-2.5 text-left font-normal hover:bg-[var(--app-secondary-bg)]"
        >
          <StoreIcon className="h-4 w-4 flex-shrink-0 text-[var(--app-hint)]" />
          <span className="flex-1">
            <span className="block text-sm font-medium text-[var(--app-fg)]">
              Extension Marketplace
            </span>
            <span className="block text-xs text-[var(--app-hint)]">
              Browse and install community extensions
            </span>
          </span>
        </Button>

        <h2 className="flex items-center gap-2 pb-1 text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
          <Puzzle className="h-3.5 w-3.5" />
          Installed in this build
        </h2>

        {error && (
          <p className="mb-2 text-xs text-red-400" data-testid="ext-error">
            {error}
          </p>
        )}

        {isLoading && (
          <p className="py-3 text-sm text-[var(--app-hint)]">
            Loading extensions…
          </p>
        )}

        {isError && !isLoading && (
          <p className="py-3 text-sm text-red-400">
            Failed to load the extension registry.
          </p>
        )}

        {!isLoading && !isError && extensions.length === 0 && (
          <p className="py-3 text-sm text-[var(--app-hint)]">
            No extensions are composed into this build.
          </p>
        )}

        {/* Non-CLI extensions — flat list (unchanged rendering). */}
        {otherExtensions.length > 0 && (
          <ul className="flex flex-col" role="list">
            {otherExtensions.map(ext => (
              <ExtensionRow
                key={ext.id}
                ext={ext}
                pending={pendingId === ext.id}
                onToggle={next => handleToggle(ext, next)}
              />
            ))}
          </ul>
        )}

        {/* CLIs — one collapsible group (Task 4, #3313). The subheading IS the
            toggle: title + count + far-right chevron, mirroring the
            McpServersSection idiom. Uses BareButton (not a raw <button>) so the
            design-token gate's rawButton ratchet stays at this file's baseline. */}
        {cliExtensions.length > 0 && (
          <div>
            <BareButton
              type="button"
              onClick={() => setCliExpanded(v => !v)}
              aria-expanded={cliExpanded}
              data-testid="ext-clis-toggle"
              className="flex w-full items-center gap-2 border-t border-[var(--app-border)] pb-1 pt-3 text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)] hover:text-[var(--app-fg)]"
            >
              <span>CLIs</span>
              <span className="tabular-nums text-[var(--app-hint)]">
                {cliExtensions.length}
              </span>
              <ChevronIcon
                className="ml-auto h-3.5 w-3.5 text-[var(--app-hint)]"
                collapsed={!cliExpanded}
              />
            </BareButton>
            {cliExpanded && (
              <ul
                className="flex flex-col"
                role="list"
                data-testid="ext-clis-list"
              >
                {cliExtensions.map(ext => (
                  <ExtensionRow
                    key={ext.id}
                    ext={ext}
                    pending={pendingId === ext.id}
                    onToggle={next => handleToggle(ext, next)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
