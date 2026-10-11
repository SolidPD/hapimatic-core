// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web entry point for `builtin.heartbeat` (issue #1275, Sub-Issue K of epic
 * #1264).
 *
 * ## Why v0.1 contributes no slots
 *
 * The heartbeat settings UI is not a self-contained panel the host can mount.
 * `router.tsx` owns `editingHeartbeat` state, renders `HeartbeatSettings` inside
 * a fullscreen `<Dialog>`, and `SchedulesPage` renders it inside its own view.
 * The v0.1 slot APIs (`preferences.addSection`, `navigation.addRoute`) build
 * their tree at module-eval time and cannot express that dialog interaction
 * model. This mirrors `builtin.scheduler`'s web half exactly (#1274).
 *
 * So for v0.1 the router keeps importing the heartbeat UI directly — but from
 * `@/extensions/heartbeat/...`, which makes the ownership boundary explicit even
 * though the wiring is still a plain import. Lifting the dialog into a real slot
 * contribution is deferred to a follow-up; when that happens, the
 * `host.preferences.addSection` call lands in `register()` below.
 *
 * ## Why this file deliberately re-exports nothing
 *
 * A barrel here would be the obvious convenience, but the loader reaches this
 * module through `import("./web")` — a dynamic import Vite uses to give every
 * extension its own chunk. A static import of the same module from `router.tsx`
 * would make Vite treat it as both statically and dynamically imported, collapse
 * the split, and warn at build time. Consumers therefore import the component
 * and hooks from their own paths, leaving this entry point purely lazy.
 */
import type { WebRegister } from "@hapi/protocol/ext";

/**
 * No-op registration for v0.1 — see the file docstring. The extension still
 * needs a `web` entry point so F's codegen emits it into the web registry and
 * the loader honors its `extension_prefs` enable state.
 */
export const register: WebRegister = async () => {
  // Intentionally empty. Slot contributions are deferred until the host's
  // preferences/navigation APIs can host the HeartbeatSettings dialog.
};
