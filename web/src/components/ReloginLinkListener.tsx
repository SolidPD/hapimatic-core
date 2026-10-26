// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  buildReloginSearch,
  RELOGIN_EVENT,
  type ReloginRequest,
} from "@/lib/reloginLink";

/**
 * Issue #4461 (R9): turns a `hapi:relogin` request (the "Log in" action on an
 * account_unrefreshable toast, and #4466's red-ring tap) into a navigation to
 * the Accounts page's deep link, `/settings/account-usage?relogin=<provider>
 * &node=<nodeId>`. The page decides what this UI can do for that node (D-A1 = A).
 * Mounted once by App.tsx; in its own file so it can be tested alone (#5417).
 */
export function ReloginLinkListener(): null {
  const navigate = useNavigate();
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ReloginRequest>).detail;
      if (!detail?.nodeId) return;
      void navigate({
        to: "/settings/account-usage",
        search: buildReloginSearch(detail),
      });
    };
    window.addEventListener(RELOGIN_EVENT, handler);
    return () => window.removeEventListener(RELOGIN_EVENT, handler);
  }, [navigate]);
  return null;
}
