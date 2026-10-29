// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The kebab's fan-out entries, "Fan out" and "Peers", with the dialogs they
 * open. Built once for the session card (list) and the session header
 * (instance), so both kebabs offer the same entries under the same rules
 * (#3288 parity; #4469 operator review 2026-10-27).
 *
 * - A session served by another federation node gets neither entry: the hub
 *   resolves a spawn's parent only against its own sessions (#3818 / #4497).
 * - "Peers" needs at least one `spawn` child in this hub's session list.
 */
import { useCallback, useState, type ReactNode } from "react";
import type { ApiClient } from "@/api/client";
import { FanOutDialog, type FanOutDialogParent } from "./FanOutDialog";
import { ExperimentView, type ExperimentParent } from "./ExperimentView";
import { useCachedSessions, useSpawnChildCount } from "./sessionsCache";

export type FanOutMenuSession = FanOutDialogParent & ExperimentParent;

export type FanOutMenu = {
  /** Undefined when the entry must not show. */
  onFanOut?: () => void;
  onPeers?: () => void;
  /** Render once, outside any clickable row. */
  dialogs: ReactNode;
};

export function useFanOutMenu(opts: {
  api: ApiClient | null;
  session: FanOutMenuSession;
  /** The session's display name; peers are named after it. */
  title: string;
  /** Set when another federation node serves this session. */
  nodeUrl?: string;
  /** The session's branch, the Experiment view's diff base. */
  branchName: string | null;
}): FanOutMenu {
  const { api, session, title, nodeUrl, branchName } = opts;
  const [fanOutOpen, setFanOutOpen] = useState(false);
  const [peersOpen, setPeersOpen] = useState(false);
  const peerCount = useSpawnChildCount(session.id);
  const openFanOut = useCallback(() => setFanOutOpen(true), []);
  const openPeers = useCallback(() => setPeersOpen(true), []);
  const servedElsewhere = Boolean(nodeUrl);

  return {
    onFanOut: servedElsewhere ? undefined : openFanOut,
    onPeers: servedElsewhere || peerCount === 0 ? undefined : openPeers,
    dialogs: (
      <>
        {fanOutOpen ? (
          <FanOutDialog
            isOpen
            onClose={() => setFanOutOpen(false)}
            api={api}
            parent={session}
            parentTitle={title}
          />
        ) : null}
        {peersOpen ? (
          <PeersDialog
            api={api}
            parent={session}
            parentBranch={branchName}
            onClose={() => setPeersOpen(false)}
          />
        ) : null}
      </>
    ),
  };
}

/** Mounted only while open, so only an open view reads the whole list. */
function PeersDialog(props: {
  api: ApiClient | null;
  parent: ExperimentParent;
  parentBranch: string | null;
  onClose: () => void;
}) {
  const sessions = useCachedSessions();
  return (
    <ExperimentView
      isOpen
      onClose={props.onClose}
      api={props.api}
      parent={props.parent}
      parentBranch={props.parentBranch}
      sessions={sessions}
    />
  );
}
