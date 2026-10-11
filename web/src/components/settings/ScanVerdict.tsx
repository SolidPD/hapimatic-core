// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `ScanVerdict` — renders a #3131 supply-chain scan verdict in the Extensions install flow.
 *
 * Shows the named findings (with severities), the MANDATORY "what this scan does NOT catch"
 * honesty text (R6 — a green result is defense-in-depth, never a guarantee), and, when the
 * scan BLOCKED an install, a per-artifact operator override control (R4 — captures a reason;
 * the override is logged and applies to THAT artifact only).
 *
 * The verdict rides the CLI's `--json` install envelope (no new endpoint — #3120's subprocess
 * relay). The pinned `ScanFinding` shape comes from `@hapi/protocol`.
 */
import { useState } from "react";

import type { ScanFinding } from "@hapi/protocol";

import { Button } from "@/components/ui/button";

export interface ScanVerdictData {
  verdict: "pass" | "block";
  findings: ScanFinding[];
  override?: { by: string; at: number; reason: string } | null;
}

/** Severity → badge classes (reuses the codebase's red/amber/muted status palette). */
const SEVERITY_BADGE: Record<ScanFinding["severity"], string> = {
  critical: "bg-red-500/15 text-red-400",
  high: "bg-red-500/15 text-red-400",
  medium: "bg-amber-500/15 text-amber-500",
  low: "bg-muted text-muted-foreground",
  info: "bg-muted text-muted-foreground",
};

/** What the scan does NOT catch (R6 honesty) — surfaced on EVERY verdict, pass or block. */
const KNOWN_GAPS = [
  "novel or reworded injection phrasings",
  "semantic attacks with no imperative keywords",
  "obfuscation beyond zero-width + base64",
  "payloads in non-markdown files (images, PDFs, binaries)",
  "runtime behavior — this is a static scan",
];

export function ScanVerdict({
  data,
  onOverride,
  overriding,
}: {
  data: ScanVerdictData;
  /** When present and the verdict blocked, renders the override control. */
  onOverride?: (reason: string) => void;
  overriding?: boolean;
}) {
  const [reason, setReason] = useState("");
  const blocked = data.verdict === "block";
  const overridden = Boolean(data.override);
  const hasFindings = data.findings.length > 0;

  const heading =
    blocked && !overridden
      ? "🛑 Supply-chain scan BLOCKED this install"
      : overridden
        ? "⚠️ Scan blocked — operator override applied"
        : "🛡️ Supply-chain scan passed";

  return (
    <div
      data-testid="scan-verdict"
      className={`mt-2 rounded-md border p-3 text-xs ${
        blocked && !overridden
          ? "border-red-500/40 bg-red-500/5"
          : "border-input bg-muted"
      }`}
    >
      <div className="font-medium text-foreground">{heading}</div>

      {hasFindings && (
        <ul className="mt-2 space-y-1" data-testid="scan-findings">
          {data.findings.map((f, i) => (
            <li key={i} className="flex items-start gap-2">
              <span
                className={`shrink-0 rounded px-1 py-0.5 font-medium uppercase ${SEVERITY_BADGE[f.severity]}`}
              >
                {f.severity}
              </span>
              <span className="min-w-0 text-muted-foreground">
                <code className="text-foreground">{f.rule ?? "finding"}</code> —{" "}
                {f.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* R6 — the honesty requirement. A green result is NEVER a safety guarantee. */}
      <p className="mt-2 text-muted-foreground" data-testid="scan-limits">
        Heuristic, defense-in-depth scan —{" "}
        <strong className="text-foreground">not a guarantee</strong>. It does
        not catch: {KNOWN_GAPS.join("; ")}. A clean result is not proof of
        safety.
      </p>

      {overridden && data.override && (
        <p className="mt-2 text-amber-500" data-testid="scan-override-note">
          Overridden by {data.override.by}: “{data.override.reason}”. Recorded
          for this artifact only.
        </p>
      )}

      {blocked && !overridden && onOverride && (
        <div className="mt-3 border-t border-input pt-3">
          <label className="mb-1 block text-muted-foreground">
            Override reason (logged, applies to this artifact only):
          </label>
          <textarea
            data-testid="scan-override-reason"
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={2}
            className="w-full rounded border border-input bg-muted p-2 text-foreground"
            placeholder="Why is this safe to install despite the findings?"
          />
          <Button
            variant="outline"
            data-testid="scan-override-btn"
            disabled={!reason.trim() || overriding}
            onClick={() => onOverride(reason.trim())}
            className="mt-2 h-auto rounded border-red-500/40 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
          >
            {overriding ? "Overriding…" : "Install anyway (override scan)"}
          </Button>
        </div>
      )}
    </div>
  );
}
