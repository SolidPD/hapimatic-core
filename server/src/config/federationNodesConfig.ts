// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FederationNodeEntrySchema = z.object({
  id: z.string(),
  url: z.string().url(),
  label: z.string(),
  sshHost: z.string().optional(),
  binaryPath: z.string().optional(),
  dataDir: z.string().optional(),
  processPattern: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  autoRegister: z.boolean().default(true),
});

const HealthCheckSchema = z.object({
  evictionThreshold: z.number().int().positive().default(10),
  drainTimeoutMs: z.number().int().positive().default(300_000),
});

const FederationNodesConfigSchema = z.object({
  nodes: z.array(FederationNodeEntrySchema).default([]),
  healthCheck: HealthCheckSchema.default({
    evictionThreshold: 10,
    drainTimeoutMs: 300_000,
  }),
});

export type FederationNodeEntry = z.infer<typeof FederationNodeEntrySchema>;
export type FederationNodesConfig = z.infer<typeof FederationNodesConfigSchema>;

/**
 * Load federation nodes config from `<dataDir>/federation-nodes.json`.
 * Returns empty defaults if file doesn't exist.
 */
export function loadFederationNodesConfig(
  dataDir: string
): FederationNodesConfig {
  const configPath = join(dataDir, "federation-nodes.json");

  if (!existsSync(configPath)) {
    return FederationNodesConfigSchema.parse({});
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return FederationNodesConfigSchema.parse(raw);
  } catch (err) {
    console.warn(
      `[FederationNodes] Failed to load ${configPath}: ${err instanceof Error ? err.message : err}`
    );
    return FederationNodesConfigSchema.parse({});
  }
}
