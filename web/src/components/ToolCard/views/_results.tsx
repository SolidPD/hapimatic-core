// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Slim core shim — the crash-fallback surface for tool results (locked contract
 * §6). Post the `builtin.tool-views` migration (#1277) the per-tool result views
 * live in the `builtin.tool-views` extension (`web/src/extensions/tool-views/`).
 * `GenericResultView` and the helper closure it needs STAY IN CORE so ToolCard's
 * mandatory `?? GenericResultView` guard and the `mcp__` short-circuit render
 * even when the extension is absent from the build. Importing `GenericResultView`
 * from the extension is FORBIDDEN — it would drag the whole result-view module
 * into the core chunk and break the extension's lazy boundary (R5). The helper
 * duplication between this shim and the extension is intentional and blessed by
 * the directive (lazy boundary > DRY). Image extraction/rendering is NOT
 * duplicated: it comes from the core `toolImages` module (already in the core
 * chunk via `ToolMessage`), shared with the hoisted-image path (#4042).
 */
import type { ToolViewComponent, ToolViewProps } from "@/ext/host";
import { CodeBlock } from "@/components/CodeBlock";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import {
  extractImagesFromResult,
  renderHoistedImages,
} from "@/components/AssistantChat/messages/toolImages";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseToolUseError(message: string): {
  isToolUseError: boolean;
  errorMessage: string | null;
} {
  const regex = /<tool_use_error>(.*?)<\/tool_use_error>/s;
  const match = message.match(regex);

  if (match) {
    return {
      isToolUseError: true,
      errorMessage: typeof match[1] === "string" ? match[1].trim() : "",
    };
  }

  return { isToolUseError: false, errorMessage: null };
}

function extractTextFromContentBlock(block: unknown): string | null {
  if (typeof block === "string") return block;
  if (!isObject(block)) return null;
  if (block.type === "text" && typeof block.text === "string")
    return block.text;
  if (typeof block.text === "string") return block.text;
  return null;
}

function extractTextFromResult(
  result: unknown,
  depth: number = 0
): string | null {
  if (depth > 2) return null;
  if (result === null || result === undefined) return null;
  if (typeof result === "string") {
    const toolUseError = parseToolUseError(result);
    return toolUseError.isToolUseError
      ? (toolUseError.errorMessage ?? "")
      : result;
  }

  if (Array.isArray(result)) {
    const parts = result
      .map(extractTextFromContentBlock)
      .filter(
        (part): part is string => typeof part === "string" && part.length > 0
      );
    return parts.length > 0 ? parts.join("\n") : null;
  }

  if (!isObject(result)) return null;

  if (typeof result.content === "string") return result.content;
  if (typeof result.text === "string") return result.text;
  if (typeof result.output === "string") return result.output;
  if (typeof result.error === "string") return result.error;
  if (typeof result.message === "string") return result.message;

  const contentArray = Array.isArray(result.content) ? result.content : null;
  if (contentArray) {
    const parts = contentArray
      .map(extractTextFromContentBlock)
      .filter(
        (part): part is string => typeof part === "string" && part.length > 0
      );
    return parts.length > 0 ? parts.join("\n") : null;
  }

  const nestedOutput = isObject(result.output) ? result.output : null;
  if (nestedOutput) {
    if (typeof nestedOutput.content === "string") return nestedOutput.content;
    if (typeof nestedOutput.text === "string") return nestedOutput.text;
  }

  const nestedError = isObject(result.error) ? result.error : null;
  if (nestedError) {
    if (typeof nestedError.message === "string") return nestedError.message;
    if (typeof nestedError.error === "string") return nestedError.error;
  }

  const nestedResult = isObject(result.result) ? result.result : null;
  if (nestedResult) {
    const nestedText = extractTextFromResult(nestedResult, depth + 1);
    if (nestedText) return nestedText;
  }

  const nestedData = isObject(result.data) ? result.data : null;
  if (nestedData) {
    const nestedText = extractTextFromResult(nestedData, depth + 1);
    if (nestedText) return nestedText;
  }

  return null;
}

function looksLikeHtml(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<div") ||
    trimmed.startsWith("<span")
  );
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function renderText(
  text: string,
  opts: { mode: "markdown" | "code" | "auto"; language?: string } = {
    mode: "auto",
  }
) {
  if (opts.mode === "code") {
    return <CodeBlock code={text} language={opts.language ?? "text"} />;
  }

  if (opts.mode === "markdown") {
    return <MarkdownRenderer content={text} />;
  }

  if (looksLikeHtml(text) || looksLikeJson(text)) {
    return (
      <CodeBlock code={text} language={looksLikeJson(text) ? "json" : "html"} />
    );
  }

  return <MarkdownRenderer content={text} />;
}

function placeholderForState(
  state: ToolViewProps["block"]["tool"]["state"]
): string {
  if (state === "pending") return "Waiting for permission…";
  if (state === "running") return "Running…";
  return "(no output)";
}

function RawJsonDevOnly(props: { value: unknown }) {
  if (!import.meta.env.DEV) return null;
  if (props.value === null || props.value === undefined) return null;

  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs font-medium text-[var(--app-hint)]">
        Raw JSON
      </summary>
      <div className="mt-2">
        <CodeBlock code={safeStringify(props.value)} language="json" />
      </div>
    </details>
  );
}

export const GenericResultView: ToolViewComponent = (props: ToolViewProps) => {
  const result = props.block.tool.result;

  if (result === undefined || result === null) {
    return (
      <div className="text-sm text-[var(--app-hint)]">
        {placeholderForState(props.block.tool.state)}
      </div>
    );
  }

  // Extract images from result (for MCP tools like Playwright that return base64 images)
  const images = extractImagesFromResult(result);

  const text = extractTextFromResult(result);
  if (text || images.length > 0) {
    return (
      <>
        {text ? renderText(text, { mode: "auto" }) : null}
        {renderHoistedImages(images)}
        {typeof result === "object" ? <RawJsonDevOnly value={result} /> : null}
      </>
    );
  }

  if (typeof result === "string") {
    return renderText(result, { mode: "auto" });
  }

  return <CodeBlock code={safeStringify(result)} language="json" />;
};
