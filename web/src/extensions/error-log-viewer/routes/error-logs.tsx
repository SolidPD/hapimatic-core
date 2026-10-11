// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `/error-logs` route page for `builtin.error-log-viewer` (issue #1279, Sub-Issue O of
 * epic #1264).
 *
 * Moved verbatim from `router.tsx`'s inline `ErrorLogsRoutePage`. `router.tsx`
 * static-imports this default export as `ErrorLogsPage` and wires it as the
 * `/error-logs` route component — mirroring `builtin.git-rpc`'s
 * `routes/files.tsx` (`FilesPage`). Core hooks (`useAppContext`, `useAppGoBack`,
 * `useDocumentTitle`, `useEmojiFavicon`) are imported from `@/…`; the viewer is
 * imported from its sibling in this extension.
 */
import { useAppContext } from "@/lib/app-context";
import { useAppGoBack } from "@/hooks/useAppGoBack";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { ErrorLogViewer } from "../ErrorLogViewer";

export default function ErrorLogsPage() {
  const { api } = useAppContext();
  const goBack = useAppGoBack();

  useDocumentTitle("Error Logs - Hapimatic");
  useEmojiFavicon(null);

  return <ErrorLogViewer api={api} onBack={goBack} />;
}
