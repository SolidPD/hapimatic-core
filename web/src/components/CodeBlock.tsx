// SPDX-License-Identifier: AGPL-3.0-only
import { CopyButton } from "@/components/ui/CopyButton";
import { useShikiHighlighter } from "@/lib/shiki";

export function CodeBlock(props: {
  code: string;
  language?: string;
  showCopyButton?: boolean;
}) {
  const showCopyButton = props.showCopyButton ?? true;
  const highlighted = useShikiHighlighter(props.code, props.language);

  return (
    <div className="relative min-w-0 max-w-full">
      {showCopyButton ? (
        <CopyButton text={props.code} className="absolute right-1.5 top-1.5" />
      ) : null}

      <div className="min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden rounded-md bg-[var(--app-code-bg)]">
        <pre className="shiki m-0 w-max min-w-full p-2 pr-8 text-xs font-mono">
          <code className="block">{highlighted ?? props.code}</code>
        </pre>
      </div>
    </div>
  );
}
