// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatBlock } from "@/chat/types";
import { ImageWithFullscreen } from "@/components/ImageWithFullscreen";

/**
 * Image hoisting for MCP tool results (e.g. Playwright / computer-use screenshots).
 *
 * Lives in its OWN pure module — NOT inside the heavily-mocked `ToolMessage` — so
 * `ToolRunGroup` and `AssistantMessage` can reuse the helpers without every
 * `vi.mock("…/ToolMessage")` in the suite having to re-export them (issue #3269,
 * finding 3269-2). `ToolRunGroup.test.tsx` wholesale-mocks the ToolMessage module
 * with exactly three symbols (`isToolCallBlock`, `mustAlwaysRender`,
 * `hasPermissionFloor`) and NO `importOriginal` passthrough — consuming any new
 * symbol from ToolMessage there resolves to `undefined` and crashes every test in
 * that file. The `CompactChevron` split (`CompactChevron.tsx:3-11`) is the
 * repo-sanctioned pattern for exactly this reason. This module imports only
 * `ImageWithFullscreen`, so it stays unmocked (pure) in both suites.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export type ExtractedImage = {
  mediaType: string;
  base64Data: string;
};

function extractImageFromContentBlock(block: unknown): ExtractedImage | null {
  if (!isObject(block)) return null;
  if (block.type !== "image") return null;

  // Support MCP SDK format: { type: 'image', data: string, mimeType: string }
  if (typeof block.data === "string" && typeof block.mimeType === "string") {
    return {
      mediaType: block.mimeType,
      base64Data: block.data,
    };
  }

  // Support Anthropic format: { type: 'image', source: { type: 'base64', media_type, data } }
  const source = isObject(block.source) ? block.source : null;
  if (!source) return null;

  if (
    source.type === "base64" &&
    typeof source.media_type === "string" &&
    typeof source.data === "string"
  ) {
    return {
      mediaType: source.media_type,
      base64Data: source.data,
    };
  }
  return null;
}

/** Images carried directly by ONE tool's result (its own `tool.result`). */
export function extractImagesFromResult(result: unknown): ExtractedImage[] {
  // Handle direct array of content blocks
  if (Array.isArray(result)) {
    return result
      .map(extractImageFromContentBlock)
      .filter((img): img is ExtractedImage => img !== null);
  }

  // Handle wrapped result: { content: [...] } (MCP tool format)
  if (isObject(result) && Array.isArray(result.content)) {
    return result.content
      .map(extractImageFromContentBlock)
      .filter((img): img is ExtractedImage => img !== null);
  }

  return [];
}

/**
 * Recursive collector (#3269, finding 3269-4): a block's OWN result images PLUS,
 * recursively, every descendant's — mirroring the `mustAlwaysRender` /
 * `hasPermissionFloor` `block.children.some(...)` recursion in `ToolMessage.tsx`.
 *
 * Used ONLY where a subtree is UNMOUNTED and so cannot render its own images: a
 * `hidden` nested tool's early-return, a collapsed `ToolRunGroup` (members
 * unmounted), and an output-only-collapsed message part. In those cases a
 * screenshot from a Task's sub-tool would otherwise stay buried. The always-visible
 * per-tool sibling uses `extractImagesFromResult` (own-only) instead — a mounted
 * child renders its own image, so a deep collect there would double-render it (V4).
 */
export function collectImagesDeep(block: ChatBlock): ExtractedImage[] {
  if (block.kind !== "tool-call") return [];
  // Null-safe against a malformed block: the real `isToolCallBlock` guarantees `tool`
  // and `children` on a genuine tool-call, but this helper is exported and consumed by
  // three components whose test suites mock `isToolCallBlock` loosely — so a `?.`/`??`
  // keeps it from throwing on a bare `{ kind: "tool-call" }` fixture (extractImages
  // handles `undefined`, and an absent children set is treated as no descendants).
  const own = extractImagesFromResult(block.tool?.result);
  const nested = (block.children ?? []).flatMap(collectImagesDeep);
  return own.length ? [...own, ...nested] : nested;
}

/** Render a set of hoisted images as a vertical stack; `[]` renders nothing. */
export function renderHoistedImages(images: ExtractedImage[]) {
  if (images.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {images.map((img, idx) => (
        <ImageWithFullscreen
          key={idx}
          src={`data:${img.mediaType};base64,${img.base64Data}`}
          alt={`Image ${idx + 1}`}
          className="max-w-full rounded border border-[var(--app-border)]"
        />
      ))}
    </div>
  );
}
