// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import { LOCAL_NODE_ID } from "@hapi/protocol";
import type { SessionSummary } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { getCliDisplayName } from "@/lib/sessionHelpers";
import { isClaudeFlavor } from "@/hooks/queries/useSessionAccountEmail";
import { useNodeActiveAccounts } from "@/hooks/queries/useNodeActiveAccount";
import { classifyAccount } from "@/lib/sessionSearchFilterSort";
import type { NodeFilterOption } from "@/components/SearchFilterBar";

/** Display labels for the known auth-binding provider ids (#3810 Phase B).
 *  An unknown id falls back to a capitalized form so a new provider still
 *  renders. This labels the PROVIDER id directly (not a harness→vendor guess). */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
};

/**
 * Derive the Harness + Account filter option lists (#3810 Task 3) from the
 * UNFILTERED merged session list, plus the resolved node→account map the account
 * predicate needs. Lives here — not inline in the 1670-line `router.tsx` — to
 * respect the max-lines discipline (R4); `router.tsx` grows only by wiring lines.
 *
 * - `harnessOptions`: the distinct `metadata.flavor` values PRESENT in the list
 *   (the #942 R6 "options from the unfiltered list" pattern), labelled via
 *   `getCliDisplayName`. A tier-2 flavor is its own option — never "unknown".
 * - `accountOptions`: `classifyAccount` over every session (the SAME rule the
 *   predicate uses, so a stored `filters.account = <email>` matches node-default
 *   rows too), plus an explicit "Unassigned" option whenever any row classifies
 *   so (non-Claude sessions in Phase A, or an unresolved node default).
 * - `resolvedNodeAccounts`: the nodeId → active-account-email map, passed to
 *   `applySessionSearchFilter` (a `router.tsx` memo dep).
 *
 * The node-account lookup is enabled ONLY when some Claude row lacks a recorded
 * email (a node-default row), mirroring `useSessionAccountEmail`'s per-row
 * gating — a list of fully-recorded sessions issues no request.
 */
export function useSessionFilterOptions(
  api: ApiClient | null,
  sessions: SessionSummary[]
): {
  harnessOptions: NodeFilterOption[];
  accountOptions: NodeFilterOption[];
  providerOptions: NodeFilterOption[];
  resolvedNodeAccounts: ReadonlyMap<string, string | undefined>;
} {
  // Nodes hosting a Claude session with NO recorded email need resolution.
  // #4568: an API-key session binds no account (its key label is its identity in
  // `classifyAccount`), so it never queues a node active-account lookup.
  const nodeIdsNeedingResolution = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (
        isClaudeFlavor(s.metadata?.flavor) &&
        s.metadata?.authBinding?.kind !== "api-key" &&
        !s.metadata?.claudeAccount?.email
      ) {
        set.add(s.nodeId ?? LOCAL_NODE_ID);
      }
    }
    return [...set];
  }, [sessions]);

  const { resolved: resolvedNodeAccounts } = useNodeActiveAccounts(
    api,
    nodeIdsNeedingResolution,
    { enabled: nodeIdsNeedingResolution.length > 0 }
  );

  const harnessOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of sessions) {
      const flavor = s.metadata?.flavor?.trim();
      if (!flavor || seen.has(flavor)) continue;
      // A minimal SessionLike literal: getCliDisplayName reads only
      // metadata.flavor and maps it to the product name (or a capitalized id for
      // a tier-2 flavor), so it never returns "unknown" for a present flavor.
      seen.set(
        flavor,
        getCliDisplayName({
          id: `harness-opt-${flavor}`,
          metadata: { path: "", flavor },
        })
      );
    }
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sessions]);

  const accountOptions = useMemo(() => {
    const byEmail = new Map<string, string>();
    let hasUnassigned = false;
    for (const s of sessions) {
      const bucket = classifyAccount(s, resolvedNodeAccounts);
      if (bucket === "unassigned") {
        hasUnassigned = true;
      } else if (!byEmail.has(bucket)) {
        byEmail.set(bucket, bucket);
      }
    }
    const opts: NodeFilterOption[] = [...byEmail.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (hasUnassigned) opts.push({ value: "unassigned", label: "Unassigned" });
    return opts;
  }, [sessions, resolvedNodeAccounts]);

  // #3810 Phase B: distinct auth-binding provider ids present in the list.
  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const s of sessions) {
      const pid = s.metadata?.authBinding?.providerId?.trim();
      if (pid) seen.add(pid);
    }
    return [...seen]
      .map(value => ({
        value,
        label:
          PROVIDER_LABELS[value] ??
          value.charAt(0).toUpperCase() + value.slice(1),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sessions]);

  return {
    harnessOptions,
    accountOptions,
    providerOptions,
    resolvedNodeAccounts,
  };
}
