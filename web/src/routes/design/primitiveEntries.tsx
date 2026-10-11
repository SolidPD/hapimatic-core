// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from "react";
import { Bell, LogOut } from "lucide-react";
import { AccentChip } from "@/components/ui/AccentChip";
import { IconExpandToggle } from "@/components/ui/IconExpandToggle";
import { CardHeaderTrigger } from "@/components/ui/CardHeaderTrigger";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScrollPositionRail } from "@/components/ui/ScrollPositionRail";
import {
  UiCopyIcon,
  UiCheckIcon,
  TrashIcon,
  MaximizeIcon,
  MinimizeIcon,
  PopOutIcon,
  PopInIcon,
  CloseIcon,
} from "@/components/ui/icons";
import {
  MenuRadioSection,
  MenuHeader,
  MenuTrigger,
} from "@/components/ui/menuPrimitives";
import { SortIcon } from "@/components/icons";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DenseRow } from "@/components/ui/DenseRow";
import { KVGrid } from "@/components/ui/KVGrid";
import { FilterChip } from "@/components/ui/FilterChip";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { StatusDot } from "@/components/ui/StatusDot";
import { TouchButton } from "@/components/ui/TouchButton";
import { SearchInput } from "@/components/ui/SearchInput";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { HoverTooltip } from "@/components/ui/tooltip";
import { CatalogEntry, SpecimenRow, Specimen } from "./CatalogKit";

/**
 * Primitive catalog entries (Interface Design System Sub-Issue H, #3036) — one entry
 * per contracted primitive in `docs/design/design-system/primitives.md`, rendering
 * every variant, named size, and state (incl. disabled / busy / error). Dev-only.
 */

function ButtonEntry() {
  return (
    <CatalogEntry id="button" title="Button" kind="primitive">
      <SpecimenRow label="variants">
        <Button variant="default">Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="destructive">Destructive</Button>
      </SpecimenRow>
      <SpecimenRow label="sizes">
        <Specimen caption="sm">
          <Button size="sm">Small</Button>
        </Specimen>
        <Specimen caption="default">
          <Button size="default">Default</Button>
        </Specimen>
        <Specimen caption="lg">
          <Button size="lg">Large</Button>
        </Specimen>
      </SpecimenRow>
      <SpecimenRow label="states">
        <Specimen caption="default">
          <Button>Enabled</Button>
        </Specimen>
        <Specimen caption="disabled">
          <Button disabled>Disabled</Button>
        </Specimen>
        <Specimen caption="icon-only (aria-label)">
          <Button size="sm" aria-label="Copy">
            <UiCopyIcon className="h-4 w-4" />
          </Button>
        </Specimen>
      </SpecimenRow>
      {/* #3337 Sub C — the dense icon-action button: ghost variant + icon size */}
      <SpecimenRow label="ghost / icon (#3337)">
        <Specimen caption='variant="ghost"'>
          <Button variant="ghost">Ghost</Button>
        </Specimen>
        <Specimen caption='ghost + size="icon"'>
          <Button variant="ghost" size="icon" aria-label="Copy">
            <UiCopyIcon className="h-5 w-5" />
          </Button>
        </Specimen>
        <Specimen caption="className color override">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete"
            className="text-[var(--app-badge-error-text)] hover:text-[var(--app-badge-error-text)]"
          >
            <TrashIcon className="h-5 w-5" />
          </Button>
        </Specimen>
      </SpecimenRow>
      {/* #3514 — the two #3396 primitive axes documented ALONE (the composite
          BareButton entry shows the pinned triple) */}
      <SpecimenRow label="ghostStatic / bare (#3396)">
        <Specimen caption='variant="ghostStatic" (hover-inert)'>
          <Button variant="ghostStatic">Ghost static</Button>
        </Specimen>
        <Specimen caption='size="bare" (box neutralizer)'>
          <Button size="bare">Bare</Button>
        </Specimen>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function TooltipEntry() {
  return (
    <CatalogEntry
      id="tooltip"
      title="Tooltip"
      kind="primitive"
      note="HoverTooltip (#3462) — the accessible hover / keyboard-focus tooltip (Radix Tooltip) that swaps to a tap-to-reveal Radix Popover on a coarse pointer. Button consumes it for the disabled + tooltipOnDisabled + title case (ruling c1): the control renders focusable-but-inert (aria-disabled) so keyboard and touch users get the explanation while activation stays blocked. Named HoverTooltip because NewSession/FormField.tsx already exports a click-to-toggle Tooltip. Button renders the sibling HoverTooltipButton (the Radix Trigger AS the button, no Slot) — an asChild trigger feeds Radix Tooltip's state-held trigger from every commit and can turn a latent effect loop in the host page into a hard crash."
    >
      <SpecimenRow label="hover / focus reveal">
        <Specimen caption="hover or Tab-focus · Escape dismisses">
          <HoverTooltip content="Reveals on hover and on keyboard focus">
            <Button variant="secondary">Hover or focus me</Button>
          </HoverTooltip>
        </Specimen>
        <Specimen caption='side="bottom"'>
          <HoverTooltip content="Placed below the trigger" side="bottom">
            <Button variant="outline">Below</Button>
          </HoverTooltip>
        </Specimen>
      </SpecimenRow>
      <SpecimenRow label="Button integration (disabled + tooltipOnDisabled + title, #3462 c1)">
        <Specimen caption="focusable-but-inert · aria-disabled · tooltip on focus/hover">
          <Button disabled title="Select a machine first" tooltipOnDisabled>
            Browse directories
          </Button>
        </Specimen>
        <Specimen caption="without a title → native disabled (unchanged)">
          <Button disabled tooltipOnDisabled>
            No title
          </Button>
        </Specimen>
      </SpecimenRow>
      <SpecimenRow label="touch">
        <Specimen caption="on (hover: none) every HoverTooltip is tap-to-reveal: tap toggles; Escape / outside tap / scroll dismiss">
          <HoverTooltip content="Tap-to-reveal on a coarse pointer">
            <Button variant="ghost">Touch variant</Button>
          </HoverTooltip>
        </Specimen>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function AccentChipEntry() {
  return (
    <CatalogEntry
      id="accent-chip"
      title="AccentChip"
      kind="primitive"
      note="Decorative 8×8 accent chip (aria-hidden) — an icon centered on a 15% color-mix tint of a caller-supplied accent. Content-agnostic: the caller passes the icon/node as children and owns its color (unlike the title-specific TitleChip)."
    >
      <SpecimenRow label="accents (caller-supplied — icon color matches)">
        <Specimen caption="accent-red-500 (Sign-Out)">
          <AccentChip accent="var(--accent-red-500)">
            <LogOut
              className="h-4 w-4"
              style={{ color: "var(--accent-red-500)" }}
            />
          </AccentChip>
        </Specimen>
        <Specimen caption="accent-amber-400 (Notifications)">
          <AccentChip accent="var(--accent-amber-400)">
            <Bell
              className="h-4 w-4"
              style={{ color: "var(--accent-amber-400)" }}
            />
          </AccentChip>
        </Specimen>
        <Specimen caption="neutral (--app-fg)">
          <AccentChip accent="var(--app-fg)">
            {/* ui/icons colour via currentColor (parent text-*), not a style prop */}
            <UiCopyIcon className="h-4 w-4 text-[var(--app-fg)]" />
          </AccentChip>
        </Specimen>
      </SpecimenRow>
      <SpecimenRow label="states">
        <Specimen caption="default only · decorative (aria-hidden)">
          <AccentChip accent="var(--accent-red-500)">
            <LogOut
              className="h-4 w-4"
              style={{ color: "var(--accent-red-500)" }}
            />
          </AccentChip>
        </Specimen>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function IconExpandToggleEntry() {
  const [expanded, setExpanded] = useState(false);
  return (
    <CatalogEntry
      id="icon-expand-toggle"
      title="IconExpandToggle"
      kind="primitive"
      note="The ghost expand-chevron toggle shared by the system-jobs cards (#3421 — dedupe of the block that repeated 4× across SystemJobCard.tsx and LoopCronCard.tsx). Presentational: the parent owns the expanded state and passes it in; activation is reported through onToggle. A fixed 32px (h-8 w-8) ghostStatic Button (hover-inert; moved off ghost+override by #3464 B8) rendering ChevronDown (expanded) / ChevronRight (collapsed)."
    >
      <SpecimenRow label="interactive (parent owns expanded state)">
        <Specimen caption="click to toggle expanded / collapsed">
          <IconExpandToggle
            expanded={expanded}
            onToggle={() => setExpanded(v => !v)}
            aria-label={expanded ? "Collapse" : "Expand"}
          />
        </Specimen>
      </SpecimenRow>
      <SpecimenRow label="states">
        <Specimen caption="expanded · ChevronDown · aria-expanded=true">
          <IconExpandToggle
            expanded
            onToggle={() => {}}
            aria-label="Collapse"
          />
        </Specimen>
        <Specimen caption="collapsed · ChevronRight · aria-expanded=false">
          <IconExpandToggle
            expanded={false}
            onToggle={() => {}}
            aria-label="Expand"
          />
        </Specimen>
        <Specimen caption="data-testid passthrough">
          <IconExpandToggle
            expanded={false}
            onToggle={() => {}}
            aria-label="Expand"
            data-testid="catalog-icon-expand"
          />
        </Specimen>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function CardHeaderTriggerEntry() {
  return (
    <CatalogEntry
      id="card-header-trigger"
      title="CardHeaderTrigger"
      kind="primitive"
      note="The shared DialogTrigger-asChild card-header focus-wrapper (#3500 — consolidation of the prop-identical DiffView + ToolCard wrappers). A full-width, left-aligned native button element that owns usePointerFocusRing: a mouse click never shows the focus ring, a keyboard Tab does. Deliberately not a Button — its box (bg / hover / height / font-medium / rounded) would alter the bare rich header (L6 #3408)."
    >
      <SpecimenRow label="under DialogTrigger asChild (click, or Tab + Enter, to open)">
        <Specimen caption="card header → opens a Dialog">
          <Card className="w-64 overflow-hidden shadow-sm">
            <CardHeader className="p-3 space-y-0">
              <Dialog>
                <DialogTrigger asChild>
                  <CardHeaderTrigger>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-3">
                        <CardTitle className="min-w-0 text-sm font-medium leading-tight break-words">
                          Edit src/app.tsx
                        </CardTitle>
                        <span className="shrink-0 text-xs text-[var(--app-link)]">
                          View
                        </span>
                      </div>
                      <CardDescription className="font-mono text-xs break-all opacity-80">
                        old: 120 chars → new: 132 chars
                      </CardDescription>
                    </div>
                  </CardHeaderTrigger>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Edit src/app.tsx</DialogTitle>
                    <DialogDescription>
                      Catalog specimen — the dialog body is the caller's.
                    </DialogDescription>
                  </DialogHeader>
                </DialogContent>
              </Dialog>
            </CardHeader>
          </Card>
        </Specimen>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function BadgeEntry() {
  return (
    <CatalogEntry id="badge" title="Badge" kind="primitive">
      <SpecimenRow label="variants">
        <Badge variant="default">default</Badge>
        <Badge variant="warning">warning</Badge>
        <Badge variant="success">success</Badge>
        <Badge variant="destructive">destructive</Badge>
        <Badge variant="mint">mint</Badge>
        <Badge variant="subscription">subscription</Badge>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function CardEntry() {
  return (
    <CatalogEntry id="card" title="Card family" kind="primitive">
      <SpecimenRow label="Card + CardHeader + CardContent" align="start">
        <Card className="w-64">
          <CardHeader>
            <CardTitle>Card title</CardTitle>
            <CardDescription>
              A rounded surface with an optional header and content region.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-[var(--app-fg)]">
              Content composed via CardContent.
            </p>
          </CardContent>
        </Card>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function DialogEntry() {
  return (
    <CatalogEntry id="dialog" title="Dialog family" kind="primitive">
      <SpecimenRow label="overlay (click to open)">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Dialog title</DialogTitle>
              <DialogDescription>
                A focus-trapped, keyboard-dismissable modal panel.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm text-[var(--app-fg)]">
              Press Escape or tap the backdrop to close.
            </p>
          </DialogContent>
        </Dialog>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function DropdownMenuEntry() {
  const [sort, setSort] = useState("recent");
  return (
    <CatalogEntry
      id="dropdown-menu"
      title="DropdownMenu family"
      kind="primitive"
    >
      <SpecimenRow label="menu (click to open)">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Open menu</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem>Edit</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
              <DropdownMenuRadioItem value="recent">
                Most recent
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function PopoverEntry() {
  return (
    <CatalogEntry id="popover" title="Popover family" kind="primitive">
      <SpecimenRow label="popover (click to open)">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">Open popover</Button>
          </PopoverTrigger>
          <PopoverContent>
            <p className="text-sm text-[var(--app-fg)]">
              A positioned panel anchored to its trigger.
            </p>
          </PopoverContent>
        </Popover>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function CommandEntry() {
  return (
    <CatalogEntry id="command" title="Command family" kind="primitive">
      <SpecimenRow label="command palette (type to filter)" align="start">
        <div className="w-72 rounded-md border border-[var(--app-border)]">
          <Command>
            <CommandInput placeholder="Search commands…" />
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>
              <CommandGroup heading="Sessions">
                <CommandItem>New session</CommandItem>
                <CommandItem>Spawn peer session</CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Navigation">
                <CommandItem>Go to settings</CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function ScrollAreaEntry() {
  return (
    <CatalogEntry id="scroll-area" title="ScrollArea" kind="primitive">
      <SpecimenRow label="scrollable viewport" align="start">
        <ScrollArea className="h-32 w-64 rounded-md border border-[var(--app-border)] p-3">
          <div className="flex flex-col gap-2">
            {Array.from({ length: 12 }, (_, i) => (
              <p key={i} className="text-sm text-[var(--app-fg)]">
                Scrollable row {i + 1}
              </p>
            ))}
          </div>
        </ScrollArea>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function ScrollPositionRailEntry() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <CatalogEntry
      id="scroll-position-rail"
      title="ScrollPositionRail"
      kind="primitive"
      note="Read-only 3px accent position rail overlaid on the right edge of a scroll container whose native scrollbar is hidden (scrollbar-none). Renders nothing until the content overflows; a user scroll gesture reveals it and it idle-hides. Scroll the box to reveal it."
    >
      <SpecimenRow label="overlaid rail (scroll to reveal)" align="start">
        <div className="relative h-32 w-64 rounded-md border border-[var(--app-border)]">
          <div
            ref={scrollRef}
            className="scrollbar-none h-full overflow-y-auto p-3"
          >
            <div className="flex flex-col gap-2">
              {Array.from({ length: 16 }, (_, i) => (
                <p key={i} className="text-sm text-[var(--app-fg)]">
                  Scrollable row {i + 1}
                </p>
              ))}
            </div>
          </div>
          <ScrollPositionRail scrollRef={scrollRef} />
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function IconsEntry() {
  const icons = [
    { name: "Copy", El: UiCopyIcon },
    { name: "Check", El: UiCheckIcon },
    { name: "Trash", El: TrashIcon },
    { name: "Maximize", El: MaximizeIcon },
    { name: "Minimize", El: MinimizeIcon },
    { name: "PopOut", El: PopOutIcon },
    { name: "PopIn", El: PopInIcon },
    { name: "Close", El: CloseIcon },
  ];
  return (
    <CatalogEntry
      id="icons"
      title="ui/icons"
      kind="primitive"
      note="Stateless 24×24 glyphs — size via h-N/w-N, color inherited from the parent's text-*."
    >
      <SpecimenRow label="glyphs">
        {icons.map(({ name, El }) => (
          <Specimen key={name} caption={name}>
            <El className="h-5 w-5 text-[var(--app-fg)]" />
          </Specimen>
        ))}
      </SpecimenRow>
    </CatalogEntry>
  );
}

function MenuPrimitivesEntry() {
  const [value, setValue] = useState("recent");
  return (
    <CatalogEntry
      id="menu-primitives"
      title="menuPrimitives"
      kind="primitive"
      note="Menu composition helpers — MenuTrigger (the shared filter/sort toolbar trigger, #3500: one native button element carrying menuTriggerClass(active), mint while the selection is non-default) + MenuHeader + MenuRadioSection — rendered inside a DropdownMenu."
    >
      <SpecimenRow label="MenuTrigger + menu header + radio section (click to open; the trigger turns mint once the selection is non-default)">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <MenuTrigger active={value !== "recent"} title="Sort menu">
              <SortIcon className="h-3.5 w-3.5" />
              <span>Sort</span>
            </MenuTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <MenuHeader
              title="Sort"
              clearLabel="Reset sort"
              showClear={value !== "recent"}
              onClear={() => setValue("recent")}
            />
            <MenuRadioSection
              value={value}
              options={[
                { value: "recent", label: "Most recent" },
                { value: "name", label: "Name" },
                { value: "activity", label: "Last activity" },
              ]}
              onChange={setValue}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function CollapsibleSectionEntry() {
  return (
    <CatalogEntry
      id="collapsible-section"
      title="CollapsibleSection"
      kind="primitive"
    >
      <SpecimenRow label="collapsed / expanded (click header)" align="start">
        <div className="w-72">
          <CollapsibleSection
            title="Advanced options"
            summary="3 configured"
            defaultOpen={false}
          >
            <p className="text-sm text-[var(--app-fg)]">
              Body content revealed only when expanded.
            </p>
          </CollapsibleSection>
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function ConfirmDialogEntry() {
  const [open, setOpen] = useState(false);
  const [destructiveOpen, setDestructiveOpen] = useState(false);
  return (
    <CatalogEntry
      id="confirm-dialog"
      title="ConfirmDialog"
      kind="primitive"
      note="A Dialog composite with Cancel/Confirm and a pending spinner."
    >
      <SpecimenRow label="default / destructive (click to open)">
        <Button variant="outline" onClick={() => setOpen(true)}>
          Confirm action
        </Button>
        <Button variant="destructive" onClick={() => setDestructiveOpen(true)}>
          Delete…
        </Button>
      </SpecimenRow>
      <ConfirmDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Confirm action"
        description="This is a demonstration of the standard confirm flow."
        confirmLabel="Confirm"
        confirmingLabel="Confirming…"
        onConfirm={async () => setOpen(false)}
        isPending={false}
      />
      <ConfirmDialog
        isOpen={destructiveOpen}
        onClose={() => setDestructiveOpen(false)}
        title="Delete item?"
        description="Destructive variant — this cannot be undone (demo only)."
        confirmLabel="Delete"
        confirmingLabel="Deleting…"
        onConfirm={async () => setDestructiveOpen(false)}
        isPending={false}
        destructive
      />
    </CatalogEntry>
  );
}

function DenseRowEntry() {
  return (
    <CatalogEntry
      id="dense-row"
      title="DenseRow"
      kind="primitive"
      note="Read-only key/value row — height responds to the density control above."
    >
      <SpecimenRow label="rows" align="start">
        <div className="w-72 rounded-md border border-[var(--app-border)]">
          <DenseRow
            icon={<UiCheckIcon className="h-4 w-4" />}
            label="Status"
            value="Active"
            trailing={<StatusDot status="ok" />}
          />
          <DenseRow label="Region" value="us-east-1" />
          <DenseRow
            label="Health"
            value="Degraded"
            trailing={<StatusDot status="warn" />}
          />
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function KVGridEntry() {
  return (
    <CatalogEntry id="kv-grid" title="KVGrid" kind="primitive">
      <SpecimenRow label="key/value grid" align="start">
        <div className="w-full max-w-md">
          <KVGrid
            items={[
              { key: "Node", value: "rp1" },
              { key: "Launcher", value: "sdk" },
              { key: "Model", value: "opus" },
              { key: "Account", value: "user@example.com" },
            ]}
          />
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function FilterChipEntry() {
  const [active, setActive] = useState(true);
  return (
    <CatalogEntry id="filter-chip" title="FilterChip" kind="primitive">
      <SpecimenRow label="states (click to toggle active)">
        <Specimen caption="idle">
          <FilterChip label="Status" onClick={() => undefined} />
        </Specimen>
        <Specimen caption="active">
          <FilterChip
            label="Status"
            value="Open"
            active={active}
            onClick={() => setActive(a => !a)}
          />
        </Specimen>
        <Specimen caption="expanded">
          <FilterChip label="Sort" value="Recent" expanded />
        </Specimen>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function SegmentedToggleEntry() {
  const [value, setValue] = useState<"list" | "grid" | "board">("list");
  const [density, setDensity] = useState<"normal" | "compact" | "ultra">(
    "normal"
  );
  const [shapeMode, setShapeMode] = useState<"tier" | "custom">("tier");
  return (
    <CatalogEntry
      id="segmented-toggle"
      title="SegmentedToggle"
      kind="primitive"
    >
      <SpecimenRow label="default (arrow keys navigate)">
        <SegmentedToggle
          ariaLabel="View"
          value={value}
          onChange={setValue}
          options={[
            { value: "list", label: "List" },
            { value: "grid", label: "Grid" },
            { value: "board", label: "Board" },
          ]}
        />
      </SpecimenRow>
      <SpecimenRow label="accent-filled · fullWidth (settings radio-rows, #3339)">
        {/* Bounded width so the fullWidth (flex-1) segments have a container to fill. */}
        <div className="w-72">
          <SegmentedToggle
            ariaLabel="Row density"
            variant="accent-filled"
            fullWidth
            value={density}
            onChange={setDensity}
            options={[
              { value: "normal", label: "Normal" },
              { value: "compact", label: "Compact" },
              { value: "ultra", label: "Ultra" },
            ]}
          />
        </div>
      </SpecimenRow>
      <SpecimenRow label="outline · fullWidth (NewVmForm shape mode, #3510)">
        {/* Bounded width so the fullWidth (flex-1) segments have a container to fill. */}
        <div className="w-72">
          <SegmentedToggle
            ariaLabel="VM shape mode"
            variant="outline"
            fullWidth
            value={shapeMode}
            onChange={setShapeMode}
            options={[
              { value: "tier", label: "Tier" },
              { value: "custom", label: "Custom" },
            ]}
          />
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function StatusDotEntry() {
  return (
    <CatalogEntry id="status-dot" title="StatusDot" kind="primitive">
      <SpecimenRow label="variants (ok / warn / hot)">
        <Specimen caption="ok">
          <StatusDot status="ok" />
        </Specimen>
        <Specimen caption="warn">
          <StatusDot status="warn" />
        </Specimen>
        <Specimen caption="hot">
          <StatusDot status="hot" />
        </Specimen>
      </SpecimenRow>
      <SpecimenRow label="sizes">
        <Specimen caption="sm (8px)">
          <StatusDot status="ok" size="sm" />
        </Specimen>
        <Specimen caption="md (10px)">
          <StatusDot status="ok" size="md" />
        </Specimen>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function TouchButtonEntry() {
  const [taps, setTaps] = useState(0);
  return (
    <CatalogEntry
      id="touch-button"
      title="TouchButton"
      kind="primitive"
      note="Fires on touchend (before iOS keyboard dismiss), falls back to click on desktop."
    >
      <SpecimenRow label="touch-first action">
        <TouchButton
          onAction={() => setTaps(t => t + 1)}
          className="rounded-md bg-[var(--app-secondary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--app-fg)] hover:opacity-90"
        >
          Tapped {taps} times
        </TouchButton>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function SearchInputEntry() {
  const [text, setText] = useState("");
  return (
    <CatalogEntry id="search-input" title="SearchInput" kind="primitive">
      <SpecimenRow
        label="search composite (type to see clear button)"
        align="start"
      >
        <div className="w-72">
          <SearchInput
            searchText={text}
            onSearchTextChange={setText}
            placeholder="Search sessions"
          />
        </div>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function InputEntry() {
  return (
    <CatalogEntry id="input" title="Input" kind="primitive">
      <SpecimenRow label="states" align="start">
        <Specimen caption="default">
          <Input
            aria-label="Name"
            placeholder="Enter a name"
            className="w-56"
          />
        </Specimen>
        <Specimen caption="disabled">
          <Input
            aria-label="Disabled"
            placeholder="Disabled"
            disabled
            className="w-56"
          />
        </Specimen>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function TextareaEntry() {
  return (
    <CatalogEntry id="textarea" title="Textarea" kind="primitive">
      <SpecimenRow label="states" align="start">
        <Specimen caption="default">
          <Textarea
            aria-label="Notes"
            placeholder="Multi-line input…"
            className="w-64"
          />
        </Specimen>
        <Specimen caption="disabled">
          <Textarea
            aria-label="Disabled notes"
            placeholder="Disabled"
            disabled
            className="w-64"
          />
        </Specimen>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function SelectEntry() {
  const [value, setValue] = useState("normal");
  return (
    <CatalogEntry id="select" title="Select" kind="primitive">
      <SpecimenRow label="states" align="start">
        <Specimen caption="default">
          <Select
            aria-label="Density"
            value={value}
            onChange={e => setValue(e.target.value)}
            className="w-56"
          >
            <option value="normal">Normal</option>
            <option value="compact">Compact</option>
            <option value="ultra">Ultra</option>
          </Select>
        </Specimen>
        <Specimen caption="disabled">
          <Select aria-label="Disabled select" disabled className="w-56">
            <option>Disabled</option>
          </Select>
        </Specimen>
      </SpecimenRow>
    </CatalogEntry>
  );
}

function CheckboxEntry() {
  const [checked, setChecked] = useState(true);
  return (
    <CatalogEntry id="checkbox" title="Checkbox" kind="primitive">
      <SpecimenRow label="states">
        <Specimen caption="unchecked / checked">
          <Checkbox
            aria-label="Toggle"
            checked={checked}
            onChange={e => setChecked(e.target.checked)}
          />
        </Specimen>
        <Specimen caption="disabled">
          <Checkbox aria-label="Disabled" disabled />
        </Specimen>
        <Specimen caption="disabled checked">
          <Checkbox aria-label="Disabled checked" disabled defaultChecked />
        </Specimen>
      </SpecimenRow>
    </CatalogEntry>
  );
}

export function PrimitiveEntries() {
  return (
    <>
      <ButtonEntry />
      <TooltipEntry />
      <AccentChipEntry />
      <IconExpandToggleEntry />
      <CardHeaderTriggerEntry />
      <BadgeEntry />
      <CardEntry />
      <DialogEntry />
      <DropdownMenuEntry />
      <PopoverEntry />
      <CommandEntry />
      <ScrollAreaEntry />
      <ScrollPositionRailEntry />
      <IconsEntry />
      <MenuPrimitivesEntry />
      <CollapsibleSectionEntry />
      <ConfirmDialogEntry />
      <DenseRowEntry />
      <KVGridEntry />
      <FilterChipEntry />
      <SegmentedToggleEntry />
      <StatusDotEntry />
      <TouchButtonEntry />
      <SearchInputEntry />
      <InputEntry />
      <TextareaEntry />
      <SelectEntry />
      <CheckboxEntry />
    </>
  );
}
