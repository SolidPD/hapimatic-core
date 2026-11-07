// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ApiKeyBudgetDialog — set what an API key has to spend, and its monthly
 * top-up (API key budgets).
 *
 * No provider reports a key's remaining credit, so the operator enters the
 * dollars available now; the server stamps the time and subtracts the spend
 * Hapimatic meters on the key from then on. The optional top-up lands at local
 * midnight on a day of the month (the browser's zone is saved with it): "Add"
 * puts it on top of what is left, "Replace" sets the balance to it — the way
 * Max and Ultra API credit expires at each renewal.
 *
 * One PATCH saves both. The balance is sent only when the operator changed it,
 * so saving just a top-up does not restart the spend window.
 */
import { useEffect, useState } from "react";
import {
  API_KEY_BUDGET_MAX_USD,
  type ApiKeyBudgetRecurrence,
  type PatchApiKeyRequest,
  type RedactedApiKey,
} from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/Input";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { Select } from "@/components/ui/Select";
import { useApiKeyActions } from "@/hooks/mutations/useApiKeyActions";

const LABEL =
  "text-[length:var(--text-caption)] font-semibold text-[var(--app-hint)]";
const HINT = "text-[length:var(--text-caption-xs)] text-[var(--app-hint)]";
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/** A dollar field's value: a number in range, `null` for empty, or an error. */
export function parseUsd(
  raw: string,
  { allowZero }: { allowZero: boolean }
): number | null | { error: string } {
  const text = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (text === "") return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return { error: "Enter a dollar amount" };
  if (n < 0 || (!allowZero && n === 0)) {
    return { error: allowZero ? "Enter $0 or more" : "Enter more than $0" };
  }
  if (n > API_KEY_BUDGET_MAX_USD) return { error: "That amount is too large" };
  return Math.round(n * 100) / 100;
}

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The amount the balance field starts with: $0.00 for a key the provider
 *  called out of credit, else the current estimate (never below zero), else
 *  the stored budget, else empty. */
function initialAmount(key: RedactedApiKey): string {
  if (key.outOfCredit) return "0.00";
  if (key.budgetStatus) {
    return Math.max(0, key.budgetStatus.remainingUsd).toFixed(2);
  }
  return key.budget ? key.budget.amountUsd.toFixed(2) : "";
}

export function ApiKeyBudgetDialog(props: {
  apiKey: RedactedApiKey;
  name: string;
  api: ApiClient | null;
  open: boolean;
  onClose: () => void;
}) {
  const { apiKey, name, api, open, onClose } = props;
  const { update } = useApiKeyActions(api);
  const rule = apiKey.budgetRecurrence;

  const [amount, setAmount] = useState("");
  const [amountDirty, setAmountDirty] = useState(false);
  const [topUpOn, setTopUpOn] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState("");
  const [day, setDay] = useState(1);
  const [mode, setMode] = useState<ApiKeyBudgetRecurrence["mode"]>("add");
  const [error, setError] = useState<string | null>(null);

  // Re-seed from the key each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setAmount(initialAmount(apiKey));
    setAmountDirty(false);
    setTopUpOn(rule !== undefined);
    setTopUpAmount(rule ? String(rule.amountUsd) : "");
    setDay(rule?.dayOfMonth ?? new Date().getDate());
    setMode(rule?.mode ?? "add");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed on open only
  }, [open]);

  const save = async () => {
    setError(null);
    const body: PatchApiKeyRequest = {};
    if (amountDirty) {
      const parsed = parseUsd(amount, { allowZero: true });
      if (parsed !== null && typeof parsed === "object") {
        setError(`Available now: ${parsed.error}`);
        return;
      }
      body.budget = parsed === null ? null : { amountUsd: parsed };
    }
    if (topUpOn) {
      const parsed = parseUsd(topUpAmount, { allowZero: false });
      if (parsed === null || typeof parsed === "object") {
        setError(
          `Top-up: ${parsed === null ? "Enter a dollar amount" : parsed.error}`
        );
        return;
      }
      const timeZone = browserTimeZone();
      body.budgetRecurrence = {
        amountUsd: parsed,
        dayOfMonth: day,
        mode,
        ...(timeZone ? { timeZone } : {}),
      };
    } else if (rule) {
      body.budgetRecurrence = null;
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    try {
      await update.mutateAsync({ id: apiKey.id, body });
      onClose();
    } catch {
      setError("Couldn't save the budget. Nothing was changed — try again.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm" data-testid="api-key-budget-dialog">
        <DialogHeader>
          <DialogTitle>Budget · {name}</DialogTitle>
          <DialogDescription className="mt-1">
            Providers don&apos;t report a key&apos;s balance. Hapimatic
            subtracts the spend it meters on this key from what you enter.
          </DialogDescription>
        </DialogHeader>

        {apiKey.outOfCredit ? (
          <p
            data-testid="api-key-budget-out-of-credit"
            className="text-[length:var(--text-caption)] font-semibold text-[var(--status-hot)]"
          >
            The provider reported this key out of credit. Enter the credit you
            added; saving it clears “Out of credit”.
          </p>
        ) : null}

        <label className="mt-1 flex flex-col gap-1">
          <span className={LABEL}>Available now ($)</span>
          <Input
            inputMode="decimal"
            value={amount}
            placeholder="No balance set"
            data-testid="api-key-budget-amount"
            onChange={e => {
              setAmount(e.target.value);
              setAmountDirty(true);
            }}
            className="tabular-nums"
          />
          <span className={HINT}>Leave empty for no balance.</span>
        </label>

        <label className="mt-3 flex cursor-pointer items-center gap-2 text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
          <Checkbox
            checked={topUpOn}
            data-testid="api-key-budget-topup-toggle"
            aria-label="Top up every month"
            onChange={e => setTopUpOn(e.target.checked)}
          />
          Top up every month
        </label>

        {topUpOn ? (
          <div
            className="mt-2 flex flex-col gap-2"
            data-testid="api-key-budget-topup"
          >
            <div className="flex items-center gap-2">
              <Input
                inputMode="decimal"
                value={topUpAmount}
                placeholder="200"
                aria-label="Top-up amount in dollars"
                data-testid="api-key-budget-topup-amount"
                onChange={e => setTopUpAmount(e.target.value)}
                className="w-24 tabular-nums"
              />
              <span className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                on day
              </span>
              <Select
                value={String(day)}
                aria-label="Day of the month"
                data-testid="api-key-budget-topup-day"
                onChange={e => setDay(Number(e.target.value))}
                className="w-20"
              >
                {DAYS.map(d => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </div>
            <SegmentedToggle
              ariaLabel="What the top-up does"
              testIdPrefix="api-key-budget-mode"
              value={mode}
              onChange={setMode}
              fullWidth
              options={[
                { value: "add", label: "Add to balance" },
                { value: "replace", label: "Replace balance" },
              ]}
            />
            <span className={HINT}>
              {mode === "replace"
                ? "Unused credit expires at each top-up, as Max and Ultra API credit does."
                : "The top-up is added to whatever is left."}{" "}
              A day past the month&apos;s end uses its last day.
            </span>
          </div>
        ) : null}

        {error ? (
          <p
            className="mt-3 text-[length:var(--text-caption)] text-destructive"
            data-testid="api-key-budget-error"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={update.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="accent"
            size="sm"
            onClick={() => void save()}
            disabled={update.isPending || !api}
            data-testid="api-key-budget-save"
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
