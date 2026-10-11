// SPDX-License-Identifier: AGPL-3.0-only
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { History } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { TimeLogModalBody } from "../TimeLogModal";

/**
 * TimeLogPage — the `/settings/time-log` route (issue #1039).
 *
 * The `/settings/time-log` route (#1935 promoted it from an in-drawer `?section=` view).
 * The shared `SettingsSectionHeader` owns the back affordance (plain history-back via
 * `useAppGoBack`) and renders on the `--app-bg` palette for visual consistency with the
 * other admin pages.
 *
 * The Time Log content is the shared `TimeLogModalBody` extracted in Task 1 — the same tabs,
 * accordion, charts, export menu, and delete flow the modal rendered, with no Dialog shell.
 */
export default function TimeLogPage() {
  const { api } = useAppContext();

  useDocumentTitle("Time Log - Hapimatic");
  useEmojiFavicon(null);

  return (
    <div className="flex h-full flex-col">
      <SettingsSectionHeader
        icon={<TitleChip icon={History} accent="#c084fc" />}
        title="Time Log"
      />

      {/* Body — the px-6 matches the modal's DialogContent padding so the body's
          `-mx-6 px-6` scroll-area gutters align identically in this section.
          #2331: `mx-auto w-full max-w-content` caps the body at the same width as
          SettingsSectionHeader; px-6 / min-h-0 / flex-1 are preserved verbatim because
          the padding is load-bearing for the -mx-6 gutter alignment above and the
          other two own the inner scroll behavior. */}
      <div className="mx-auto flex w-full min-h-0 max-w-content flex-1 flex-col px-6 pb-4">
        <TimeLogModalBody api={api} />
      </div>
    </div>
  );
}
