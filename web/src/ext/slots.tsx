// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Slot renderer components (issue #1267, Sub-Issue C of epic #1264) — the
 * consumption side of the web extension host. Each component reads its slot from
 * the host via `useExtensionHost()` and renders every registered contribution in
 * deterministic (R5) order. When a slot has zero contributions the component
 * produces NO DOM nodes (R10).
 *
 * Four render, one is a symbolic no-op:
 * - `SessionDetailTabs` — minimal tab chrome + local active-tab state.
 * - `SessionDetailInfoFields` / `PreferencesSections` — flat list of components.
 * - `SessionDetailActions` — a button per action (specs carry `onClick`, not
 *   `render`).
 * - `NavigationRoutes` — symbolic no-op; real routes are consumed synchronously
 *   by `router.tsx` at module-eval (wiring owned by Sub-Issue F).
 */
import { Suspense, useState, type ComponentType } from "react";
import { useExtensionHost } from "./host";

/**
 * Narrowing assertion: A's slot specs carry a `render` field of opaque
 * `ToolViewLike` (= unknown). The web side narrows to a zero-prop React
 * component. Extensions pass `React.lazy(() => import("./MyTab"))` or a regular
 * component reference.
 */
type SlotRender = ComponentType;

/**
 * MINIMAL TAB CHROME (locked contract §8): a label row of clickable tabs + local
 * active-tab state. First tab (in R5 order) is active by default; only the
 * active tab's component mounts. `key={active.id}` forces a remount on switch so
 * per-tab state does not bleed across tabs. #1284's Notes tab depends on this
 * chrome — C owns the slot infrastructure.
 */
export function SessionDetailTabs() {
  const host = useExtensionHost();
  const tabs = host.getSessionDetailTabs();
  const [activeId, setActiveId] = useState<string | null>(null);
  if (tabs.length === 0) return null;
  const active = tabs.find(t => t.id === activeId) ?? tabs[0];
  const Render = active.render as SlotRender;
  return (
    <div>
      <div role="tablist">
        {tabs.map(spec => (
          <button
            key={spec.id}
            role="tab"
            type="button"
            aria-selected={spec.id === active.id}
            onClick={() => setActiveId(spec.id)}
          >
            {spec.label}
          </button>
        ))}
      </div>
      <Suspense fallback={null}>
        <Render key={active.id} />
      </Suspense>
    </div>
  );
}

export function SessionDetailInfoFields() {
  const host = useExtensionHost();
  const fields = host.getSessionDetailInfoFields();
  return (
    <>
      {fields.map(spec => {
        const Render = spec.render as SlotRender;
        return (
          <Suspense key={spec.id} fallback={null}>
            <Render />
          </Suspense>
        );
      })}
    </>
  );
}

export function SessionDetailActions() {
  const host = useExtensionHost();
  const actions = host.getSessionDetailActions();
  return (
    <>
      {actions.map(spec => (
        // Action specs carry `onClick: () => void | Promise<void>`, not `render`.
        // `void` discards the result so an async handler's rejection does not
        // surface as an unhandled render error. Sub-Issues T/U refine the chrome.
        <button
          key={spec.id}
          type="button"
          onClick={() => {
            void spec.onClick?.();
          }}
        >
          {spec.label}
        </button>
      ))}
    </>
  );
}

/**
 * SHIPS UNMOUNTED in C. Eventual consumer: #1040's `?section=preferences` drawer
 * view inside epic #1034's SettingsDrawer shell — that issue mounts
 * `<PreferencesSections />` when it builds the preferences drawer section.
 * Coordinate with #1040 before mounting anywhere else.
 */
export function PreferencesSections() {
  const host = useExtensionHost();
  const sections = host.getPreferenceSections();
  return (
    <>
      {sections.map(spec => {
        const Render = spec.render as SlotRender;
        return (
          <Suspense key={spec.id} fallback={null}>
            <Render />
          </Suspense>
        );
      })}
    </>
  );
}

/**
 * Symbolic no-op for API symmetry with the issue body's slot list. Real route
 * specs are consumed by `router.tsx` via `webExtensionHost.getNavigationRoutes()`
 * at module-evaluation time — a rendering component cannot register routes after
 * the route tree is built. Wiring is owned by Sub-Issue F.
 */
export function NavigationRoutes(): null {
  return null;
}
