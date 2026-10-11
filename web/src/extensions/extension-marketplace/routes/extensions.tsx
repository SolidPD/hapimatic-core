// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `/extensions` route page for `builtin.extension-marketplace` (issue #1292, PR-2).
 *
 * The browse + install UX. Static-imported by `router.tsx` (the proven live pattern —
 * `error-log-viewer` #1279, `analytics` #1282 — since v0.1 `navigation.addRoute` is unconsumed).
 * Fetches the metadata-only catalog from `GET /api/ext/catalog` and installs a selected extension
 * via `POST /api/ext/install` (approach A — the server re-invokes `hapi ext install <id>`).
 *
 * Uses the public `api.extensionRequest<T>()` passthrough — no core `ApiClient` method needed.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";

import { useAppContext } from "@/lib/app-context";
import { useAppGoBack } from "@/hooks/useAppGoBack";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import type { CommunityExtensionEntry } from "@hapi/protocol/ext";
import { ScanVerdict } from "@/components/settings/ScanVerdict";
import { HarnessCatalog } from "./HarnessCatalog";
import {
  runScanAwareInstall,
  verdictFromResponse,
  type InstallResponse,
  type InstallVars,
} from "./installScan";

interface CatalogResponse {
  ok: boolean;
  catalog?: CommunityExtensionEntry[];
  error?: string;
  code?: string;
}

export default function ExtensionMarketplacePage(props?: {
  onBack?: () => void;
}) {
  const { api } = useAppContext();
  const defaultGoBack = useAppGoBack();
  const goBack = props?.onBack ?? defaultGoBack;
  useDocumentTitle("Extension Marketplace - Hapimatic");

  // Per-extension install result (id → response). One install at a time in v0.
  const [results, setResults] = useState<Record<string, InstallResponse>>({});

  const catalogQuery = useQuery({
    queryKey: ["ext-marketplace", "catalog"],
    queryFn: () => api.extensionRequest<CatalogResponse>("/api/ext/catalog"),
  });

  const installMutation = useMutation({
    mutationFn: (vars: InstallVars) => runScanAwareInstall(api, vars),
    onSuccess: (result, vars) =>
      setResults(prev => ({ ...prev, [vars.id]: result })),
    onError: (err: Error, vars) =>
      setResults(prev => ({
        ...prev,
        [vars.id]: { ok: false, error: err.message },
      })),
  });

  const catalog = catalogQuery.data;
  const entries = catalog?.catalog ?? [];

  return (
    <div className="mx-auto max-w-content px-4 py-6">
      <header className="mb-4 flex items-center gap-3">
        <button
          onClick={goBack}
          className="rounded px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back
        </button>
        <h1 className="text-lg font-semibold text-foreground">
          Extension Marketplace
        </h1>
      </header>

      {/* R5 trust warning — extensions run at host privilege until sandboxing (#1291). */}
      <div className="mb-4 rounded-md border border-input bg-muted p-3 text-sm text-muted-foreground">
        <strong className="text-foreground">
          ⚠️ Extensions run at host privilege.
        </strong>{" "}
        Installed extensions execute in-process with no sandbox yet (see #1291)
        — only install extensions you trust. Signing proves provenance, not
        safety. Installed extensions load only when{" "}
        <code>HAPI_FS_EXTENSIONS</code> is enabled (default off); restart to
        activate.
      </div>

      {catalogQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Loading catalog…</p>
      )}

      {catalogQuery.isError && (
        <p className="text-sm text-red-400">
          Failed to load catalog: {(catalogQuery.error as Error).message}
        </p>
      )}

      {catalog && !catalog.ok && (
        <p className="text-sm text-red-400">
          Catalog error: {catalog.error}
          {catalog.code ? ` (${catalog.code})` : ""}
        </p>
      )}

      {catalog?.ok && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No extensions are listed in the catalog yet.
        </p>
      )}

      <ul className="space-y-3">
        {entries.map(ext => {
          const result = results[ext.id];
          const activeVars = installMutation.variables;
          const installing =
            installMutation.isPending && activeVars?.id === ext.id;
          const overriding = installing && Boolean(activeVars?.override);
          const verdict = result ? verdictFromResponse(result) : null;
          return (
            <li key={ext.id} className="rounded-md border border-input p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{ext.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {ext.id} · by {ext.publisher}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {ext.description}
                  </p>
                </div>
                <button
                  onClick={() => installMutation.mutate({ id: ext.id })}
                  disabled={installing}
                  className="shrink-0 rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
                >
                  {installing ? "Installing…" : "Install"}
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
                    <>
                      ✅ Installed
                      {result.version ? ` v${result.version}` : ""}.
                      {result.warnings?.length
                        ? " " + result.warnings.join(" ")
                        : ""}
                    </>
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
                            id: ext.id,
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

      {/* HAL catalog CLI harnesses (#3120) — folded into the marketplace page. */}
      <HarnessCatalog />
    </div>
  );
}
