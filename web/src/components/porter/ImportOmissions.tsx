// SPDX-License-Identifier: AGPL-3.0-only
import type { Omission } from "@hapi/protocol/porter";

/**
 * #4156 — the import review's omission lists, split out of
 * PorterImportPanel.tsx (its 1,500-line max-lines cap, #2077).
 *
 * Two groups, by PRODUCER rather than by parsing `surface` (the exporter's
 * `CLAUDE.md include @…` and the importer's `CLAUDE.md include …` share a
 * prefix): the importer's policy refusals (`summary.policySkips`), then
 * everything else (`summary.omissions` — the exporter's omissions and any
 * importer notice that is not a refusal).
 *
 * Rows are keyed by index: `surface` repeats by design (the exporter records
 * every missing include under one `claudeMd.include` surface, and several
 * `hooks` omissions), and each list is fixed for the life of a plan (the #2600
 * precedent for hook commands).
 */
function OmissionGroup({
  title,
  rows,
  testId,
}: {
  title: string;
  rows: readonly Omission[];
  testId: string;
}) {
  if (rows.length === 0) return null;
  return (
    <section data-testid={testId}>
      <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        {title}
      </h3>
      <ul className="flex flex-col gap-0.5 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        {rows.map((o, i) => (
          <li key={i}>
            <span className="font-medium text-[var(--app-fg)]">
              {o.surface}
            </span>{" "}
            — {o.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ImportOmissions({
  omissions,
  policySkips,
}: {
  omissions: readonly Omission[];
  policySkips: readonly Omission[];
}) {
  return (
    <>
      <OmissionGroup
        title="Refused by import policy"
        rows={policySkips}
        testId="import-policy-skips"
      />
      <OmissionGroup
        title="Deliberately omitted"
        rows={omissions}
        testId="import-omissions"
      />
    </>
  );
}
