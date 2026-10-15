// SPDX-License-Identifier: AGPL-3.0-only
import type { McpReviewValue } from "@hapi/protocol/porter";
import type { PlannedMcpServer } from "@/types/porter";

/**
 * #5172 (#5165 R5/H3) — the definition an imported MCP server will run, shown
 * on its review row before commit: the transport, the command, each `args`
 * element, the url, `disabled`, and the `env` / `headers` slot names. The
 * commit writes this definition into `~/.claude.json` and every account config,
 * and Claude Code starts it at the next session, so the review must show it.
 *
 * Inert text only (React text nodes). A literal value is rendered with
 * `JSON.stringify`, so element boundaries, empty strings, spaces, newlines, and
 * quotes are visible. A secret slot renders as a distinct token naming the
 * slot; this component never receives a secret value (the server shows slots
 * by name, never value). Rendering branches on `kind` only, never on a value's
 * text, so a literal cannot pose as a slot.
 */

function SlotToken({ slot, testId }: { slot: string; testId: string }) {
  return (
    <span
      data-testid={testId}
      className="rounded border border-[var(--app-border)] px-1 font-mono text-[var(--app-hint)]"
    >
      secret: {slot}
    </span>
  );
}

function ReviewValue({ value }: { value: McpReviewValue }) {
  switch (value.kind) {
    case "slot":
      return <SlotToken slot={value.slot} testId="mcp-slot" />;
    case "value":
      return (
        <span className="font-mono break-all whitespace-pre-wrap">
          {JSON.stringify(value.value)}
        </span>
      );
  }
}

/** The declared secret slot names, in the server's `declaredSlotNames` order. */
function declaredSlots(s: PlannedMcpServer): string[] {
  return [
    ...(s.argsNames ?? []).map(a => a.name),
    ...(s.urlName !== undefined ? [s.urlName] : []),
    ...(s.envNames ?? []),
    ...(s.headerNames ?? []),
  ];
}

export function McpServerDefinition({ server }: { server: PlannedMcpServer }) {
  const d = server.definition;
  const id = `mcp-definition-${server.name}`;
  const slots = declaredSlots(server);
  return (
    <div
      data-testid={id}
      className="flex flex-col gap-0.5 text-[length:var(--text-caption)]"
    >
      <div className="flex flex-wrap items-center gap-2 text-[var(--app-hint)]">
        <span data-testid={`${id}-transport`} className="font-mono">
          {d.transport}
        </span>
        {d.disabled && <span data-testid={`${id}-disabled`}>disabled</span>}
      </div>
      {d.command !== undefined && (
        <div className="text-warn">
          <span className="text-[var(--app-hint)]">runs </span>
          <span
            data-testid={`${id}-command`}
            className="font-mono break-all whitespace-pre-wrap"
          >
            {d.command}
          </span>
        </div>
      )}
      {d.args !== undefined && d.args.length > 0 && (
        <ol data-testid={`${id}-args`} className="flex flex-col pl-3 text-warn">
          {d.args.map((a, i) => (
            <li key={i}>
              <span className="text-[var(--app-hint)]">[{i}] </span>
              <ReviewValue value={a} />
            </li>
          ))}
        </ol>
      )}
      {d.url !== undefined && (
        <div data-testid={`${id}-url`} className="text-warn">
          <span className="text-[var(--app-hint)]">url </span>
          <ReviewValue value={d.url} />
        </div>
      )}
      {(server.envNames ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[var(--app-hint)]">env</span>
          {server.envNames?.map((n, i) => (
            <SlotToken key={`${i}-${n}`} slot={n} testId="mcp-env-slot" />
          ))}
        </div>
      )}
      {(server.headerNames ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[var(--app-hint)]">headers</span>
          {server.headerNames?.map((n, i) => (
            <SlotToken key={`${i}-${n}`} slot={n} testId="mcp-header-slot" />
          ))}
        </div>
      )}
      {server.hasSecrets && slots.length > 0 && (
        <div
          data-testid={`${id}-secret-source`}
          className={
            server.secretRestorable ? "text-warn" : "text-[var(--app-hint)]"
          }
        >
          {server.secretRestorable
            ? `The archive supplies these values and the review does not show them: ${slots.join(", ")}`
            : "You supply these values in the re-authenticate step, or the server is skipped"}
        </div>
      )}
    </div>
  );
}
