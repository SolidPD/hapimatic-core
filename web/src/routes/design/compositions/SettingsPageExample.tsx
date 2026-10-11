// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { SettingsPage } from "@/components/layouts/SettingsPage";
import { SettingsRow } from "@/components/ui/SettingsRow";
import { FormField } from "@/components/ui/FormField";
import { Toolbar } from "@/components/ui/Toolbar";
import { SearchInput } from "@/components/ui/SearchInput";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/button";
import { DenseActionCluster } from "@/components/ui/DenseActionCluster";
import { PopOutIcon } from "@/components/ui/icons";

/**
 * Composition page (R4) — a settings surface assembled PURELY from shared design-system
 * parts: the `SettingsPage` layout template (Sub E) wrapping `Toolbar` + `SettingsRow` +
 * `FormField` + `Input` / `Select` / `Checkbox` + `Button` (Sub C/D). No bespoke layout.
 * Dev-only (rendered inside the `/design` catalog).
 */
export function SettingsPageExample() {
  const [search, setSearch] = useState("");
  const [autoRecover, setAutoRecover] = useState(true);
  const [autoExpand, setAutoExpand] = useState(false);
  const [density, setDensity] = useState("normal");
  const [handle, setHandle] = useState("");

  return (
    <div className="h-96 overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]">
      <SettingsPage
        header={
          <div className="sticky top-0 z-10 border-b border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-3">
            <div className="mx-auto flex max-w-content items-center gap-3">
              <h2 className="text-sm font-semibold text-[var(--app-fg)]">
                Preferences
              </h2>
              <Toolbar
                className="min-w-0 flex-1"
                start={
                  <SearchInput
                    searchText={search}
                    onSearchTextChange={setSearch}
                    placeholder="Filter settings"
                  />
                }
                end={
                  <DenseActionCluster aria-label="Settings actions">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label="Open in new tab"
                    >
                      <PopOutIcon className="h-4 w-4" />
                    </Button>
                  </DenseActionCluster>
                }
              />
            </div>
          </div>
        }
      >
        <div className="mx-auto flex max-w-content flex-col gap-6 p-4">
          <section className="flex flex-col divide-y divide-[var(--app-border)] rounded-md border border-[var(--app-border)] px-4">
            <div className="py-2.5">
              <SettingsRow
                asLabel
                label="Auto-recover from API errors"
                description="Reconnect sessions automatically when the API recovers."
                control={
                  <Checkbox
                    aria-label="Auto-recover"
                    checked={autoRecover}
                    onChange={e => setAutoRecover(e.target.checked)}
                  />
                }
              />
            </div>
            <div className="py-2.5">
              <SettingsRow
                asLabel
                label="Auto-expand repo groups"
                control={
                  <Checkbox
                    aria-label="Auto-expand repo groups"
                    checked={autoExpand}
                    onChange={e => setAutoExpand(e.target.checked)}
                  />
                }
              />
            </div>
            <div className="py-2.5">
              <SettingsRow
                label="List density"
                control={
                  <Select
                    aria-label="List density"
                    value={density}
                    onChange={e => setDensity(e.target.value)}
                    className="w-32"
                  >
                    <option value="normal">Normal</option>
                    <option value="compact">Compact</option>
                    <option value="ultra">Ultra</option>
                  </Select>
                }
              />
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <FormField
              label="Default session handle"
              hint="Pre-fills the name field when spawning a session."
            >
              {control => (
                <Input
                  {...control}
                  value={handle}
                  onChange={e => setHandle(e.target.value)}
                  placeholder="e.g. rp1-worker"
                />
              )}
            </FormField>
            <div className="flex justify-end gap-2">
              <Button variant="outline">Cancel</Button>
              <Button>Save changes</Button>
            </div>
          </section>
        </div>
      </SettingsPage>
    </div>
  );
}
