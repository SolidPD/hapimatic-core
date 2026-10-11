// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkGemoji from "remark-gemoji";
import { cn } from "@/lib/utils";
import {
  InlineMarkdownAnchor,
  InlineMarkdownCode,
} from "@/components/assistant-ui/sharedMarkdownComponents";
import { preserveBlankLines } from "@/chat/preserveBlankLines";

/**
 * Standalone markdown renderer that works outside the assistant-ui thread
 * context. Used for session notes and other standalone markdown content.
 *
 * Uses react-markdown directly with the same styled components as the
 * chat thread, minus the assistant-ui hooks (useIsMarkdownCodeBlock, etc.).
 */

function Code(props: ComponentPropsWithoutRef<"code">) {
  const { className, ...rest } = props;
  const isBlock = /language-/.test(className ?? "");

  if (isBlock) {
    return (
      <code
        {...rest}
        className={cn("aui-md-codeblockcode font-mono text-[1em]", className)}
      />
    );
  }

  // Inline code shares the house styling via the leaf module (#3719); the
  // `/language-/` regex block branch stays local.
  return <InlineMarkdownCode {...props} />;
}

function Pre(props: ComponentPropsWithoutRef<"pre">) {
  const { className, ...rest } = props;
  return (
    <div className="aui-md-pre-wrapper min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden">
      <pre
        {...rest}
        className={cn(
          "aui-md-pre m-0 w-max min-w-full rounded-md bg-[var(--app-code-bg)] p-2 text-[0.75em]",
          className
        )}
      />
    </div>
  );
}

const components = {
  code: Code,
  pre: Pre,
  h1: (p: ComponentPropsWithoutRef<"h1">) => (
    <h1
      {...p}
      className={cn("aui-md-h1 mt-3 text-base font-semibold", p.className)}
    />
  ),
  h2: (p: ComponentPropsWithoutRef<"h2">) => (
    <h2
      {...p}
      className={cn("aui-md-h2 mt-3 text-sm font-semibold", p.className)}
    />
  ),
  h3: (p: ComponentPropsWithoutRef<"h3">) => (
    <h3
      {...p}
      className={cn("aui-md-h3 mt-2 text-sm font-semibold", p.className)}
    />
  ),
  // Inline anchor styling is shared via the leaf module (#3719).
  a: InlineMarkdownAnchor,
  p: (p: ComponentPropsWithoutRef<"p">) => (
    <p {...p} className={cn("aui-md-p leading-relaxed", p.className)} />
  ),
  strong: (p: ComponentPropsWithoutRef<"strong">) => (
    <strong {...p} className={cn("aui-md-strong font-semibold", p.className)} />
  ),
  em: (p: ComponentPropsWithoutRef<"em">) => (
    <em {...p} className={cn("aui-md-em italic", p.className)} />
  ),
  blockquote: (p: ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      {...p}
      className={cn(
        "aui-md-blockquote border-l-4 border-[var(--app-hint)] pl-3 opacity-85",
        p.className
      )}
    />
  ),
  ul: (p: ComponentPropsWithoutRef<"ul">) => (
    <ul {...p} className={cn("aui-md-ul list-disc pl-6", p.className)} />
  ),
  ol: (p: ComponentPropsWithoutRef<"ol">) => (
    <ol {...p} className={cn("aui-md-ol list-decimal pl-6", p.className)} />
  ),
  li: (p: ComponentPropsWithoutRef<"li">) => (
    <li {...p} className={cn("aui-md-li", p.className)} />
  ),
  hr: (p: ComponentPropsWithoutRef<"hr">) => (
    <hr
      {...p}
      className={cn("aui-md-hr border-[var(--app-divider)]", p.className)}
    />
  ),
  img: (p: ComponentPropsWithoutRef<"img">) => (
    <img
      {...p}
      className={cn("max-w-full h-auto rounded-md my-2", p.className)}
      loading="lazy"
    />
  ),
  table: (p: ComponentPropsWithoutRef<"table">) => (
    <div className="my-2 w-full overflow-x-auto">
      <table
        {...p}
        className={cn("w-full border-collapse text-xs", p.className)}
      />
    </div>
  ),
  th: (p: ComponentPropsWithoutRef<"th">) => (
    <th
      {...p}
      className={cn(
        "border border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-2.5 py-1.5 text-left font-semibold",
        p.className
      )}
    />
  ),
  td: (p: ComponentPropsWithoutRef<"td">) => (
    <td
      {...p}
      className={cn(
        "border border-[var(--app-divider)] px-2.5 py-1.5",
        p.className
      )}
    />
  ),
};

interface SimpleMarkdownProps {
  content: string;
  className?: string;
}

export function SimpleMarkdown(props: SimpleMarkdownProps) {
  return (
    <div
      className={cn(
        "aui-md min-w-0 max-w-full break-words text-sm [&>p+p]:mt-3",
        props.className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkGemoji]}
        components={components}
      >
        {preserveBlankLines(props.content)}
      </ReactMarkdown>
    </div>
  );
}
