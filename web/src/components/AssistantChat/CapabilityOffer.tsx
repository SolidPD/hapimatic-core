// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL capability-miss offer (issue #3132, Task 3; epic #3117 Sub R).
 *
 * Presentational surface for a capability miss: given the COMPLETED payload the
 * cli gate delivers (`CapabilityMissPayload` — KD2: the web computes nothing from
 * manifests), it discloses which capabilities the session's harness lacks and
 * offers degrade vs respawn.
 *
 * NEVER SILENT (R3 / KD4): the missing-capability disclosure ALWAYS renders —
 * in the interactive offer AND in the `autoDegraded` notice — so a miss can never
 * be hidden, even when a policy degrades without asking.
 *
 * Degrade follows the ENVELOPE's degradation annotation (KD5) carried in the
 * payload; this component never invents a degrade path.
 *
 * SEAM (OR2 / KD2): the parent wires the decision to the cli RPC round-trip and
 * (on respawn) to the pre-filled Create flow (`CapabilityOffer` stays
 * presentational — `onDecision` is its whole contract). Nothing renders this in
 * the live message stream yet: the cli gate is the producer, and its live
 * dispatch trigger is #3124's forward seam.
 */
import { Button } from "@/components/ui/button";
import type {
  CapabilityMissPayload,
  CapabilityOfferDecision,
} from "@hapi/protocol";

const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "OpenAI Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

function harnessLabel(id: string): string {
  return HARNESS_LABELS[id] ?? id;
}

/** Human-readable capability name (`session_persistence` → "session persistence"). */
function capabilityLabel(cap: string): string {
  return cap.replace(/_/g, " ");
}

/** How the envelope's degradation annotation reads to the user (KD5). */
function degradationLabel(fallback: string | undefined): string {
  switch (fallback) {
    case "emulated":
      return "runs in an emulated (deterministic-script) form";
    case "absent":
      return "is omitted (non-essential for this skill)";
    default:
      // `native` or unannotated → the skill needs it natively; degrading drops it.
      return "has no fallback — the skill needs it natively";
  }
}

export function CapabilityOffer(props: {
  payload: CapabilityMissPayload;
  /** Invoked with the user's choice. Omitted in {@link autoDegraded} mode. */
  onDecision?: (decision: CapabilityOfferDecision) => void;
  /**
   * Render as a NON-interactive notice of an AUTOMATIC degrade (R3/KD4): a miss
   * is never silent, even when a policy degrades without prompting.
   */
  autoDegraded?: boolean;
}) {
  const { payload, onDecision, autoDegraded = false } = props;
  const primaryCapable = payload.capableHarnesses[0];

  return (
    <div
      data-testid="capability-offer"
      role={autoDegraded ? "status" : "group"}
      className="my-2 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-fg)]"
    >
      <div className="font-medium">
        {autoDegraded
          ? `Running "${payload.skill}" degraded on ${harnessLabel(
              payload.sessionHarness
            )}`
          : `"${payload.skill}" needs capabilities ${harnessLabel(
              payload.sessionHarness
            )} lacks`}
      </div>

      {/* Never-silent disclosure — always rendered (R3). */}
      <ul
        data-testid="capability-offer-missing"
        className="mt-2 list-disc space-y-1 pl-5 text-[var(--app-hint)]"
      >
        {payload.missing.map(cap => (
          <li key={cap}>
            <span className="text-[var(--app-fg)]">{capabilityLabel(cap)}</span>{" "}
            — {degradationLabel(payload.degradation[cap])}
          </li>
        ))}
      </ul>

      {autoDegraded ? (
        <p className="mt-2 text-[var(--app-hint)]">
          Auto-degraded per each capability&rsquo;s annotation above. This
          notice surfaces the degradation so it is never silent.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            data-testid="capability-offer-degrade"
            variant="secondary"
            size="sm"
            onClick={() => onDecision?.("degrade")}
          >
            Continue degraded
          </Button>
          {primaryCapable ? (
            <Button
              data-testid="capability-offer-respawn"
              variant="default"
              size="sm"
              onClick={() => onDecision?.("respawn")}
            >
              Respawn under {harnessLabel(primaryCapable)}
            </Button>
          ) : (
            <span
              data-testid="capability-offer-no-capable"
              className="self-center text-[var(--app-hint)]"
            >
              No available harness can run this skill — degrade only.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
