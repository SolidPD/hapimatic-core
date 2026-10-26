// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Capability-catalog domain model (issue #3741, Task 1 / R4).
 *
 * The fifteen capability domains — the epic Architecture Summary's twelve
 * (D1–D12), the `ui` domain (D13, ruled in by ER 2026-09-16 D14 because
 * Sub-Issue L (#3752) must give ~30 `router.tsx` entries a `domain` — and thus a
 * valid `id` prefix — and no other slug fits), and the `porter` domain (D14,
 * added by Sub-F.12 (#3833) for the config-porter REST surface, which has no
 * defensible slug among the twelve — F.1 OR-6), and the `notifications` domain
 * (D15, added by #4913 for the user notifications inbox REST surface).
 *
 * 🔒 AUTHORITATIVE SLUG SOURCE. These fifteen slugs are the single source of
 * truth for both the `id` prefix (schema R2) and the `domain` field. Sub-Issues
 * C/D/E/F/L CITE them — they must not be "confirmed" against or re-derived from
 * #3743/#3746, which name no slugs. No slug is a dotted prefix of another and
 * none contains a `.`, so the R2 "segment before the first `.`" rule is
 * unambiguous for all fifteen (OR-1).
 *
 * Shape mirrors `shared/src/effort.ts:15-16,24` (EFFORT_LEVELS tuple + derived
 * union + labels Record): a FLAT literal tuple is required so `schema.ts` can
 * feed it straight to `z.enum(DOMAIN_SLUGS)` (a `{slug,label}[]` array cannot
 * without a `[string, ...string[]]` cast that destroys the contract).
 */
export const DOMAIN_SLUGS = [
  "session-lifecycle", // D1 — session lifecycle
  "session-introspection", // D2 — session introspection
  "messaging", // D3 — messaging & queue
  "scheduler", // D4 — scheduler
  "federation", // D5 — peer orchestration / federation
  "accounts", // D6 — accounts & usage
  "model-permission", // D7 — model / permission / effort
  "mcp", // D8 — MCP control
  "files-git", // D9 — files / git / search
  "machine-daemon", // D10 — machine & daemon
  "telemetry", // D11 — telemetry & analytics
  "harness-admin", // D12 — harness & infra admin
  "ui", // D13 — web UI surfaces
  "porter", // D14 — configuration porter (Sub-F.12 #3833; F.1 OR-6: no slug among the twelve)
  "notifications", // D15 — user notifications inbox (#4913, epic #4912: no slug among the fourteen fits)
] as const;

export type DomainSlug = (typeof DOMAIN_SLUGS)[number];

/** Human-readable label per domain slug, for label-rendering consumers. */
export const DOMAIN_LABELS: Record<DomainSlug, string> = {
  "session-lifecycle": "Session lifecycle",
  "session-introspection": "Session introspection",
  messaging: "Messaging & queue",
  scheduler: "Scheduler",
  federation: "Peer orchestration & federation",
  accounts: "Accounts & usage",
  "model-permission": "Model / permission / effort",
  mcp: "MCP control",
  "files-git": "Files / git / search",
  "machine-daemon": "Machine & daemon",
  telemetry: "Telemetry & analytics",
  "harness-admin": "Harness & infra admin",
  ui: "Web UI surfaces",
  porter: "Configuration porter",
  notifications: "Notifications",
};

/**
 * Derived `{ slug, label }` list for label-rendering consumers (dropdowns,
 * per-domain coverage buckets). Derived from the tuple so it can never drift
 * from `DOMAIN_SLUGS` / `DOMAIN_LABELS`.
 */
export const DOMAINS: ReadonlyArray<{ slug: DomainSlug; label: string }> =
  DOMAIN_SLUGS.map(slug => ({ slug, label: DOMAIN_LABELS[slug] }));
