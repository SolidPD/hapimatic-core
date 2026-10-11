// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web-side RUNTIME extension loader (issue #1294, epic #1264 Phase 2).
 *
 * The sibling `./loader.ts` loads BUILD-TIME (`builtin.*`) extensions from the
 * codegen registry — each `entryPoints.web()` is an `import()` THUNK Vite
 * code-splits at build time. This loader is the complement for FILESYSTEM
 * extensions the browser can't discover itself: it fetches the server's
 * `GET /api/ext-web-manifests` discovery list and, for each enabled entry,
 * injects its stylesheets and dynamic-imports its web entry from a RUNTIME URL
 * (`/ext-assets/<id>/dist/<entry>`) served by the server's `/ext-assets` route,
 * then invokes the module's `register(host)` — the SAME contract build-time
 * extensions use, against the SAME `webExtensionHost` singleton.
 *
 * Inert by default: with `HAPI_FS_EXTENSIONS` off, the discovery endpoint
 * returns `[]`, so this loads nothing (R6). Fail-soft throughout (R5): a failed
 * discovery fetch loads nothing; a per-extension import/register throw is logged,
 * its injected `<link>`s are removed, and the remaining extensions still load —
 * a broken extension never crashes the host app.
 *
 * Runs from `web/src/main.tsx` AFTER the build-time `loadWebExtensions` and
 * BEFORE `bootstrap()`, so both extension kinds populate the host before the app
 * boots.
 */
import { CapabilityGate } from "@hapi/protocol/ext";
import type {
  Capability,
  NavigationRouteSpec,
  PreferenceSectionSpec,
  SessionDetailActionSpec,
  SessionDetailInfoFieldSpec,
  SessionDetailTabSpec,
  ToolViewLike,
  WebExtensionHost,
} from "@hapi/protocol/ext";

/** One entry of the `GET /api/ext-web-manifests` payload (server: extWeb.ts). */
interface ExtWebManifestEntry {
  id: string;
  webEntry: string;
  styles: string[];
  enabled: boolean;
  /**
   * Declared privileged capabilities (issue #1291, ADR-0003). Optional for
   * server/client version-skew resilience; absent ⇒ default-deny (no privileged
   * capability). Server-validated against the taxonomy at manifest-parse time.
   */
  capabilities?: Capability[];
}

/**
 * Wrap the shared web host in a per-extension capability proxy (issue #1291,
 * ADR-0003). A runtime filesystem web extension is UNTRUSTED, so every privileged
 * contribution point (`toolViews.*`, `sessionDetail.*`, `preferences.*`,
 * `navigation.*`) is gated against its declared capabilities (default-deny). A
 * throwing `require` is caught by the per-extension fail-soft below, so a web
 * extension that overreaches is dropped without crashing the app.
 */
function gatedWebHost(
  host: WebExtensionHost,
  gate: CapabilityGate
): WebExtensionHost {
  return {
    toolViews: {
      addCompact: (toolName: string, view: ToolViewLike): void => {
        gate.require("ui.toolViews", "toolViews.addCompact");
        host.toolViews.addCompact(toolName, view);
      },
      addFullInput: (toolName: string, view: ToolViewLike): void => {
        gate.require("ui.toolViews", "toolViews.addFullInput");
        host.toolViews.addFullInput(toolName, view);
      },
      addResult: (toolName: string, view: ToolViewLike): void => {
        gate.require("ui.toolViews", "toolViews.addResult");
        host.toolViews.addResult(toolName, view);
      },
    },
    sessionDetail: {
      addTab: (spec: SessionDetailTabSpec): void => {
        gate.require("ui.sessionDetail", "sessionDetail.addTab");
        host.sessionDetail.addTab(spec);
      },
      addInfoField: (spec: SessionDetailInfoFieldSpec): void => {
        gate.require("ui.sessionDetail", "sessionDetail.addInfoField");
        host.sessionDetail.addInfoField(spec);
      },
      addAction: (spec: SessionDetailActionSpec): void => {
        gate.require("ui.sessionDetail", "sessionDetail.addAction");
        host.sessionDetail.addAction(spec);
      },
    },
    preferences: {
      addSection: (spec: PreferenceSectionSpec): void => {
        gate.require("ui.preferences", "preferences.addSection");
        host.preferences.addSection(spec);
      },
    },
    navigation: {
      addRoute: (spec: NavigationRouteSpec): void => {
        gate.require("ui.navigation", "navigation.addRoute");
        host.navigation.addRoute(spec);
      },
    },
  };
}

/** The module shape a filesystem web extension's entry point must export. */
interface WebExtensionModule {
  register: (host: WebExtensionHost) => Promise<void> | void;
}

export interface LoadRuntimeWebExtensionsDeps {
  /** Injectable for testing; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Injectable for testing; defaults to a runtime-URL dynamic import. The
   * Vite-ignore annotation on the default import is MANDATORY — without it
   * Rollup tries to resolve the runtime URL at build time and fails.
   */
  importImpl?: (url: string) => Promise<WebExtensionModule>;
}

/** Build the served URL for an extension's `dist/`-relative asset path. */
function extAssetUrl(id: string, distRelPath: string): string {
  // Strip a leading `./` so `dist/./web.js` doesn't appear in the URL.
  const clean = distRelPath.replace(/^\.\//, "");
  return `/ext-assets/${id}/dist/${clean}`;
}

/**
 * Discover and load every enabled runtime filesystem web extension into `host`.
 * Resolves once all discovered extensions have been attempted (fail-soft).
 */
export async function loadRuntimeWebExtensions(
  host: WebExtensionHost,
  deps: LoadRuntimeWebExtensionsDeps = {}
): Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;
  const doImport =
    deps.importImpl ??
    ((url: string) =>
      import(/* @vite-ignore */ url) as Promise<WebExtensionModule>);

  let entries: ExtWebManifestEntry[];
  try {
    const resp = await doFetch("/api/ext-web-manifests");
    if (!resp.ok) {
      console.warn(
        `[ext:runtimeLoader] discovery returned ${resp.status}; loading no runtime web extensions`
      );
      return;
    }
    entries = (await resp.json()) as ExtWebManifestEntry[];
  } catch (err) {
    // Fail-soft (R6): a failed discovery fetch → load nothing.
    console.warn(
      "[ext:runtimeLoader] failed to fetch /api/ext-web-manifests:",
      err
    );
    return;
  }

  for (const entry of entries) {
    // Defensive: the endpoint omits disabled extensions (R4), but re-check.
    if (!entry.enabled) continue;

    const injectedLinks: HTMLLinkElement[] = [];
    try {
      // Inject per-extension stylesheets keyed by id (R3).
      entry.styles.forEach((style, i) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.id = `ext-css-${entry.id}-${i}`;
        link.href = extAssetUrl(entry.id, style);
        document.head.appendChild(link);
        injectedLinks.push(link);
      });

      // Runtime-URL import + register (R2) — the first true runtime-URL import
      // in the codebase (distinct from build-time React.lazy code splits).
      // Register through a per-extension capability proxy (issue #1291): a
      // runtime web extension is UNTRUSTED, so its privileged UI contribution
      // points are default-deny gated against its declared capabilities.
      const gate = new CapabilityGate(entry.id, entry.capabilities ?? [], {
        trusted: false,
      });
      const mod = await doImport(extAssetUrl(entry.id, entry.webEntry));
      await mod.register(gatedWebHost(host, gate));
    } catch (err) {
      // Fail-soft isolation (R5): log, tear down this extension's injected
      // styles, keep the app and other extensions running.
      console.error(
        `[ext:runtimeLoader] failed to load web extension '${entry.id}':`,
        err
      );
      for (const link of injectedLinks) link.remove();
    }
  }
}
