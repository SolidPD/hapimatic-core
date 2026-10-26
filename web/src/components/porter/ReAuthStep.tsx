// SPDX-License-Identifier: AGPL-3.0-only
import type { PlannedMcpServerReview, SecretOverlay } from "@/types/porter";

/**
 * The import review's MCP re-authentication step (#3546, ADR-0006 Fork A) and
 * the helpers that build its commit-body overlay. Split out of
 * `PorterImportPanel.tsx` for the #2077 `max-lines` cap (#4247).
 */

/**
 * #4247: whether the review offers re-authentication for a server. The overlay
 * re-authorises only a server whose secrets could not be carried AND whose
 * command resolves on this machine; the commit refuses an overlay for an
 * unresolvable (#2640) or already-restored server with a 400. The re-auth card,
 * the commit overlay and the row's secret-source line all read this one rule.
 */
export function offersReAuth(
  s: Pick<PlannedMcpServerReview, "resolvable" | "secretRestorable">
): boolean {
  return s.resolvable && !s.secretRestorable;
}

/**
 * #4247: the servers the review shows a re-auth card for and may carry in the
 * commit overlay — the same list for both, so a card can never feed an entry
 * the commit refuses. A deselected server is dropped (deselect wins, #3546).
 */
export function reAuthCandidates(
  servers: PlannedMcpServerReview[],
  excluded: ReadonlySet<string>
): PlannedMcpServerReview[] {
  return servers.filter(s => offersReAuth(s) && !excluded.has(s.name));
}

/**
 * #3546 (ADR-0006 Fork A): the declared re-auth slots for a server as
 * `{ synthetic slotKey, human label }`. `slotKey` is the SYNTHETIC bundle key the
 * overlay is keyed by (`__args_<i>__`, `__url__`, an env key, a header key); the
 * label is display-only. The classifier over-detects (every env key / header is a
 * slot, e.g. `NODE_ENV`), which is why the wording is "values to supply".
 */
export function reAuthSlots(
  s: PlannedMcpServerReview
): { slotKey: string; label: string }[] {
  const out: { slotKey: string; label: string }[] = [];
  for (const a of s.argsNames ?? [])
    out.push({ slotKey: a.name, label: `args[${a.index}]` });
  if (s.urlName !== undefined) out.push({ slotKey: s.urlName, label: "url" });
  for (const e of s.envNames ?? []) out.push({ slotKey: e, label: `env.${e}` });
  for (const h of s.headerNames ?? [])
    out.push({ slotKey: h, label: `headers.${h}` });
  return out;
}

/**
 * #3546: build the commit-body overlay from the collected inputs. Includes a
 * server ONLY when it is a {@link reAuthCandidates} member and EVERY
 * declared slot has a non-blank value — so a partial fill is simply not re-authed
 * (stays excluded, exactly as today) rather than triggering the server's up-front
 * 400. Returns undefined when nothing is complete, so the commit body is
 * byte-identical to a no-re-auth import.
 */
export function buildCommitOverlay(
  servers: PlannedMcpServerReview[],
  overlay: SecretOverlay,
  excluded: Set<string>
): SecretOverlay | undefined {
  const out: SecretOverlay = {};
  for (const s of reAuthCandidates(servers, excluded)) {
    const slots = reAuthSlots(s);
    if (slots.length === 0) continue;
    const entered = overlay[s.name] ?? {};
    const complete = slots.every(
      sl => (entered[sl.slotKey] ?? "").trim().length > 0
    );
    if (!complete) continue;
    out[s.name] = Object.fromEntries(
      slots.map(sl => [sl.slotKey, entered[sl.slotKey]])
    );
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * #3546 (R2/R4): the pre-commit re-authentication step (ADR-0006 Fork A). Renders
 * one password input per declared secret slot for each server it is given (the
 * panel passes {@link reAuthCandidates}), keyed by the human label. Values feed the
 * `secretOverlay` carried ONCE in the commit body; they are never echoed to logs
 * and never placed in a URL. A deselected server's card disappears (its overlay
 * is dropped, matching the server's deselect-wins rule).
 */
export function ReAuthStep({
  servers,
  overlay,
  onChange,
}: {
  servers: PlannedMcpServerReview[];
  overlay: SecretOverlay;
  onChange: (server: string, slotKey: string, value: string) => void;
}) {
  if (servers.length === 0) return null;
  return (
    <section data-testid="reauth-step">
      <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        Re-authenticate MCP servers ({servers.length})
      </h3>
      <p className="pb-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        These servers were imported without their secrets. Enter the values to
        supply so they connect on this machine. Values are sent once with the
        import and are never stored or logged. Leave a server blank to skip it.
      </p>
      <div className="flex flex-col gap-3">
        {servers.map(s => {
          const slots = reAuthSlots(s);
          const entered = overlay[s.name] ?? {};
          const complete = slots.every(
            sl => (entered[sl.slotKey] ?? "").trim().length > 0
          );
          return (
            <div
              key={s.name}
              data-testid={`reauth-server-${s.name}`}
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2"
            >
              <div className="flex items-center justify-between pb-1">
                <span className="text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
                  {s.name}
                </span>
                <span
                  className={`text-[length:var(--text-caption)] ${
                    complete ? "text-ok" : "text-[var(--app-hint)]"
                  }`}
                  data-testid={`reauth-status-${s.name}`}
                >
                  {complete
                    ? "ready to re-auth"
                    : "supply all values to re-auth"}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {slots.map(sl => (
                  <label key={sl.slotKey} className="flex flex-col gap-0.5">
                    <span className="font-mono text-[length:var(--text-caption)] text-[var(--app-hint)]">
                      {sl.label}
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={entered[sl.slotKey] ?? ""}
                      onChange={e =>
                        onChange(s.name, sl.slotKey, e.target.value)
                      }
                      placeholder="value to supply"
                      data-testid={`reauth-input-${s.name}-${sl.slotKey}`}
                      className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
                    />
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
