// SPDX-License-Identifier: AGPL-3.0-only
/**
 * McpSetField (issue #6171) — the New Session form's MCP server picker.
 *
 * A memoized child of the 2,300-line form: it owns the catalog read and the draft,
 * so catalog updates never re-render the form, and it reports only the resulting
 * MCP set through `onChange`:
 *  - untouched → `undefined`: the request carries no set, so the target applies
 *    the project's default, else every server (today's behavior);
 *  - touched → `{ mode: "only", servers, enableForProject }`, where
 *    `enableForProject` lists the ticked servers that are off for the project
 *    (turning one on is project-wide; the section says so under the list).
 *
 * The baseline the rows start from is the project's default set when one is
 * stored, else every server that is not off for the project. Changing the node or
 * the directory starts the draft again from the new project's baseline, because
 * a pick is a choice of servers for one project.
 *
 * The footer saves the current picks as the project's default (or clears it).
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { McpSet } from "@hapi/protocol";
import type { McpCatalogResponse } from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import { McpServersSection } from "@/components/session/McpServersSection";
import { BareButton } from "@/components/ui/BareButton";
import { HoverTooltip } from "@/components/ui/tooltip";
import { useMcpCatalog } from "@/hooks/queries/useMcpCatalog";
import { useSaveMcpProjectDefault } from "@/hooks/mutations/useSaveMcpProjectDefault";

export type McpSetFieldProps = {
  api: ApiClient | null;
  /** `fields.mcpServers.visible` from the form state. */
  visible: boolean;
  /** `fields.mcpServers.disabled` from the form state. */
  disabled: boolean;
  /** `fields.mcpServers.note`: why the field is disabled, for the tooltip. */
  disabledReason?: string;
  /** The committed working directory. */
  directory: string;
  /** The remote node id, or null for this node. */
  nodeId: string | null;
  /** False while the directory is known not to exist on the target. */
  directoryExists: boolean;
  /** The set to send, or `undefined` to send none. */
  onChange: (set: McpSet | undefined) => void;
};

/**
 * name → ticked, before any user pick: what an untouched form gets. A server off
 * for the project starts unticked even when the project default names it,
 * because the target applies a default without turning such a server on
 * (`mcp_default_server_disabled`), so a tick there would show a server the
 * session will not have (#6171 review W2).
 */
export function mcpBaseline(
  catalog: McpCatalogResponse | undefined
): Record<string, boolean> {
  const baseline: Record<string, boolean> = {};
  if (!catalog) return baseline;
  const preset =
    catalog.projectDefault?.mode === "only"
      ? new Set(catalog.projectDefault.servers)
      : null;
  for (const server of catalog.servers) {
    baseline[server.name] =
      !server.projectDisabled && (preset ? preset.has(server.name) : true);
  }
  return baseline;
}

/** Servers the project default names that are off for the project. */
export function defaultNamesOffForProject(
  catalog: McpCatalogResponse | undefined
): string[] {
  if (catalog?.projectDefault?.mode !== "only") return [];
  const named = new Set(catalog.projectDefault.servers);
  return catalog.servers
    .filter(server => server.projectDisabled && named.has(server.name))
    .map(server => server.name);
}

/** "a", "a and b", "a, b and c". */
function listNames(names: string[]): string {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Why a server the project default names starts unticked, if any does and the
 * draft has not ticked it since.
 */
export function defaultOffNote(
  catalog: McpCatalogResponse | undefined,
  desired: Record<string, boolean> = {}
): string | undefined {
  const names = defaultNamesOffForProject(catalog).filter(
    name => !desired[name]
  );
  if (names.length === 0) return undefined;
  const one = names.length === 1;
  const it = one ? "it" : "them";
  return `The project default names ${listNames(names)}, which ${
    one ? "is" : "are"
  } off for this project, so new sessions start without ${it}. Tick ${it} to turn ${it} on for this project.`;
}

/** The set a touched draft sends, over the catalog's current rows. */
export function mcpSetFromDraft(
  catalog: McpCatalogResponse | undefined,
  desired: Record<string, boolean>
): Extract<McpSet, { mode: "only" }> {
  const servers = (catalog?.servers ?? [])
    .filter(server => desired[server.name])
    .map(server => server.name)
    .sort();
  const enableForProject = (catalog?.servers ?? [])
    .filter(server => desired[server.name] && server.projectDisabled)
    .map(server => server.name)
    .sort();
  return {
    mode: "only",
    servers,
    ...(enableForProject.length > 0 ? { enableForProject } : {}),
  };
}

export const McpSetField = memo(function McpSetField({
  api,
  visible,
  disabled,
  disabledReason,
  directory,
  nodeId,
  directoryExists,
  onChange,
}: McpSetFieldProps) {
  const trimmedDirectory = directory.trim();
  const projectDefault = useSaveMcpProjectDefault(api);
  const { catalog, isLoading, unavailable } = useMcpCatalog({
    api,
    directory: trimmedDirectory,
    nodeId,
    enabled: visible && !disabled && directoryExists,
  });

  // The user's picks, by name; `null` = untouched.
  const [picks, setPicks] = useState<Record<string, boolean> | null>(null);
  const saving = projectDefault.isPending;

  // A new node or directory is a new project: start from its baseline.
  useEffect(() => {
    setPicks(null);
  }, [nodeId, trimmedDirectory]);

  const baseline = useMemo(() => mcpBaseline(catalog), [catalog]);
  const desired = useMemo(
    () => ({ ...baseline, ...(picks ?? {}) }),
    [baseline, picks]
  );

  // Report the set only when it changes, so the form re-renders rarely. Never a
  // set without a list: an empty one would start the session with only `hapi`.
  const outgoing =
    visible && picks && catalog ? mcpSetFromDraft(catalog, desired) : undefined;
  const outgoingKey = outgoing ? JSON.stringify(outgoing) : "";
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastKey.current === outgoingKey) return;
    lastKey.current = outgoingKey;
    onChange(outgoing);
    // `outgoing` is derived from `outgoingKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outgoingKey, onChange]);

  if (!visible) return null;

  if (disabled && disabledReason) {
    return (
      <HoverTooltip content={disabledReason}>
        <div className="flex items-center gap-2 border-t border-[var(--app-divider)] pb-1 pt-3 text-sm font-semibold text-[var(--app-hint)]">
          <span>MCP Servers</span>
          <span className="truncate text-xs font-normal">
            every server (this node cannot choose)
          </span>
        </div>
      </HoverTooltip>
    );
  }

  // No usable list (no directory yet, or the node cannot answer): no picker,
  // and no set is sent.
  if (!trimmedDirectory || !directoryExists || unavailable) return null;

  const saveDefault = async (set: McpSet | null): Promise<void> => {
    try {
      await projectDefault.save({ directory: trimmedDirectory, nodeId, set });
      // The saved default is now the baseline the rows start from.
      setPicks(null);
    } catch {
      // Shown under the list from the mutation's error.
    }
  };

  const footer = (
    <>
      <HoverTooltip content="New sessions in this project start with these servers unless a session picks its own.">
        <BareButton
          type="button"
          disabled={disabled || saving}
          onClick={() => {
            const { servers } = mcpSetFromDraft(catalog, desired);
            void saveDefault({ mode: "only", servers });
          }}
          className="min-w-0 justify-start text-xs font-normal text-[var(--app-link)] hover:underline disabled:opacity-50"
        >
          {/* An inline-flex button cannot ellipsize its own text, so the label
              truncates in a span: at 393 px, with "Clear default" shown, it
              would otherwise clip at both ends. */}
          <span className="truncate">Save as project default</span>
        </BareButton>
      </HoverTooltip>
      {catalog?.projectDefault && (
        <HoverTooltip content="New sessions in this project start with every server that is on for it.">
          <BareButton
            type="button"
            disabled={disabled || saving}
            onClick={() => void saveDefault(null)}
            className="shrink-0 text-xs font-normal text-[var(--app-link)] hover:underline disabled:opacity-50"
          >
            Clear default
          </BareButton>
        </HoverTooltip>
      )}
    </>
  );

  return (
    <McpServersSection
      servers={catalog?.servers ?? []}
      isLoading={isLoading}
      desired={desired}
      disabled={disabled || saving}
      footer={footer}
      note={projectDefault.error ?? defaultOffNote(catalog, desired)}
      onToggleServer={(name, enabled) =>
        setPicks(current => ({ ...(current ?? {}), [name]: enabled }))
      }
      onSetAll={enabled =>
        setPicks(() => {
          const next: Record<string, boolean> = {};
          for (const server of catalog?.servers ?? []) {
            next[server.name] = enabled;
          }
          return next;
        })
      }
    />
  );
});
