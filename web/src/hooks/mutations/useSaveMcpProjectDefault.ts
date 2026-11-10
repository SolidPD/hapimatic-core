// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { McpSet } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";

/**
 * Issue #6171: store (or, with `null`, clear) a project's default MCP set on the
 * target node, then refetch every catalog: the default is keyed by the project's
 * root, so any directory in that project shows the change.
 */
export function useSaveMcpProjectDefault(api: ApiClient | null): {
  save: (args: {
    directory: string;
    nodeId: string | null;
    set: McpSet | null;
  }) => Promise<void>;
  isPending: boolean;
  error: string | null;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (args: {
      directory: string;
      nodeId: string | null;
      set: McpSet | null;
    }) => {
      if (!api) throw new Error("API unavailable");
      await api.setMcpProjectDefault(args.directory, args.set, args.nodeId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
    },
  });
  return {
    save: async args => {
      await mutation.mutateAsync(args);
    },
    isPending: mutation.isPending,
    error: mutation.error
      ? mutation.error instanceof Error
        ? mutation.error.message
        : "Could not save the default"
      : null,
  };
}
