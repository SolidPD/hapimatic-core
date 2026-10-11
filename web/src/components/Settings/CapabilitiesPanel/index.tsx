// SPDX-License-Identifier: AGPL-3.0-only
import { Boxes } from "lucide-react";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useCapabilityCatalog } from "@/hooks/queries/useCapabilityCatalog";
import { useCapabilityAudit } from "@/hooks/queries/useCapabilityAudit";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { CoverageSummary } from "./CoverageSummary";
import { DomainGroup } from "./DomainGroup";
import type { AnnotatedCatalogEntry } from "@/types/capabilities";

/**
 * Capabilities panel — the `/settings/capabilities` route (issue #3752, Sub-Issue L
 * of epic #3740 / R5, R6).
 *
 * The human view of what the harness can do: coverage by surface, the live catalog
 * grouped by domain with per-caller availability, and drift lists — all from the
 * read-only `GET /api/capabilities/{catalog,audit}` routes.
 *
 * READ-ONLY + SERVER-COMPUTED (KD2/KD3): the panel invokes NOTHING and recomputes
 * NOTHING from manifests — the server hard-filters by scope (an out-of-scope
 * operator entry never reaches this browser) and annotates availability; this file
 * only GROUPS the returned entries by their `domain` field. Entry text renders as
 * React text nodes (EntryRow) and no entry field is interpolated into a URL/attr
 * sink. Sub-components (CoverageSummary / DomainGroup / EntryRow) are extracted to
 * clear the eslint `max-lines` cap (OR-4). The root owns `overflow-y-auto` for the
 * `check:settings-scroll` gate.
 *
 * NOTE: this lives under `web/src/components/Settings/` (per the directive) rather
 * than the usual `web/src/routes/settings/*.tsx` — a deliberate placement deviation.
 */
export default function CapabilitiesPanel() {
  useDocumentTitle("Capabilities - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();
  const {
    catalog,
    isLoading: catLoading,
    error: catError,
  } = useCapabilityCatalog(api);
  const {
    audit,
    isLoading: auditLoading,
    error: auditError,
  } = useCapabilityAudit(api);

  // Group the annotated catalog entries by their `domain` field (a pure view over
  // server-provided data — no availability recomputation). `rpc` is per-session
  // dynamic and shaped differently ({method, meta}), so it is summarized, not grouped.
  const grouped = new Map<string, AnnotatedCatalogEntry[]>();
  for (const entry of [
    ...(catalog?.rest ?? []),
    ...(catalog?.mcp ?? []),
    ...(catalog?.cli ?? []),
    ...(catalog?.ui ?? []),
  ]) {
    const list = grouped.get(entry.domain) ?? [];
    list.push(entry);
    grouped.set(entry.domain, list);
  }
  const domains = [...grouped.keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );

  const report = audit?.report ?? null;
  const isLoading = catLoading || auditLoading;
  const error = catError ?? auditError;

  return (
    <div
      data-testid="settings-capabilities-root"
      className="flex h-full flex-col overflow-y-auto"
    >
      <SettingsSectionHeader
        icon={<TitleChip icon={Boxes} accent="var(--accent-cyan)" />}
        title="Capabilities"
      />

      <div className="mx-auto w-full max-w-content">
        <div className="px-4 py-3">
          <p className="mb-3 text-[length:var(--text-body)] text-[var(--app-hint)]">
            Read-only view of what this harness can do — coverage by surface,
            the live capability catalog grouped by domain with availability for
            your session, and any drift between the committed index and the
            running surface. Nothing here invokes a capability.
          </p>

          {error ? (
            <p
              data-testid="capabilities-error"
              className="px-4 py-8 text-center text-[length:var(--text-body)] text-red-400"
            >
              Couldn't load capabilities: {error}
            </p>
          ) : isLoading && !catalog && !audit ? (
            <p
              data-testid="capabilities-loading"
              className="px-4 py-8 text-center text-[length:var(--text-body)] text-[var(--app-muted)]"
            >
              Loading capabilities…
            </p>
          ) : (
            <>
              {report ? <CoverageSummary report={report} /> : null}

              {report &&
              (report.reverseDrift.length > 0 ||
                report.forwardDrift.length > 0 ||
                report.schemaErrors.length > 0) ? (
                <section data-testid="capability-drift" className="mb-4">
                  <h2 className="mb-1 text-[length:var(--text-label-strong)] font-semibold text-[var(--app-fg)]">
                    Drift
                  </h2>
                  <ul className="space-y-0.5 text-[length:var(--text-caption)]">
                    {report.reverseDrift.map(d => (
                      <li
                        key={`rev-${d.surface}-${d.item}`}
                        className="font-mono text-[var(--app-muted)]"
                      >
                        reverse [{d.surface}] {d.item}
                      </li>
                    ))}
                    {report.forwardDrift.map(d => (
                      <li
                        key={`fwd-${d.id}`}
                        className="font-mono text-amber-400"
                      >
                        forward [{d.surface}] {d.id} ({d.reason})
                      </li>
                    ))}
                    {report.schemaErrors.map((d, i) => (
                      <li
                        key={`schema-${d.id ?? d.binding ?? i}`}
                        className="font-mono text-red-400"
                      >
                        schema {d.kind}: {d.ids.join(", ")}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section data-testid="capability-catalog-groups">
                <h2 className="mb-1 text-[length:var(--text-label-strong)] font-semibold text-[var(--app-fg)]">
                  Catalog
                </h2>
                {catalog && catalog.rpc.length > 0 ? (
                  <p
                    data-testid="capability-rpc-note"
                    className="mb-2 text-[length:var(--text-caption)] text-[var(--app-muted)]"
                  >
                    Plus {catalog.rpc.length} live RPC method(s) from connected
                    sessions.
                  </p>
                ) : null}
                {domains.length === 0 ? (
                  <p
                    data-testid="capability-catalog-empty"
                    className="text-[length:var(--text-body-dense)] text-[var(--app-muted)]"
                  >
                    No catalog entries visible for your scope.
                  </p>
                ) : (
                  domains.map(domain => (
                    <DomainGroup
                      key={domain}
                      domain={domain}
                      entries={grouped.get(domain) ?? []}
                    />
                  ))
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
