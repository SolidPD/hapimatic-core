// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The label of each hook row in the import selection tree (#4331).
 *
 * Since #4331 a registered hook imports at its own path, so two hooks that share
 * a file name in different `hooks/` folders both reach the review. A leaf label
 * would show both as `run.py`, and the user could not tell which row drops
 * which hook. A hook under a subfolder, or one whose file name another hook in
 * the plan shares, is therefore labelled with its archive-relative path
 * (`hooks/a/run.py`, the path under the config root); a top-level hook with a
 * unique name keeps its file name.
 *
 * Keys are the hook rows' exclusion keys (the hook-file destPaths under
 * `claudeDir`). A key outside `claudeDir` keeps its full path, which is still
 * distinct.
 */
export function hookRowLabels(
  hookIds: readonly string[],
  claudeDir: string
): Map<string, string> {
  const root = claudeDir.replace(/\/+$/, "");
  const rel = (id: string): string =>
    root.length > 0 && id.startsWith(`${root}/`)
      ? id.slice(root.length + 1)
      : id;
  const leaf = (id: string): string =>
    id.split("/").filter(Boolean).pop() ?? id;
  const leafCount = new Map<string, number>();
  for (const id of new Set(hookIds)) {
    leafCount.set(leaf(id), (leafCount.get(leaf(id)) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const id of hookIds) {
    const path = rel(id);
    const nested = path.split("/").filter(Boolean).length > 2;
    const shared = (leafCount.get(leaf(id)) ?? 0) > 1;
    labels.set(id, nested || shared ? path : leaf(id));
  }
  return labels;
}
