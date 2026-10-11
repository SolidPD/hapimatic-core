// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `WebExtensionHostImpl` — the web-side extension host (issue #1267, Sub-Issue C
 * of epic #1264). A React-context facade over the frontend contribution points
 * from `@hapi/protocol/ext` (`WebExtensionHost`).
 *
 * Two surfaces on one class:
 * - **Registration** (the `WebExtensionHost` interface): `toolViews.add*`,
 *   `sessionDetail.add*`, `preferences.addSection`, `navigation.addRoute`. This
 *   is what Sub-Issue F's loader hands each extension's `register(host)`.
 * - **Consumption** (internal accessors NOT on the interface): `get*ToolView`,
 *   `getSessionDetail*`, `getPreferenceSections`, `getNavigationRoutes`. Read by
 *   the slot renderer components (`slots.tsx`), the seeded ToolCard getters
 *   (`_all.tsx` / `_results.tsx`), `router.tsx` (navigation), and tests.
 *
 * The singleton {@link webExtensionHost} is the canonical host; the ToolCard
 * registries seed their built-ins into it at module load (R9), and Sub-Issue F's
 * loader passes the same instance to each extension. Tests inject a fresh
 * instance via the provider's `host` prop for isolation.
 */
import type { ComponentType, ReactNode } from "react";
import { createContext, useContext } from "react";
import type {
  NavigationRouteSpec,
  PreferenceSectionSpec,
  SessionDetailActionSpec,
  SessionDetailInfoFieldSpec,
  SessionDetailTabSpec,
  WebExtensionHost,
} from "@hapi/protocol/ext";
import type { ToolCallBlock } from "@/chat/types";
import type { SessionMetadataSummary } from "@/types/api";

/**
 * Props every tool-view component receives. Web-only (references web chat-block
 * types), so post the `builtin.tool-views` migration (#1277) this is the
 * canonical type home: the extension's view files and the core
 * `GenericResultView` shim both import `ToolViewProps` from `@/ext/host`.
 */
export type ToolViewProps = {
  block: ToolCallBlock;
  metadata: SessionMetadataSummary | null;
};

/** A tool-view component: `(props: ToolViewProps) => ReactNode`. */
export type ToolViewComponent = ComponentType<ToolViewProps>;

/**
 * Web narrowing of A's opaque `ToolViewLike = unknown` type. Extensions pass
 * React components (or `React.lazy()` results) at the `host.toolViews.add*` call
 * site; this type asserts the narrowing the web layer performs.
 */
type WebToolViewComponent = ComponentType<ToolViewProps>;

/**
 * Sort a spec list deterministically: ascending `order` (absent = `Infinity`),
 * ties broken by `id.localeCompare` (R5). Returns a new array — the internal
 * spec arrays are never mutated by callers.
 */
function sortedByOrder<T extends { id: string; order?: number }>(
  specs: readonly T[]
): readonly T[] {
  return [...specs].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    return a.id.localeCompare(b.id);
  });
}

export class WebExtensionHostImpl implements WebExtensionHost {
  private readonly compactViews = new Map<string, WebToolViewComponent>();
  private readonly fullViews = new Map<string, WebToolViewComponent>();
  private readonly resultViews = new Map<string, WebToolViewComponent>();
  private readonly tabs: SessionDetailTabSpec[] = [];
  private readonly infoFields: SessionDetailInfoFieldSpec[] = [];
  private readonly actions: SessionDetailActionSpec[] = [];
  private readonly preferenceSections: PreferenceSectionSpec[] = [];
  private readonly routes: NavigationRouteSpec[] = [];

  // ---- registration surface (the WebExtensionHost interface) ----
  // Arrow-function fields (not methods) so destructuring preserves `this`.

  readonly toolViews = {
    addCompact: (toolName: string, view: unknown): void => {
      this.compactViews.set(toolName, view as WebToolViewComponent);
    },
    addFullInput: (toolName: string, view: unknown): void => {
      this.fullViews.set(toolName, view as WebToolViewComponent);
    },
    addResult: (toolName: string, view: unknown): void => {
      this.resultViews.set(toolName, view as WebToolViewComponent);
    },
  };

  readonly sessionDetail = {
    addTab: (spec: SessionDetailTabSpec): void => {
      this.tabs.push(spec);
    },
    addInfoField: (spec: SessionDetailInfoFieldSpec): void => {
      this.infoFields.push(spec);
    },
    addAction: (spec: SessionDetailActionSpec): void => {
      this.actions.push(spec);
    },
  };

  readonly preferences = {
    addSection: (spec: PreferenceSectionSpec): void => {
      this.preferenceSections.push(spec);
    },
  };

  readonly navigation = {
    addRoute: (spec: NavigationRouteSpec): void => {
      this.routes.push(spec);
    },
  };

  // ---- consumption surface (internal accessors, NOT on the interface) ----

  getCompactToolView(toolName: string): WebToolViewComponent | null {
    return this.compactViews.get(toolName) ?? null;
  }
  getFullToolView(toolName: string): WebToolViewComponent | null {
    return this.fullViews.get(toolName) ?? null;
  }
  getResultToolView(toolName: string): WebToolViewComponent | null {
    return this.resultViews.get(toolName) ?? null;
  }
  getSessionDetailTabs(): readonly SessionDetailTabSpec[] {
    return sortedByOrder(this.tabs);
  }
  getSessionDetailInfoFields(): readonly SessionDetailInfoFieldSpec[] {
    return sortedByOrder(this.infoFields);
  }
  getSessionDetailActions(): readonly SessionDetailActionSpec[] {
    return sortedByOrder(this.actions);
  }
  getPreferenceSections(): readonly PreferenceSectionSpec[] {
    return sortedByOrder(this.preferenceSections);
  }
  getNavigationRoutes(): readonly NavigationRouteSpec[] {
    return sortedByOrder(this.routes);
  }
}

/**
 * Module-level singleton — the canonical web extension host. The ToolCard
 * registry seeders register built-in views into this instance at module load,
 * and Sub-Issue F's loader passes it to each extension's `register(host)`.
 */
export const webExtensionHost: WebExtensionHostImpl =
  new WebExtensionHostImpl();

const ExtensionHostContext =
  createContext<WebExtensionHostImpl>(webExtensionHost);

export function ExtensionHostProvider(props: {
  host?: WebExtensionHostImpl;
  children: ReactNode;
}) {
  return (
    <ExtensionHostContext.Provider value={props.host ?? webExtensionHost}>
      {props.children}
    </ExtensionHostContext.Provider>
  );
}

export function useExtensionHost(): WebExtensionHostImpl {
  return useContext(ExtensionHostContext);
}
