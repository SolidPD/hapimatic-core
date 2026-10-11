// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web entry point for `builtin.scheduler` (issue #1274, Sub-Issue J of epic
 * #1264).
 *
 * ## Why v0.1 contributes no slots
 *
 * The schedule UI is not a self-contained panel the host can mount. `router.tsx`
 * owns `editingSchedule` state, renders `ScheduleForm` inside a fullscreen
 * `<Dialog>`, and threads create/edit callbacks down through `SessionList`. The
 * v0.1 slot APIs (`navigation.addRoute`, `sessionDetail.addAction`) build their
 * route tree at module-eval time and cannot express that dialog interaction
 * model.
 *
 * So for v0.1 the router keeps importing the schedule UI directly — but from
 * `@/extensions/scheduler/...`, which makes the ownership boundary explicit even
 * though the wiring is still a plain import. Lifting the dialog into a real slot
 * contribution is deferred to a follow-up; when that happens, the
 * `host.navigation.addRoute` / `host.sessionDetail.addAction` calls land in
 * `register()` below.
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
  // navigation/action APIs can host the ScheduleForm dialog interaction.
};
