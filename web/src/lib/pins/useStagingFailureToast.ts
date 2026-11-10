// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { useToast } from "@/components/Toast";
import {
  markStagingFailureReported,
  useStagingFailure,
} from "@/lib/pins/staging";

/**
 * #6450: say once, through the toast channel, that this device could not save
 * staged answers (full or disabled storage). They keep working until the page
 * closes. Mounted by both Submit bars; the first to see the failure reports it.
 */
export function useStagingFailureToast(): void {
  const failed = useStagingFailure();
  const { showToast } = useToast();
  useEffect(() => {
    if (!failed) return;
    markStagingFailureReported();
    showToast(
      "This device could not save your staged answers. They are kept until you close the page, so Submit before then",
      { type: "warning" }
    );
  }, [failed, showToast]);
}
