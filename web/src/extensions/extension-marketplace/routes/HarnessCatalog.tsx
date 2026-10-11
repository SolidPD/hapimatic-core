// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `HarnessCatalog` — the CLI-harness catalog panel on the `/extensions` page (issue #3120,
 * epic #3117 Sub-D). Folded into `builtin.extension-marketplace` (ruling 1B-17 accepted
 * alternative) rather than a separate web extension.
 *
 * Lists each tier-1 CLI harness with its pinned + installed version and a license caveat badge,
 * and drives install / uninstall through the marketplace's approach-A subprocess routes:
 *   - install:   POST /api/ext/install          (`hapi ext install <id>` → the recipe)
 *   - uninstall: POST /api/ext/harness-uninstall (`hapi ext uninstall <id> --yes`)
 *   - version:   surfaced in the catalog payload (`hapi ext catalog` probes each recipe)
 *
 * Install is a blocking call returning the CLI's JSON, so the button shows an indeterminate
 * "Installing…" progress state (ruling D2 "lazy with progress UI").
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAppContext } from "@/lib/app-context";
import { ScanVerdict } from "@/components/settings/ScanVerdict";
import {
  runScanAwareInstall,
  verdictFromResponse,
  type InstallResponse,
  type InstallVars,
} from "./installScan";

interface HarnessEntry {
  id: string;
  displayName: string;
  method: string;
  pinnedVersion: string;
  license: string | null;
  driverBinding: string;
  installed: boolean;
  installedVersion: string | null;
}

interface HarnessCatalogResponse {
  ok: boolean;
  harnesses?: HarnessEntry[];
  error?: string;
  code?: string;
}

interface ActionResponse {
  ok: boolean;
  error?: string;
  code?: string;
}

/** OSI-permissive licenses render as neutral; everything else is a caveat badge (Crush, Grok…). */
const PERMISSIVE_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "ISC",
]);

function isLicenseCaveat(license: string | null): boolean {
  return license !== null && !PERMISSIVE_LICENSES.has(license);
}

export function HarnessCatalog() {
  const { api } = useAppContext();
  const queryClient = useQueryClient();
  // InstallResponse is a superset of ActionResponse — it also carries the #3131 scanVerdict.
  const [results, setResults] = useState<Record<string, InstallResponse>>({});

  const catalogQuery = useQuery({
    queryKey: ["ext-marketplace", "harness-catalog"],
    queryFn: () =>
      api.extensionRequest<HarnessCatalogResponse>("/api/ext/harness-catalog"),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: ["ext-marketplace", "harness-catalog"],
    });
  };

  const installMutation = useMutation({
    mutationFn: (vars: InstallVars) => runScanAwareInstall(api, vars),
    onSuccess: (result, vars) => {
      setResults(prev => ({ ...prev, [vars.id]: result }));
      invalidate();
    },
    onError: (err: Error, vars) =>
      setResults(prev => ({
        ...prev,
        [vars.id]: { ok: false, error: err.message },
      })),
  });

  const uninstallMutation = useMutation({
    mutationFn: (id: string) =>
      api.extensionRequest<ActionResponse>("/api/ext/harness-uninstall", {
        method: "POST",
        body: JSON.stringify({ id }),
      }),
    onSuccess: (result, id) => {
      setResults(prev => ({ ...prev, [id]: result }));
      invalidate();
    },
    onError: (err: Error, id) =>
      setResults(prev => ({
        ...prev,
        [id]: { ok: false, error: err.message },
      })),
  });

  const catalog = catalogQuery.data;
  const harnesses = catalog?.harnesses ?? [];

  return (
    <section className="mt-8" data-testid="harness-catalog">
      <h2 className="mb-1 text-base font-semibold text-foreground">
        CLI Harnesses
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Install additional AI coding CLIs as HAL harnesses. The stock 4 (Claude
        Code, Codex, Gemini, OpenCode) are baked in; these install on demand.
      </p>

      {catalogQuery.isLoading && (
        <p className="text-sm text-muted-foreground">
          Loading harness catalog…
        </p>
      )}

      {catalogQuery.isError && (
        <p className="text-sm text-red-400">
          Failed to load harness catalog:{" "}
          {(catalogQuery.error as Error).message}
        </p>
      )}

      {catalog && !catalog.ok && (
        <p className="text-sm text-red-400">
          Harness catalog error: {catalog.error}
          {catalog.code ? ` (${catalog.code})` : ""}
        </p>
      )}

      <ul className="space-y-3">
        {harnesses.map(h => {
          const result = results[h.id];
          const activeVars = installMutation.variables;
          const installing =
            installMutation.isPending && activeVars?.id === h.id;
          const uninstalling =
            uninstallMutation.isPending && uninstallMutation.variables === h.id;
          const busy = installing || uninstalling;
          const overriding = installing && Boolean(activeVars?.override);
          const verdict = result ? verdictFromResponse(result) : null;
          return (
            <li
              key={h.id}
              className="rounded-md border border-input p-4"
              data-testid={`harness-${h.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">
                      {h.displayName}
                    </span>
                    {h.license &&
                      (isLicenseCaveat(h.license) ? (
                        <span
                          className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-500"
                          title="License caveat — review before use"
                          data-testid={`harness-license-caveat-${h.id}`}
                        >
                          ⚠ {h.license}
                        </span>
                      ) : (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {h.license}
                        </span>
                      ))}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {h.id} · {h.method} · pinned {h.pinnedVersion} ·{" "}
                    {h.installed
                      ? `installed ${h.installedVersion ?? ""}`.trim()
                      : "not installed"}
                  </div>
                </div>
                <button
                  onClick={() =>
                    h.installed
                      ? uninstallMutation.mutate(h.id)
                      : installMutation.mutate({ id: h.id })
                  }
                  disabled={busy}
                  className="shrink-0 rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
                >
                  {installing
                    ? "Installing…"
                    : uninstalling
                      ? "Uninstalling…"
                      : h.installed
                        ? "Uninstall"
                        : "Install"}
                </button>
              </div>
              {/* Suppress the redundant scan_blocked error line — ScanVerdict shows it. */}
              {result && result.code !== "scan_blocked" && (
                <div
                  className={`mt-2 text-xs ${
                    result.ok ? "text-muted-foreground" : "text-red-400"
                  }`}
                >
                  {result.ok ? (
                    <>✅ Done.</>
                  ) : (
                    <>
                      ❌ {result.error}
                      {result.code ? ` (${result.code})` : ""}
                    </>
                  )}
                </div>
              )}
              {verdict && (
                <ScanVerdict
                  data={verdict}
                  onOverride={
                    verdict.verdict === "block" && !verdict.override
                      ? reason =>
                          installMutation.mutate({
                            id: h.id,
                            override: true,
                            overrideReason: reason,
                          })
                      : undefined
                  }
                  overriding={overriding}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
