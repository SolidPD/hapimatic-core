// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { SearchInput } from "@/components/ui/SearchInput";
import { Toolbar } from "@/components/ui/Toolbar";
import { StatePanel } from "@/components/ui/StatePanel";
import { FormField } from "@/components/ui/FormField";
import { SettingsRow } from "@/components/ui/SettingsRow";
import { DenseActionCluster } from "@/components/ui/DenseActionCluster";
import { GroupToggleHeader } from "@/components/ui/GroupToggleHeader";
import { CopyButton } from "@/components/ui/CopyButton";
import { BareButton } from "@/components/ui/BareButton";
import { UiCopyIcon, TrashIcon, PopOutIcon } from "@/components/ui/icons";
import { CatalogEntry, SpecimenRow } from "./CatalogKit";

/**
 * Composite catalog entries (Interface Design System Sub-Issue H, #3036) — one entry
 * per contracted composite in `docs/design/design-system/composites.md`, rendering
 * every variant and state. Dev-only.
 */

function ToolbarEntry() {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  return (
    <CatalogEntry
      id="toolbar"
      title="Toolbar"
      kind="composite"
      note="Search + dense action cluster. On focus below sm the end cluster collapses so search expands."
    >
      <SpecimenRow label="search + action cluster" align="start">
        <div className="w-full max-w-md">
          <Toolbar
            className="min-w-0"
            collapseEndWhenFocused
            focused={focused}
            start={
              <SearchInput
                searchText={text}
                onSearchTextChange={setText}
                onFocusChange={setFocused}
                placeholder="Filter"
              />
            }
            end={
              <DenseActionCluster aria-label="Toolbar actions">
                <Button size="sm" variant="outline" aria-label="Copy">
                  <UiCopyIcon className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="outline" aria-label="Pop out">
                  <PopOutIcon className="h-4 w-4" />
                </Button>
              </DenseActionCluster>
            }
          />
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function StatePanelEntry() {
  return (
    <CatalogEntry
      id="state-panel"
      title="StatePanel"
      kind="composite"
      note="The empty / error / loading presentation — error announces via role=alert, loading via role=status + aria-busy."
    >
      <SpecimenRow label="empty" align="start">
        <div className="w-72 rounded-md border border-[var(--app-border)] p-6">
          <StatePanel
            variant="empty"
            title="No sessions yet"
            description="Spawn a session to get started."
            action={
              <Button size="sm" variant="outline">
                New session
              </Button>
            }
          />
        </div>
      </SpecimenRow>
      <SpecimenRow label="error" align="start">
        <div className="w-72 rounded-md border border-[var(--app-border)] p-6">
          <StatePanel
            variant="error"
            title="Something went wrong"
            description="The page failed to load."
            action={
              <Button size="sm" variant="outline">
                Reload
              </Button>
            }
          />
        </div>
      </SpecimenRow>
      <SpecimenRow label="loading" align="start">
        <div className="w-72 rounded-md border border-[var(--app-border)] p-6">
          <StatePanel variant="loading" title="Loading…" />
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function FormFieldEntry() {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  return (
    <CatalogEntry
      id="form-field"
      title="FormField"
      kind="composite"
      note="Labelled control with hint/error — wires aria-describedby + aria-invalid onto the control."
    >
      <SpecimenRow label="with hint" align="start">
        <div className="w-72">
          <FormField label="Display name" hint="Shown in the session list.">
            {control => (
              <Input
                {...control}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. rp1-worker"
              />
            )}
          </FormField>
        </div>
      </SpecimenRow>
      <SpecimenRow label="with error (required)" align="start">
        <div className="w-72">
          <FormField
            label="API token"
            required
            error={token ? undefined : "A token is required."}
          >
            {control => (
              <Input
                {...control}
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="Paste token"
              />
            )}
          </FormField>
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function SettingsRowEntry() {
  const [autoRecover, setAutoRecover] = useState(true);
  const [notify, setNotify] = useState(false);
  return (
    <CatalogEntry
      id="settings-row"
      title="SettingsRow"
      kind="composite"
      note="Settings list-item: label (+ description) ↔ a trailing control. Height responds to density."
    >
      <SpecimenRow label="rows" align="start">
        <div className="w-full max-w-md divide-y divide-[var(--app-border)] rounded-md border border-[var(--app-border)] px-4">
          <div className="py-2">
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
          <div className="py-2">
            <SettingsRow
              asLabel
              label="Push notifications"
              control={
                <Checkbox
                  aria-label="Push notifications"
                  checked={notify}
                  onChange={e => setNotify(e.target.checked)}
                />
              }
            />
          </div>
          <div className="py-2">
            <SettingsRow
              label="Managed by policy"
              description="Disabled — controlled by an administrator."
              disabled
              control={<Checkbox aria-label="Managed" disabled />}
            />
          </div>
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function DenseActionClusterEntry() {
  return (
    <CatalogEntry
      id="dense-action-cluster"
      title="DenseActionCluster"
      kind="composite"
      note="A horizontal group of equal-sized icon buttons at the dense icon-grid gap."
    >
      <SpecimenRow label="icon button group">
        <DenseActionCluster aria-label="Row actions">
          <Button size="sm" variant="outline" aria-label="Copy">
            <UiCopyIcon className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" aria-label="Pop out">
            <PopOutIcon className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="destructive" aria-label="Delete">
            <TrashIcon className="h-4 w-4" />
          </Button>
        </DenseActionCluster>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function GroupToggleHeaderEntry() {
  const [schedCollapsed, setSchedCollapsed] = useState(false);
  const [peersCollapsed, setPeersCollapsed] = useState(true);
  return (
    <CatalogEntry
      id="group-toggle-header"
      title="GroupToggleHeader"
      kind="composite"
      note="Full-width tinted collapse bar (chevron + optional icon/count/trailing). HUE-AGNOSTIC — the caller supplies the tint via className/wrapperClassName; use it standalone (caller owns the body) or with a collapsible body."
    >
      <SpecimenRow
        label="standalone bar (caller owns the body + tint)"
        align="start"
      >
        <div className="w-full max-w-md">
          <GroupToggleHeader
            collapsed={schedCollapsed}
            onToggle={() => setSchedCollapsed(c => !c)}
            label="Schedulers"
            count="3 schedulers · 2 enabled"
            className="bg-[var(--app-secondary-bg)] px-2.5 py-1 text-[var(--app-fg)] hover:opacity-90"
            wrapperClassName="border-l-4 border-l-[var(--app-border)]"
          />
        </div>
      </SpecimenRow>
      <SpecimenRow
        label="with a collapsible body (mint cluster header — click to expand)"
        align="start"
      >
        <div className="w-full max-w-md">
          <GroupToggleHeader
            collapsed={peersCollapsed}
            onToggle={() => setPeersCollapsed(c => !c)}
            label="managed peers"
            count="(2)"
            className="border-l-4 border-l-accent bg-accent/10 text-accent/70 hover:bg-accent/15 hover:text-accent"
          >
            <ul className="flex flex-col gap-1 py-1 pl-6 text-sm text-[var(--app-fg)]">
              <li>rp1-worker</li>
              <li>sl7-peer</li>
            </ul>
          </GroupToggleHeader>
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function CopyButtonEntry() {
  return (
    <CatalogEntry
      id="copy-button"
      title="CopyButton"
      kind="composite"
      note="Ghost copy control — the CopyIcon glyph swaps to CheckIcon on a successful copy. Placement is a className passthrough; the accessible name comes from title (default 'Copy') or an aria-label override."
    >
      <SpecimenRow label="default (title = Copy)">
        <CopyButton text="hello from the design catalog" />
      </SpecimenRow>
      <SpecimenRow label="message copy (aria-label override)">
        <CopyButton
          text="a chat message"
          aria-label="Copy message"
          title="Copy message"
        />
      </SpecimenRow>
      <SpecimenRow label="larger glyph (iconClassName = h-4 w-4)">
        <CopyButton text="bigger glyph" iconClassName="h-4 w-4" />
      </SpecimenRow>
      <SpecimenRow label="overridable variant (ghostStatic / bare / tooltipOnDisabled)">
        <CopyButton
          variant="ghostStatic"
          size="bare"
          tooltipOnDisabled
          text="icon-cohort copy"
          title="Copy"
        />
      </SpecimenRow>
      <SpecimenRow label="copied-state title + glyph class (click to see)">
        <CopyButton
          text="tinted check on copy"
          title="Copy"
          copiedTitle="Copied!"
          iconClassName="h-4 w-4"
          copiedIconClassName="h-4 w-4 text-[var(--app-success)]"
        />
      </SpecimenRow>
    </CatalogEntry>
  );
}

function BareButtonEntry() {
  return (
    <CatalogEntry
      id="bare-button"
      title="BareButton"
      kind="composite"
      note="The variant=ghostStatic size=bare tooltipOnDisabled Button triple, pinned (#3499). The component contributes no classes of its own — the call site owns the entire box — and delegates the disabled tooltip to Button, so a disabled + title control is focusable-but-inert with a hover/focus tooltip."
    >
      <SpecimenRow label="icon glyph (call-site h-6 w-6 rounded-full)">
        <BareButton
          type="button"
          aria-label="Pop out"
          title="Pop out"
          className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
        >
          <PopOutIcon className="h-4 w-4" />
        </BareButton>
      </SpecimenRow>
      <SpecimenRow label="bordered text chip">
        <BareButton
          type="button"
          title="Set to current date/time"
          className="shrink-0 rounded-md border border-[var(--app-border)] px-1.5 py-1 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
        >
          Now
        </BareButton>
      </SpecimenRow>
      <SpecimenRow label="disabled + title (focusable-but-inert; tooltip on hover / focus)">
        <BareButton
          type="button"
          disabled
          title="Nothing to clear yet"
          className="shrink-0 rounded-md border border-[var(--app-border)] px-1.5 py-1 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-hint)] disabled:opacity-30"
        >
          Clear
        </BareButton>
      </SpecimenRow>
    </CatalogEntry>
  );
}

export function CompositeEntries() {
  return (
    <>
      <ToolbarEntry />
      <StatePanelEntry />
      <FormFieldEntry />
      <SettingsRowEntry />
      <DenseActionClusterEntry />
      <GroupToggleHeaderEntry />
      <CopyButtonEntry />
      <BareButtonEntry />
    </>
  );
}
