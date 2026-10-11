// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { ListDetail } from "@/components/layouts/ListDetail";
import { DenseRow } from "@/components/ui/DenseRow";
import { KVGrid } from "@/components/ui/KVGrid";
import { StatusDot } from "@/components/ui/StatusDot";
import { Badge } from "@/components/ui/badge";
import { DenseActionCluster } from "@/components/ui/DenseActionCluster";
import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/ui/StatePanel";
import { UiCopyIcon, PopOutIcon, TrashIcon } from "@/components/ui/icons";

/**
 * Composition page (R4) — a dense list/detail surface assembled PURELY from shared
 * design-system parts: the `ListDetail` layout template (Sub E) wrapping `DenseRow` +
 * `StatusDot` + `Badge` + `KVGrid` + `DenseActionCluster` + `StatePanel` (Sub C/D). No
 * bespoke layout. Dev-only (rendered inside the `/design` catalog).
 */

type Session = {
  id: string;
  name: string;
  node: string;
  status: "ok" | "warn" | "hot";
  state: string;
  model: string;
};

const SESSIONS: Session[] = [
  {
    id: "s1",
    name: "issue-3036 worker",
    node: "rp1",
    status: "ok",
    state: "Active",
    model: "opus",
  },
  {
    id: "s2",
    name: "research sweep",
    node: "rp2",
    status: "warn",
    state: "Rate-limited",
    model: "sonnet",
  },
  {
    id: "s3",
    name: "federation health",
    node: "sl7",
    status: "hot",
    state: "Error",
    model: "haiku",
  },
];

const STATUS_VARIANT: Record<
  Session["status"],
  "success" | "warning" | "destructive"
> = {
  ok: "success",
  warn: "warning",
  hot: "destructive",
};

export function DenseListExample() {
  const [selectedId, setSelectedId] = useState<string>("s1");
  const selected = SESSIONS.find(s => s.id === selectedId);

  return (
    <div className="h-96 overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]">
      <ListDetail
        split
        listWidth={280}
        list={
          <div>
            {SESSIONS.map(s => (
              <button /* design-tokens-allow: dev-only /design DenseListExample specimen — a selectable-dense-row demo wrapping <DenseRow>; the raw wrapper is intentional specimen structure, not shipped UI */
                key={s.id}
                type="button"
                onClick={() => setSelectedId(s.id)}
                aria-pressed={s.id === selectedId}
                className={`block w-full text-left ${
                  s.id === selectedId ? "bg-[var(--app-subtle-bg)]" : ""
                }`}
              >
                <DenseRow
                  icon={<StatusDot status={s.status} />}
                  label={s.name}
                  value={s.node}
                  trailing={
                    <Badge variant={STATUS_VARIANT[s.status]}>{s.state}</Badge>
                  }
                />
              </button>
            ))}
          </div>
        }
        detail={
          selected ? (
            <div className="flex flex-col gap-4 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <StatusDot status={selected.status} size="md" />
                  <h3 className="text-base font-semibold text-[var(--app-fg)]">
                    {selected.name}
                  </h3>
                </div>
                <DenseActionCluster aria-label="Session actions">
                  <Button size="sm" variant="outline" aria-label="Copy id">
                    <UiCopyIcon className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="outline" aria-label="Open">
                    <PopOutIcon className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="destructive" aria-label="Delete">
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                </DenseActionCluster>
              </div>
              <KVGrid
                items={[
                  { key: "Node", value: selected.node },
                  { key: "State", value: selected.state },
                  { key: "Model", value: selected.model },
                  { key: "Session id", value: selected.id },
                ]}
              />
            </div>
          ) : (
            <StatePanel
              variant="empty"
              title="No session selected"
              description="Pick a session from the list."
              className="h-full"
            />
          )
        }
      />
    </div>
  );
}
