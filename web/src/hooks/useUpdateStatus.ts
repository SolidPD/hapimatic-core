// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";

/**
 * Binary auto-update status (issue #1006, D999-10 control-plane push).
 *
 * `useUpdateStatus` polls the PUBLIC `GET /api/update-status` (no auth, like
 * `useVersion`) — the server reads its LOCAL staged-update marker.
 * `useTriggerUpdate` POSTs the AUTH-required `/api/update-trigger`.
 *
 * Both are CONTEXT-FREE (plain `fetch`, no `useAppContext`) because
 * `UpdateAvailableBadge` lives in `BrandedFrame`, which renders in both
 * authed and pre-auth (loading/login) states where `AppContext` is absent.
 * The trigger reads the token from localStorage the same way the auth layer
 * stores it (`hapi_access_token::<origin>`).
 */

/**
 * Aggregate session impact of a restart (issue #2589). Kept in lock-step with the
 * server-side `SessionImpact` in `server/src/web/routes/update.ts`.
 */
export interface SessionImpact {
  active: number;
  thinking: number;
  /**
   * Sessions currently BLOCKING the deferred-apply gate (issue #3735). Same
   * predicate + source as the server-side gate, so the pending dialog can show
   * exactly what a "when-idle" apply is waiting on. `.optional()`-shaped in
   * practice: a peer/older server may omit it, so read as `?? thinking`.
   */
  blocking?: number;
}

/** Pending "apply when idle" state (issue #2589). Lock-step with the server. */
export interface DeferredState {
  pending: boolean;
  mode: "when-idle";
  requestedAt: string;
}

/**
 * Durable two-phase-updater lifecycle phase (issue #3057). Lock-step with the
 * server's `UpdatePhase` in `server/src/update/updateJobState.ts`.
 */
export type UpdatePhase =
  | "available"
  | "staging"
  | "ready"
  | "applying"
  | "succeeded"
  | "failed";

/** Durable updater job record (issue #3057). Lock-step with the server. */
export interface UpdateJobState {
  schemaVersion: 1;
  phase: UpdatePhase;
  targetVersion: string;
  jobId: string | null;
  updatedAt: string;
  errorCode?: string;
  rollback?: boolean;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  lastChecked: string;
  error?: string;
  /**
   * Live session impact (issue #2589). ABSENT when the server could not read the
   * session source — the dialog degrades to today's two-choice form (R6).
   */
  sessionImpact?: SessionImpact;
  /** Server-resolved machine/node display name for the honest copy (R5, #2589). */
  machineName?: string;
  /** Pending deferred-apply state, or null when none (issue #2589). */
  deferred?: DeferredState | null;
  /**
   * Durable two-phase-updater lifecycle state, or null when no job record exists
   * (issue #3057). The single bar keys its spinner (`staging`/`applying`), the
   * restart-confirmation dialog (`ready`), and the terminal reload (`succeeded`)
   * off this — never off a resolved mutation (a 202 is launch acceptance, not
   * completion).
   */
  job?: UpdateJobState | null;
}

/** Fail-safe value — never flicker a badge on a transient error. */
const NO_UPDATE: UpdateStatus = {
  currentVersion: "?.?.?",
  latestVersion: "?.?.?",
  updateAvailable: false,
  lastChecked: "",
};

const ACCESS_TOKEN_PREFIX = "hapi_access_token::";

function getStoredAccessToken(): string | null {
  try {
    return localStorage.getItem(
      `${ACCESS_TOKEN_PREFIX}${window.location.origin}`
    );
  } catch {
    return null;
  }
}

/**
 * Exchange the stored RAW cliApiToken for a short-lived JWT via `POST /api/auth`.
 *
 * The auth-required update routes (`/api/update-trigger`, and #2589's cancel
 * route) are guarded by a JWT-only middleware (`server/src/web/middleware/auth.ts`
 * — `jwtVerify`, no raw-token fallback). The value stored under
 * `hapi_access_token::<origin>` is the RAW cliApiToken, NOT a JWT, so it must be
 * exchanged first — exactly what the context-bound `ApiClient.authenticate`
 * does (`web/src/api/client.ts`). This helper mirrors that exchange with a plain
 * `fetch` so it stays context-free: the update badge renders in pre-auth states
 * where `AppContext` is absent, which is why it cannot use `ApiClient` (#2590).
 *
 * Exported so #2589's cancel-deferral mutation reuses ONE mint path — a private
 * inline mint would force #2589 to duplicate it or re-inherit the very raw-token
 * bug this fixes.
 *
 * `/api/auth` is itself JWT-exempt and un-rate-limited, and the minted JWT
 * expires in ~15 min, so minting fresh on every apply is both safe and simplest.
 *
 * @throws {Error} with an actionable, user-facing message when there is no
 *   stored credential or the exchange is rejected — the badge's `ConfirmDialog`
 *   surfaces this message verbatim, so it must read as guidance, not a bare
 *   HTTP status.
 */
export async function mintUpdateJwt(): Promise<string> {
  const rawToken = getStoredAccessToken();
  if (!rawToken) {
    throw new Error(
      "Couldn't authenticate the update — you don't appear to be signed in. Please sign in and try again."
    );
  }

  let res: Response;
  try {
    res = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: rawToken }),
    });
  } catch {
    throw new Error(
      "Couldn't reach the server to authenticate the update. Check your connection and try again."
    );
  }

  if (!res.ok) {
    throw new Error(
      "Couldn't authenticate the update — your sign-in may have expired. Please sign in again and try again."
    );
  }

  const { token } = (await res.json()) as { token: string };
  return token;
}

/** Phases where a stage/apply is actively running — poll fast to catch transitions. */
function isActivePhase(phase: UpdatePhase | undefined): boolean {
  return phase === "staging" || phase === "applying";
}

export function useUpdateStatus() {
  const queryClient = useQueryClient();

  // Fail-safe with lifecycle-retention (#3057): on a transient error, keep an
  // in-flight `staging`/`applying` state rather than dropping to NO_UPDATE — the
  // `applying` phase's own network gap (the server restarts itself mid-apply) is
  // EXPECTED and must NOT erase the spinner or falsely report "no update". A first
  // load with no prior in-flight state still fails safe to NO_UPDATE (no badge).
  const failSafe = (): UpdateStatus => {
    const prev = queryClient.getQueryData<UpdateStatus>(queryKeys.updateStatus);
    if (prev?.job && isActivePhase(prev.job.phase)) return prev;
    return NO_UPDATE;
  };

  return useQuery<UpdateStatus>({
    queryKey: queryKeys.updateStatus,
    queryFn: async () => {
      try {
        const res = await fetch("/api/update-status");
        if (!res.ok) return failSafe();
        return (await res.json()) as UpdateStatus;
      } catch {
        return failSafe();
      }
    },
    // Phase-aware cadence (#3057): poll rapidly while staging/applying so the bar
    // reflects `ready`/`succeeded` promptly, moderately while a deferral is pending,
    // and at the idle 5-min cadence otherwise (aligns with the server marker cache).
    refetchInterval: query => {
      const d = query.state.data;
      if (isActivePhase(d?.job?.phase)) return 2000;
      if (d?.deferred?.pending) return 15 * 1000;
      return 5 * 60 * 1000;
    },
    // Keep polling through the apply restart even if the tab is backgrounded, so
    // completion is detected; the actual reload still defers to `reloadWhenVisible`.
    refetchIntervalInBackground: true,
    staleTime: 60 * 1000,
  });
}

/** The apply mode (issue #2589): fire immediately, or defer until sessions idle. */
export type UpdateMode = "now" | "when-idle";

/**
 * Response of `POST /api/update-trigger`. "now" returns `{ accepted, jobId }`;
 * "when-idle" returns `{ accepted, deferred: true }` (no launch — the server
 * fires the apply once no session is thinking).
 */
export interface TriggerUpdateResult {
  accepted: boolean;
  jobId?: string;
  deferred?: boolean;
}

export function useTriggerUpdate() {
  const queryClient = useQueryClient();
  return useMutation<TriggerUpdateResult, Error, { mode: UpdateMode }>({
    mutationFn: async ({ mode }) => {
      // Exchange the raw cliApiToken for a JWT the JWT-only middleware accepts.
      // Before #2590 the raw token was sent directly as `Bearer` and the
      // middleware's `jwtVerify` rejected it → a deterministic HTTP 401 on
      // every "Update now" click.
      const jwt = await mintUpdateJwt();
      const res = await fetch("/api/update-trigger", {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        // The request WAS authenticated (mintUpdateJwt succeeded above), so a
        // non-ok here is a server/launch failure — distinct from the credential
        // failure mintUpdateJwt() reports with its own actionable copy.
        throw new Error(
          `The update was authenticated but the server couldn't start it (HTTP ${res.status}). Please try again.`
        );
      }
      return (await res.json()) as TriggerUpdateResult;
    },
    onSuccess: () => {
      // Refresh status shortly after triggering so the badge reflects reality
      // (e.g. the pending-deferred state appears after "Update when idle").
      void queryClient.invalidateQueries({ queryKey: queryKeys.updateStatus });
    },
  });
}

/**
 * Response of `POST /api/update-stage` (issue #3057). 202 `{ phase: "staging" }`
 * when a fresh stage launched; 200 `{ phase: "ready" }` when already staged for
 * this target (idempotent). Acceptance is NOT staging completion — the caller
 * watches `useUpdateStatus().data.job.phase` reach `ready` before confirming.
 */
export interface StageUpdateResult {
  accepted: boolean;
  phase: "staging" | "ready";
  jobId?: string | null;
}

/**
 * Start the non-disruptive download/stage (issue #3057 R2). The single bar's first
 * click calls this — it downloads + integrity/signature-verifies the update WITHOUT
 * touching the running binary, so the bar can show a spinner during staging and only
 * open the restart-confirmation dialog once the polled job phase reaches `ready`.
 * Uses the SAME JWT-mint path as {@link useTriggerUpdate} (the route is JWT-guarded).
 */
export function useStageUpdate() {
  const queryClient = useQueryClient();
  return useMutation<StageUpdateResult, Error, void>({
    mutationFn: async () => {
      const jwt = await mintUpdateJwt();
      const res = await fetch("/api/update-stage", {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) {
        // Authenticated (mintUpdateJwt succeeded) — a non-ok here is a server/launch
        // failure, distinct from the credential failure mintUpdateJwt() reports.
        throw new Error(
          `The update was authenticated but the server couldn't start staging it (HTTP ${res.status}). Please try again.`
        );
      }
      return (await res.json()) as StageUpdateResult;
    },
    onSuccess: () => {
      // Pull fresh status so the bar picks up `staging` (then `ready`) promptly.
      void queryClient.invalidateQueries({ queryKey: queryKeys.updateStatus });
    },
  });
}

/**
 * Cancel a pending "update when idle" deferral (issue #2589, R3). Uses the SAME
 * JWT-mint path as {@link useTriggerUpdate} — the cancel route is JWT-guarded, so
 * the raw cliApiToken would 401 exactly as #2590 documents.
 */
export function useCancelDeferral() {
  const queryClient = useQueryClient();
  return useMutation<{ cancelled: boolean }, Error, void>({
    mutationFn: async () => {
      const jwt = await mintUpdateJwt();
      const res = await fetch("/api/update-cancel-deferral", {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) {
        throw new Error(
          `Couldn't cancel the deferred update (HTTP ${res.status}). Please try again.`
        );
      }
      return (await res.json()) as { cancelled: boolean };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.updateStatus });
    },
  });
}
