// SPDX-License-Identifier: AGPL-3.0-only

const CRUMB =
  "rounded px-1 py-0.5 hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors";

/**
 * issue #2518: clickable breadcrumb trail for the Browse view. #6224: the root
 * is named after the session folder, and under 640 px the middle segments
 * collapse into "…" so a deep path keeps the first folder and the current one
 * on one line. The collapse is CSS-only (`sm:` utilities), so every segment
 * stays in the DOM and reachable from the wider layout.
 */
export function Breadcrumbs(props: {
  path: string;
  rootLabel: string;
  onNavigate: (path: string) => void;
}) {
  const segments =
    props.path === "." || props.path === "" ? [] : props.path.split("/");
  const collapses = segments.length > 2;

  return (
    <nav
      aria-label="Folder path"
      className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-[var(--app-hint)]"
    >
      <button
        type="button"
        onClick={() => props.onNavigate(".")}
        title="Session folder"
        className={CRUMB}
      >
        {props.rootLabel}
      </button>
      {segments.map((seg, index) => {
        const target = segments.slice(0, index + 1).join("/");
        const middle = collapses && index > 0 && index < segments.length - 1;
        return (
          <span
            key={target}
            className={`items-center gap-1 ${middle ? "hidden sm:flex" : "flex"}`}
          >
            <span aria-hidden>/</span>
            <button
              type="button"
              onClick={() => props.onNavigate(target)}
              aria-current={index === segments.length - 1 ? "page" : undefined}
              className={CRUMB}
            >
              {seg}
            </button>
            {collapses && index === 0 ? (
              <span aria-hidden className="flex items-center gap-1 sm:hidden">
                <span>/</span>
                <span>…</span>
              </span>
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}
