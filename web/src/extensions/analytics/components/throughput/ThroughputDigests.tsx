// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import type { ApiClient } from "@/api/client";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import {
  useThroughputDigest,
  useThroughputDigests,
} from "../../hooks/useThroughput";
import { pillClass } from "./format";

/**
 * The stored weekly digests (issue #6164): the list, newest first, and the
 * selected one's report (the latest by default).
 */
export function ThroughputDigests({ api }: { api: ApiClient | null }) {
  const { digests, isLoading, error } = useThroughputDigests(api);
  const [picked, setPicked] = useState<string | null>(null);
  const id = picked ?? digests[0]?.id ?? null;
  const {
    digest,
    isLoading: digestLoading,
    error: digestError,
  } = useThroughputDigest(api, id);

  if (isLoading) {
    return (
      <div className="py-6 text-center text-xs text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }
  // #6367: a failed list is not "no digest yet". The error wins over a cached
  // list, as in the summary and the breakdown.
  if (error) {
    return (
      <div className="py-6 text-center text-xs text-[var(--app-muted)]">
        Could not load the weekly digests ({error}).
      </div>
    );
  }
  if (digests.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-[var(--app-muted)]">
        No weekly digest yet. The first one is written on the next Monday
        morning by the node that runs the fleet jobs.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {digests.slice(0, 8).map(d => (
          <button
            key={d.id}
            type="button"
            onClick={() => setPicked(d.id)}
            aria-pressed={d.id === id}
            className={pillClass(d.id === id)}
          >
            {d.id}
          </button>
        ))}
      </div>
      {/* #6367: loading, then error, then !digest. Checking the error after
          !digest would leave a failed detail on "Loading..." for good. */}
      {digestLoading ? (
        <div className="py-6 text-center text-xs text-[var(--app-muted)]">
          Loading...
        </div>
      ) : digestError ? (
        <div className="py-6 text-center text-xs text-[var(--app-muted)]">
          Could not load the digest ({digestError}).
        </div>
      ) : !digest ? (
        <div className="py-6 text-center text-xs text-[var(--app-muted)]">
          Loading...
        </div>
      ) : (
        <div className="max-h-[32rem] overflow-y-auto rounded bg-[var(--app-bg)] p-3">
          <SimpleMarkdown content={digest.markdown} className="text-xs" />
        </div>
      )}
    </div>
  );
}
