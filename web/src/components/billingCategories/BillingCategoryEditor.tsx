// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6779 (plan section 6, O7 = a): Add / Edit a billing category in a
 * centered dialog, as `AccountMonogramEditor` does.
 *
 * Money rules (Task 1, PR2-R3, PR2-R3a): a rate is parsed only with
 * `parseRateInput` and shown only with `formatRateMinor`, and neither is ever
 * handed a code `isBillingCurrency` refuses. Such a code stays the selected
 * option, the amount field cannot be typed in until a known currency is picked,
 * and the stored rate is written only when the person saves a new one.
 */
import { useState, type FormEvent } from "react";
import {
  BILLING_CATEGORY_NAME_MESSAGES,
  billingCurrencies,
  currencyMinorDigits,
  normalizeBillingCategoryName,
  formatRateMinor,
  isBillingCurrency,
  parseRateInput,
  type BillingCategoryListItem,
  type BillingRate,
  type RateInputRefusal,
} from "@hapi/protocol";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/button";
import {
  billingCategoryFailureMessage,
  billingCategoryFieldMessage,
  type BillingCategoryWriteOutcome,
  type BillingCategoryWriteRequest,
} from "@/hooks/queries/useBillingCategories";
import { unknownCurrencyTitle } from "./BillingCategoryRow";

/** The kinds this dialog shows beside its fields instead of a toast. */
export const EDITOR_INLINE_FAILURES = ["stale", "field", "name-taken"] as const;

/** The rate field's message for each refusal (the comma has its own, C3). */
export function rateRefusalMessage(
  reason: RateInputRefusal,
  currency: string
): string {
  switch (reason) {
    case "comma":
      return "Use a point for decimals, with no thousands separator";
    case "too-many-decimals": {
      const digits = currencyMinorDigits(currency);
      return digits === 0
        ? `${currency} takes no decimals.`
        : `${currency} takes at most ${digits} decimals.`;
    }
    case "too-large":
      return "That rate is too large.";
    case "empty":
    case "format":
      return "Enter a number, like 160 or 160.50.";
  }
}

/** A formattable rate's amount without its code ("160.00"); "" otherwise. */
function amountText(rate: BillingRate | null): string {
  if (!rate || !isBillingCurrency(rate.currency)) return "";
  return formatRateMinor(rate.minor, rate.currency).split(" ")[0] ?? "";
}

function sameRate(a: BillingRate | null, b: BillingRate | null): boolean {
  if (a === null || b === null) return a === b;
  return a.minor === b.minor && a.currency === b.currency;
}

type Draft = { name: string; amount: string; currency: string };

/** The person's own change to the rate: its amount, currency and the clear. */
type RateEdit = { amount: string; currency: string; cleared: boolean };

/** The rate fields as the category stands now. */
function rateFields(
  category: BillingCategoryListItem | null,
  listCurrency: string
): { amount: string; currency: string } {
  const rate = category?.defaultRate ?? null;
  return {
    amount: amountText(rate),
    currency:
      rate?.currency ?? (isBillingCurrency(listCurrency) ? listCurrency : ""),
  };
}

/**
 * The rate the draft asks for: `undefined` leaves it as stored, `null` clears
 * it, an object sets it; or an error for the rate field.
 */
export function draftRate(
  draft: Draft,
  stored: BillingRate | null,
  cleared: boolean
):
  | { ok: true; rate: BillingRate | null | undefined }
  | { ok: false; error: string } {
  if (cleared) return { ok: true, rate: null };
  const amount = draft.amount.trim();
  if (amount === "") {
    // An emptied amount clears a rate the person could see; a rate in a code
    // this version cannot read stays as stored (PR2-R3a).
    const visible = stored !== null && isBillingCurrency(stored.currency);
    return {
      ok: true,
      rate: visible ? null : stored === null ? null : undefined,
    };
  }
  if (!isBillingCurrency(draft.currency)) {
    return { ok: false, error: "Pick a currency for the rate." };
  }
  const parsed = parseRateInput(amount, draft.currency);
  if (!parsed.ok) {
    return {
      ok: false,
      error: rateRefusalMessage(parsed.reason, draft.currency),
    };
  }
  return { ok: true, rate: { minor: parsed.minor, currency: draft.currency } };
}

export function BillingCategoryEditor(props: {
  /** Null adds a category; a category edits it. */
  category: BillingCategoryListItem | null;
  /** The list's currency for a new rate (may be a code this build lacks). */
  listCurrency: string;
  onClose: () => void;
  onSave: (
    request: BillingCategoryWriteRequest
  ) => Promise<BillingCategoryWriteOutcome>;
}) {
  const { category, listCurrency, onClose, onSave } = props;
  const stored = category?.defaultRate ?? null;
  // Only the person's edits are kept (F1): a field they have not touched shows
  // the category as it stands now, so after a stale token's reread it takes the
  // new value, and the save compares with that value, never writing it back.
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [rateEdit, setRateEdit] = useState<RateEdit | null>(null);
  const current = rateFields(category, listCurrency);
  const draft: Draft = {
    name: nameEdit ?? category?.name ?? "",
    amount: rateEdit?.amount ?? current.amount,
    currency: rateEdit?.currency ?? current.currency,
  };
  const cleared = rateEdit?.cleared ?? false;
  const [nameError, setNameError] = useState<string | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
  const [formLine, setFormLine] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The options: the table, plus the selected code when the table lacks it, so
  // a select never shows its first option in place of an unknown one (W12).
  const options =
    isBillingCurrency(draft.currency) || draft.currency === ""
      ? billingCurrencies()
      : [draft.currency, ...billingCurrencies()];
  const currencyKnown = isBillingCurrency(draft.currency);
  const amountTitle = currencyKnown
    ? undefined
    : draft.currency
      ? `${unknownCurrencyTitle(draft.currency)} Pick another currency to enter a rate.`
      : "Pick a currency to enter a rate.";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNameError(null);
    setRateError(null);
    setFormLine(null);
    const named = normalizeBillingCategoryName(draft.name);
    if (!named.ok) {
      setNameError(BILLING_CATEGORY_NAME_MESSAGES[named.reason]);
      return;
    }
    const name = named.name;
    const rate = draftRate(draft, stored, cleared);
    if (!rate.ok) {
      setRateError(rate.error);
      return;
    }
    let request: BillingCategoryWriteRequest;
    if (category === null) {
      request = { op: "add", name, defaultRate: rate.rate ?? null };
    } else {
      const changes: {
        name?: string;
        defaultRate?: BillingRate | null;
      } = {};
      if (name !== category.name) changes.name = name;
      if (rate.rate !== undefined && !sameRate(rate.rate, stored)) {
        changes.defaultRate = rate.rate;
      }
      if (Object.keys(changes).length === 0) {
        onClose();
        return;
      }
      request = { op: "update", id: category.id, ...changes };
    }
    setSaving(true);
    const outcome = await onSave(request);
    setSaving(false);
    if (outcome.ok) {
      onClose();
      return;
    }
    const { failure } = outcome;
    if (failure.kind === "not-found") {
      onClose();
    } else if (failure.kind === "stale") {
      setFormLine(billingCategoryFailureMessage(failure));
    } else if (failure.kind === "name-taken") {
      setNameError(billingCategoryFailureMessage(failure));
    } else if (failure.kind === "field") {
      const message = billingCategoryFieldMessage(
        failure.field,
        failure.reason
      );
      if (failure.field.startsWith("name")) setNameError(message);
      else if (failure.field.startsWith("defaultRate")) setRateError(message);
      else setFormLine(message);
    }
  };

  const title =
    category === null ? "Add a billing category" : "Edit billing category";
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-md" data-testid="billing-category-editor">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            The default rate is prefilled as the hourly rate when a tracked
            session is created with this category.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <FormField label="Name" error={nameError}>
            {control => (
              <Input
                {...control}
                value={draft.name}
                maxLength={120}
                onChange={e => setNameEdit(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Default hourly rate" error={rateError}>
            {control => (
              <div className="flex items-center gap-2">
                <Input
                  {...control}
                  inputMode="decimal"
                  placeholder={cleared ? "No default rate" : "160.00"}
                  value={draft.amount}
                  disabled={!currencyKnown}
                  title={amountTitle}
                  className="min-w-0 flex-1"
                  onChange={e =>
                    setRateEdit({
                      amount: e.target.value,
                      currency: draft.currency,
                      cleared: false,
                    })
                  }
                />
                <Select
                  aria-label="Currency of the rate"
                  value={draft.currency}
                  title={
                    currencyKnown || !draft.currency
                      ? undefined
                      : unknownCurrencyTitle(draft.currency)
                  }
                  className="w-24 shrink-0"
                  onChange={e =>
                    setRateEdit({
                      amount: draft.amount,
                      currency: e.target.value,
                      cleared,
                    })
                  }
                >
                  {draft.currency === "" && (
                    <option value="" disabled>
                      Currency
                    </option>
                  )}
                  {options.map(code => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </FormField>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              title="Save this category with no default rate"
              onClick={() => {
                setRateError(null);
                setRateEdit({
                  amount: "",
                  currency: draft.currency,
                  cleared: true,
                });
              }}
            >
              No default rate
            </Button>
          </div>
          {formLine && (
            <p className="text-sm text-[var(--status-warn)]" role="status">
              {formLine}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              title="Close without saving"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving} title="Save this category">
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
