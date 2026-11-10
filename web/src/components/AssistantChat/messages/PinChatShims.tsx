// SPDX-License-Identifier: AGPL-3.0-only
import {
  memo,
  Suspense,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  CodeHeaderProps,
  SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown";
import type { ApiClient } from "@/api/client";
import { SyntaxHighlighter } from "@/components/assistant-ui/shiki-highlighter";
import { useOptionalHappyChatContext } from "@/components/AssistantChat/context";
import type { ChatBlock, ToolCallBlock } from "@/chat/types";
import { useVersion } from "@/hooks/useVersion";
import { lazyWithLoadError } from "@/lib/lazyWithPreload";

/**
 * #6450: the chat's pin shims (main bundle). They decide whether a `hapi_pin`
 * fence or a pin tool call names a pin, and lazy-load the card into the Pins
 * chunk. Deliberately free of any pin schema or the Ledger: those load Zod and
 * the main bundle sits close to the PWA precache limit (vite.config.ts).
 */

type InlinePinCardProps = {
  api: ApiClient;
  sessionId: string;
  pinKey: string;
  sessionActive: boolean;
  fallback: ReactNode;
};

/** A card whose chunk cannot load stays what it replaces (the code block). */
function InlinePinCardLoadError(props: InlinePinCardProps): ReactElement {
  return <>{props.fallback}</>;
}

const LazyInlinePinCard = lazyWithLoadError<InlinePinCardProps>(
  () => import("@/components/pins/InlinePinCard"),
  InlinePinCardLoadError
);

/** `PIN_FENCE_LANGUAGE`, as a literal (PinChatShims.test.tsx keeps them equal). */
export const PIN_FENCE_LANGUAGE_LITERAL = "hapi_pin";

const PIN_KEY_MAX = 200;
const KEY_CACHE_MAX = 64;
const keyByCode = new Map<string, string | null>();

/**
 * The key a fence body names, or null when it is not JSON with a 1-200
 * character string `key`. A body still streaming (anything not ending in `}`)
 * is neither parsed nor cached, so the partials of one fence never fill the
 * cache; a complete body is parsed once, because the text above a fence
 * re-renders on every streamed token.
 */
export function pinKeyFromFence(code: string): string | null {
  const body = code.trim();
  if (!body.endsWith("}")) return null;
  const cached = keyByCode.get(body);
  if (cached !== undefined) return cached;
  let key: string | null = null;
  try {
    const parsed = JSON.parse(body) as { key?: unknown };
    if (
      typeof parsed?.key === "string" &&
      parsed.key.length > 0 &&
      parsed.key.length <= PIN_KEY_MAX
    ) {
      key = parsed.key;
    }
  } catch {
    key = null;
  }
  if (keyByCode.size >= KEY_CACHE_MAX) keyByCode.clear();
  keyByCode.set(body, key);
  return key;
}

const PIN_TOOLS = new Set([
  "mcp__hapi__pin_post",
  "mcp__hapi__pin_update",
  "hapi__pin_post",
  "hapi__pin_update",
]);

/** The pin a `pin_post` / `pin_update` call names, unless the call failed. */
export function pinToolKey(block: ToolCallBlock): string | null {
  if (!PIN_TOOLS.has(block.tool.name) || block.tool.state === "error") {
    return null;
  }
  const input = block.tool.input as { key?: unknown } | null | undefined;
  const key = input && typeof input === "object" ? input.key : undefined;
  return typeof key === "string" && key.length > 0 && key.length <= PIN_KEY_MAX
    ? key
    : null;
}

/** Every pin a tool call or its descendants post, once each, in order. */
export function collectPinKeysDeep(block: ChatBlock): string[] {
  const keys: string[] = [];
  const walk = (b: ChatBlock) => {
    if (b.kind !== "tool-call") return;
    const key = pinToolKey(b);
    if (key && !keys.includes(key)) keys.push(key);
    for (const child of b.children ?? []) walk(child);
  };
  walk(block);
  return keys;
}

/** Reserves the collapsed row, so a card that loads late moves nothing. */
function Placeholder() {
  return (
    <div
      aria-busy="true"
      className="my-1 rounded-md border border-[var(--app-divider)]"
      style={{ minHeight: "36px" }}
    />
  );
}

/** The card, when the gate is open and a chat surrounds it; else `fallback`. */
function PinCard(props: { pinKey: string; fallback: ReactNode }) {
  const ctx = useOptionalHappyChatContext();
  const pinsEnabled = useVersion().data?.pinsEnabled === true;
  if (!ctx || !pinsEnabled) return <>{props.fallback}</>;
  return (
    <Suspense fallback={<Placeholder />}>
      <LazyInlinePinCard
        api={ctx.api}
        sessionId={ctx.sessionId}
        sessionActive={!ctx.disabled}
        pinKey={props.pinKey}
        fallback={props.fallback}
      />
    </Suspense>
  );
}

/**
 * The `SyntaxHighlighter` override for `hapi_pin` fences. Module-level, so
 * assistant-ui's memoized `CodeOverride` skips it while later text streams.
 * Anything it cannot read as a pin stays the ordinary code block it is today.
 */
export function PinFence(props: SyntaxHighlighterProps): ReactElement {
  const key = pinKeyFromFence(props.code);
  const block = <SyntaxHighlighter {...props} />;
  if (!key) return block;
  return <PinCard pinKey={key} fallback={block} />;
}

/** A pin tool call's card, below the tool row. Renders nothing when it cannot. */
export const ToolPinCard = memo(function ToolPinCard(props: {
  pinKey: string;
}) {
  return <PinCard pinKey={props.pinKey} fallback={null} />;
});

/** Pin cards for a list of keys (a collapsed tool run's strip). */
export function ToolPinCards(props: { pinKeys: readonly string[] }) {
  if (props.pinKeys.length === 0) return null;
  return (
    <>
      {props.pinKeys.map(key => (
        <ToolPinCard key={key} pinKey={key} />
      ))}
    </>
  );
}

/**
 * The `hapi_pin` entry of `MARKDOWN_COMPONENTS_BY_LANGUAGE`, built once at
 * module scope there (hoisted, never inline) from the chat's own code header,
 * which this module cannot import (markdown-text imports it). The header is
 * hidden only where a card can render: the gate open, a chat around it and a
 * body that names a pin. Everywhere else, the closed gate included, the fence
 * keeps its language label and Copy button, as it had before Pins.
 */
export function pinComponentsByLanguage(
  DefaultHeader: ComponentType<CodeHeaderProps>
) {
  function PinCodeHeader(props: CodeHeaderProps): ReactElement | null {
    const chat = useOptionalHappyChatContext();
    const pinsEnabled = useVersion().data?.pinsEnabled === true;
    if (chat && pinsEnabled && pinKeyFromFence(props.code)) return null;
    return <DefaultHeader {...props} />;
  }
  return {
    [PIN_FENCE_LANGUAGE_LITERAL]: {
      SyntaxHighlighter: PinFence,
      CodeHeader: PinCodeHeader,
    },
  } as const;
}
