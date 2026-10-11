// SPDX-License-Identifier: AGPL-3.0-only
import { Component, type ReactNode } from "react";
import * as Sentry from "@sentry/react";
import { errorReporter } from "@/lib/error-reporter";
import { Button } from "@/components/ui/button";

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    Sentry.captureException(error, {
      contexts: {
        react: { componentStack: errorInfo.componentStack ?? undefined },
      },
    });
    errorReporter.report({
      message: error.message,
      stack: error.stack ?? null,
      category: "react-error-boundary",
      severity: "error",
      context: JSON.stringify({
        componentStack: errorInfo.componentStack ?? "Component tree crashed",
      }),
    });
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="h-full flex flex-col items-center justify-center p-6 text-center gap-4">
          <div className="text-lg font-semibold text-[var(--app-text)]">
            Something went wrong
          </div>
          <div className="text-sm text-[var(--app-hint)] max-w-sm">
            An unexpected error occurred. Try reloading the app.
          </div>
          {this.state.error && (
            <pre className="text-xs text-red-400 max-w-sm overflow-auto whitespace-pre-wrap break-words mt-2">
              {this.state.error.message}
            </pre>
          )}
          <Button
            onClick={this.handleReload}
            className="mt-2 rounded-lg bg-[var(--app-accent)] text-black font-medium"
          >
            Reload
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
