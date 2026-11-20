// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ApiKeyCredit — one API key's credit, the same facts on every surface (issue
 * #6789): the Provider Accounts card (`ApiKeyCard`, editable: a tap opens the
 * budget dialog) and the Select Account picker's key rows (`ApiKeyRows` in
 * `AccountSelectorModal`, read-only: a tap opens the explanation).
 *
 * Both render from ONE pure function, `apiKeyCreditFacts`, so a fact cannot
 * reach one surface and miss the other. Every visible fact carries
 * `data-fact="<id>"` from {@link API_KEY_CREDIT_FACT_IDS}; the parity test
 * (`ApiKeyCreditParity.test.tsx`) renders the card and both pickers from that
 * list. The variants differ in exactly two ways: the `unset` word ("Set budget"
 * on the card, "No budget" elsewhere) and the meter, which the read-only
 * variant omits (its fact, the share of the starting balance left, is in the
 * explanation; DEC-1 rung 1).
 *
 * Sub-Issue H (#6796) consumes this contract: `ApiKeyCredit`,
 * `apiKeyCreditFacts` and the wire field `creditUnavailable`.
 */
import type { RedactedApiKey } from "@hapi/protocol/schemas";
import { Button } from "@/components/ui/button";
import { HoverTooltip } from "@/components/ui/tooltip";
import {
  budgetFraction,
  budgetLevel,
  daysUntil,
  formatShortDate,
  formatUsd,
  providerHasBudget,
  topUpPhrase,
  type BudgetLevel,
} from "@/lib/apiKeyBudget";
import { LEVEL_COLOR } from "./UsageBar";

/** A key as a surface knows it: the redacted view, plus where it is stored
 *  (the picker's `GET /api/api-keys/available` entries). */
export type ApiKeyCreditKey = RedactedApiKey & {
  local?: boolean;
  homeNodeLabel?: string;
};

export type ApiKeyCreditState =
  | "rejected"
  | "out-of-credit"
  | "budget"
  | "no-estimate"
  | "unset";

/** Every visible credit fact, by id: the ONE list both surfaces render from. */
export const API_KEY_CREDIT_FACT_IDS = [
  "remaining",
  "days",
  "rejected",
  "out-of-credit",
  "no-estimate",
  "unset",
  "use-first",
] as const;
export type ApiKeyCreditFactId = (typeof API_KEY_CREDIT_FACT_IDS)[number];

export type ApiKeyCreditFacts = {
  state: ApiKeyCreditState;
  /** The visible facts, in order, each with its id. */
  facts: Array<{ id: ApiKeyCreditFactId; text: string }>;
  /** The visible text, e.g. "≈$71.20", "10d", "Key rejected · 401",
   *  "No estimate" (a peer key names its node in the explanation, #6789 DEC-1
   *  rung 3). `unset` reads "No budget" (the card's editable
   *  variant says "Set budget"). */
  text: string[];
  /** The explanation: the tooltip, and part of the accessible name. */
  explanation: string;
  /** budget only: the meter (editable variant). */
  fraction?: number;
  /** budget only. */
  color?: string;
};

const ALERT_TEXT =
  "shrink-0 whitespace-nowrap text-[length:var(--text-body-dense)] font-semibold text-[var(--status-hot)]";
const QUIET_TEXT =
  "shrink-0 whitespace-nowrap text-[length:var(--text-body-dense)] font-normal text-[var(--app-hint)]";

/** The meter colour for a budget level (the account gauges' palette). */
const BUDGET_COLOR: Record<BudgetLevel, string> = LEVEL_COLOR;

const OUT_OF_CREDIT_EXPLANATION =
  "The provider answered that this key's credit balance is too low.";
const UNSET_EXPLANATION =
  "No budget is set for this key. Set one on Provider Accounts.";

const withIds = (
  facts: Array<{ id: ApiKeyCreditFactId; text: string }>
): Pick<ApiKeyCreditFacts, "facts" | "text"> => ({
  facts,
  text: facts.map(f => f.text),
});

/**
 * The key's credit facts, first match wins: rejected; out of credit; a budget
 * reading; no estimate (the server said so, or a budget or top-up has no
 * reading — never "No budget" for it); no budget on a paid-credit key; else
 * nothing (a Gemini key shows no credit).
 */
export function apiKeyCreditFacts(
  key: ApiKeyCreditKey,
  nowMs: number
): ApiKeyCreditFacts | null {
  if (key.status === "invalid") {
    const code = key.lastValidation?.httpStatus;
    return {
      state: "rejected",
      ...withIds([
        {
          id: "rejected",
          text: code ? `Key rejected · ${code}` : "Key rejected",
        },
      ]),
      explanation: code
        ? `The provider refused this key at its last check (HTTP ${code}).`
        : "The provider refused this key at its last check.",
    };
  }
  if (key.outOfCredit) {
    return {
      state: "out-of-credit",
      ...withIds([{ id: "out-of-credit", text: "Out of credit" }]),
      explanation: OUT_OF_CREDIT_EXPLANATION,
    };
  }
  const status = key.budgetStatus;
  if (status) {
    const fraction = budgetFraction(status);
    const days = daysUntil(status.nextTopUpAt, nowMs);
    const explanation = [
      `≈ ${formatUsd(status.remainingUsd)} left of ${formatUsd(
        status.periodStartBalanceUsd
      )}`,
      `estimated from ${formatUsd(status.spentUsd)} Hapimatic metered on this key since ${formatShortDate(
        status.periodStart
      )}`,
      status.nextTopUpAt
        ? `next top-up ${formatShortDate(status.nextTopUpAt)}`
        : null,
      key.budgetRecurrence ? topUpPhrase(key.budgetRecurrence) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      state: "budget",
      ...withIds([
        { id: "remaining", text: `≈${formatUsd(status.remainingUsd)}` },
        ...(days !== null ? [{ id: "days" as const, text: `${days}d` }] : []),
      ]),
      explanation,
      fraction,
      color: BUDGET_COLOR[budgetLevel(fraction)],
    };
  }
  if (
    key.creditUnavailable ||
    key.budget !== undefined ||
    key.budgetRecurrence !== undefined
  ) {
    const node =
      key.local === false && key.homeNodeLabel ? key.homeNodeLabel : null;
    return {
      state: "no-estimate",
      // DEC-1 rung 3 (#6789): the visible words are "No estimate" for every
      // key, so a peer key's row fits on a phone; the node is in the
      // explanation (the tooltip and the accessible name), and the row's name
      // already reads "· <node>".
      ...withIds([{ id: "no-estimate", text: "No estimate" }]),
      explanation: node
        ? `Hapimatic could not estimate this key's credit, on ${node}.`
        : "Hapimatic could not estimate this key's credit.",
    };
  }
  if (providerHasBudget(key.provider)) {
    return {
      state: "unset",
      ...withIds([{ id: "unset", text: "No budget" }]),
      explanation: UNSET_EXPLANATION,
    };
  }
  return null;
}

/** "Key rejected · 401 · The provider refused …": a credit's accessible name. */
export function apiKeyCreditLabel(facts: ApiKeyCreditFacts): string {
  return `${facts.text.join(" ")} · ${facts.explanation}`;
}

/** The amount and the days, sized to their text in the read-only variant. */
function BudgetFigures(props: { facts: ApiKeyCreditFacts; readOnly: boolean }) {
  const { facts, readOnly } = props;
  const remaining = facts.facts.find(f => f.id === "remaining");
  const days = facts.facts.find(f => f.id === "days");
  return (
    <>
      {readOnly ? null : (
        <span
          aria-hidden="true"
          className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-[var(--app-subtle-bg)] sm:block"
        >
          <span
            className="block h-full rounded-full"
            style={{
              width: `${(facts.fraction ?? 0) * 100}%`,
              backgroundColor: facts.color,
            }}
          />
        </span>
      )}
      <span
        data-fact="remaining"
        className={`shrink-0 whitespace-nowrap text-right text-[length:var(--text-body-dense)] font-bold tabular-nums${
          readOnly ? "" : " sm:min-w-16"
        }`}
        style={{ color: facts.color }}
      >
        <span className="font-normal text-[var(--app-hint)]">≈</span>
        {remaining?.text.replace(/^≈/, "")}
      </span>
      {days ? (
        <span
          data-fact="days"
          className={`shrink-0 text-right text-[length:var(--text-caption-xs)] tabular-nums text-[var(--app-hint)]${
            readOnly ? "" : " w-8"
          }`}
        >
          {days.text}
        </span>
      ) : null}
    </>
  );
}

export type ApiKeyCreditProps = {
  apiKey: ApiKeyCreditKey;
  nowMs: number;
  /** Editable variant (the card): a tap opens the budget dialog. Absent ⇒
   *  read-only (the picker, and the card without an API client). */
  onEdit?: () => void;
};

/** One key's credit, editable on the card, read-only everywhere else. */
export function ApiKeyCredit({ apiKey, nowMs, onEdit }: ApiKeyCreditProps) {
  const facts = apiKeyCreditFacts(apiKey, nowMs);
  if (!facts) return null;
  return onEdit ? (
    <EditableCredit facts={facts} onEdit={onEdit} />
  ) : (
    <ReadOnlyCredit facts={facts} />
  );
}

/**
 * The picker's credit: a span outside the row's select button (a tap opens the
 * explanation and never selects the key), `role="img"` so its accessible name
 * is announced, the explanation in a `HoverTooltip` (tap-to-reveal on a phone).
 * Its click is never stopped: on a touch tap, Radix closes the bubble already
 * open only once the tap's click reaches `document`, so a stopped click left
 * two bubbles open at once.
 */
function ReadOnlyCredit({ facts }: { facts: ApiKeyCreditFacts }) {
  const budget = facts.state === "budget";
  const only = facts.facts[0];
  return (
    <HoverTooltip content={facts.explanation}>
      <span
        data-testid="api-key-credit"
        data-state={facts.state}
        role="img"
        aria-label={apiKeyCreditLabel(facts)}
        className={
          budget
            ? "flex shrink-0 items-center gap-2"
            : facts.state === "rejected" || facts.state === "out-of-credit"
              ? ALERT_TEXT
              : QUIET_TEXT
        }
      >
        {budget ? (
          <BudgetFigures facts={facts} readOnly />
        ) : only ? (
          <span data-fact={only.id}>{only.text}</span>
        ) : null}
      </span>
    </HoverTooltip>
  );
}

/** The card's credit: today's DOM (#6225), with the explanation added to the
 *  states that had none (the tooltip rule). */
function EditableCredit({
  facts,
  onEdit,
}: {
  facts: ApiKeyCreditFacts;
  onEdit: () => void;
}) {
  const only = facts.facts[0];
  const common = {
    type: "button" as const,
    variant: "ghostStatic" as const,
    size: "bare" as const,
    "data-testid": "api-key-credit",
    "data-state": facts.state,
    onClick: onEdit,
    onPointerDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  };
  switch (facts.state) {
    case "rejected":
      // A credit cannot revive a revoked key: the column stays inert.
      return (
        <span
          data-testid="api-key-credit"
          data-state="rejected"
          data-fact="rejected"
          title={facts.explanation}
          aria-label={apiKeyCreditLabel(facts)}
          className={ALERT_TEXT}
        >
          {only?.text}
        </span>
      );
    case "out-of-credit":
      // An empty key is exactly the one the operator needs to top up, so the
      // column opens the budget dialog like every other budget state.
      return (
        <Button
          {...common}
          data-fact="out-of-credit"
          title={`${facts.explanation} Tap to enter the credit you added.`}
          aria-label={`Out of credit: enter the credit you added. ${facts.explanation}`}
          className={`${ALERT_TEXT} hover:opacity-80`}
        >
          Out of credit
        </Button>
      );
    case "budget":
      return (
        <Button
          {...common}
          title={facts.explanation}
          aria-label={`Budget: ${facts.explanation}`}
          className="flex shrink-0 items-center gap-2 font-normal hover:opacity-80"
        >
          <BudgetFigures facts={facts} readOnly={false} />
        </Button>
      );
    case "no-estimate":
      return (
        <Button
          {...common}
          data-fact="no-estimate"
          title={facts.explanation}
          aria-label={`${only?.text}: ${facts.explanation}`}
          className={`${QUIET_TEXT} hover:text-[var(--app-accent)]`}
        >
          {only?.text}
        </Button>
      );
    case "unset":
      return (
        <Button
          {...common}
          data-fact="unset"
          title={facts.explanation}
          aria-label={`Set budget: ${facts.explanation}`}
          className="shrink-0 text-[length:var(--text-body-dense)] font-normal hover:text-[var(--app-accent)]"
        >
          Set budget
        </Button>
      );
  }
}

const USE_FIRST_REASON =
  "Spend this key first: its credit is the most at risk of expiring unused.";

/** The "spend this key first" marker (`pickUseFirstKeyId`), on the card and
 *  the picker. Its reason is a tooltip, because a `title` is never seen on iOS.
 *  Its click is never stopped, for the reason `ReadOnlyCredit` gives. */
export function UseFirstChip() {
  return (
    <HoverTooltip content={USE_FIRST_REASON}>
      <span
        data-testid="api-key-use-first"
        data-fact="use-first"
        aria-label={`Use first: ${USE_FIRST_REASON}`}
        className="inline-flex shrink-0 items-center rounded-full border border-[color-mix(in_srgb,var(--app-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--app-accent)_12%,transparent)] px-1.5 py-0 text-[length:var(--text-caption-xs)] font-semibold leading-none text-[var(--app-accent)]"
      >
        Use first
      </span>
    </HoverTooltip>
  );
}
