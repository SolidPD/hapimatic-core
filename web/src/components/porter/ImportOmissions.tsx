// SPDX-License-Identifier: AGPL-3.0-only
import type { Omission } from "@hapi/protocol/porter";

/**
 * #4156 — the import review's omission lists, split out of
 * PorterImportPanel.tsx (its 1,500-line max-lines cap, #2077).
 *
 * Three groups, by PRODUCER rather than by parsing `surface` (the exporter's
 * `CLAUDE.md include @…` and the importer's `CLAUDE.md include …` share a
 * prefix): the importer's policy refusals (`summary.policySkips`), its notices
 * (`summary.notices`, #5202 U10), then everything else — `summary.omissions`
 * minus both. Since #5202 (U8) the server sends `omissions` complete so a
 * client that renders only `omissions` still shows every row; this component
 * subtracts the other two groups so each row renders once.
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

const rowKey = (o: Omission): string => `${o.surface}\0${o.reason}`;

/**
 * #5202 (U8): `rows` minus `remove`, as a multiset keyed on surface + reason.
 * Rows cross the wire as JSON, so identity is gone; and `surface` repeats by
 * design, so a plain Set would drop a legitimate duplicate — each row in
 * `remove` cancels exactly one matching row. Against a server that predates
 * #5202 (refusals already filtered out of `omissions`) nothing matches and
 * every row is kept.
 */
export function withoutRows(
  rows: readonly Omission[],
  remove: readonly Omission[]
): Omission[] {
  const pending = new Map<string, number>();
  for (const o of remove) {
    pending.set(rowKey(o), (pending.get(rowKey(o)) ?? 0) + 1);
  }
  return rows.filter(o => {
    const left = pending.get(rowKey(o)) ?? 0;
    if (left === 0) return true;
    pending.set(rowKey(o), left - 1);
    return false;
  });
}

export function ImportOmissions({
  omissions,
  policySkips,
  notices = [],
}: {
  omissions: readonly Omission[];
  policySkips: readonly Omission[];
  notices?: readonly Omission[];
}) {
  return (
    <>
      <OmissionGroup
        title="Refused by import policy"
        rows={policySkips}
        testId="import-policy-skips"
      />
      <OmissionGroup
        title="Imported with a note"
        rows={notices}
        testId="import-notices"
      />
      <OmissionGroup
        title="Deliberately omitted"
        rows={withoutRows(omissions, [...policySkips, ...notices])}
        testId="import-omissions"
      />
    </>
  );
}

/** #5202 (U12): the commit result's notes, in the review's notice style. */
export function ImportResultNotices({
  notices,
}: {
  notices: readonly Omission[];
}) {
  return (
    <OmissionGroup
      title="Imported with a note"
      rows={notices}
      testId="import-result-notices"
    />
  );
}
