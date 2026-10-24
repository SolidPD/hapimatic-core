// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #2150: the error toast for a remote (federation) spawn that failed after
 * the node accepted it — the node refused it (`federation-spawn-failed`, or the
 * hub's failed placeholder on the next poll) or the 120s stub TTL expired.
 *
 * Before #2150 such a failure only flipped the "Creating on remote node…" row,
 * and that row sat inside a project group that is collapsed by default, so the
 * user saw nothing. The stub store (`lib/pending-spawns.ts`) raises
 * `hapi:remoteSpawnFailed` ONCE per failed stub, whichever path delivered the
 * failure; this listener (mounted inside ToastProvider, App.tsx) turns it into
 * a toast that names the node and carries the node's message.
 *
 * An `account_unrefreshable` refusal gets the "Log in" action from #4461's
 * `buildReloginToast`, so it opens the re-login flow for THAT node.
 */
import { useEffect } from "react";
import { useToast } from "@/components/Toast";
import {
  REMOTE_SPAWN_FAILED_EVENT,
  type RemoteSpawnFailedDetail,
} from "@/lib/pending-spawns";
import { buildReloginToast } from "@/lib/reloginLink";

/** Long enough to read a node's message and reach the action button. */
export const REMOTE_SPAWN_FAILED_TOAST_MS = 8000;

const MAX_ERROR_CHARS = 160;

export function buildRemoteSpawnFailedToast(detail: RemoteSpawnFailedDetail): {
  message: string;
  action?: { label: string; onClick: () => void };
} {
  if (detail.timedOut) {
    return {
      message: `No session appeared on ${detail.nodeLabel} within 2 minutes`,
    };
  }
  const error =
    detail.error.length > MAX_ERROR_CHARS
      ? detail.error.slice(0, MAX_ERROR_CHARS) + "…"
      : detail.error;
  const message = `Couldn't create the session on ${detail.nodeLabel}: ${error}`;
  if (detail.code === "account_unrefreshable") {
    const { action } = buildReloginToast({
      nodeId: detail.nodeId,
      nodeLabel: detail.nodeLabel,
    });
    return { message, action };
  }
  return { message };
}

export function RemoteSpawnFailedToastListener(): null {
  const { showToast } = useToast();
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<RemoteSpawnFailedDetail>).detail;
      if (!detail?.nodeLabel || typeof detail.error !== "string") return;
      const { message, action } = buildRemoteSpawnFailedToast(detail);
      showToast(message, {
        type: "error",
        duration: REMOTE_SPAWN_FAILED_TOAST_MS,
        ...(action ? { action } : {}),
      });
    };
    window.addEventListener(REMOTE_SPAWN_FAILED_EVENT, handler);
    return () => window.removeEventListener(REMOTE_SPAWN_FAILED_EVENT, handler);
  }, [showToast]);
  return null;
}
