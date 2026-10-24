// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The `/admin/vms` deprovision dry-run's `--gateway-host` (#5257 F9, D3).
 *
 * deprovision.sh has no default gateway host: without one a teardown cannot
 * list or remove the gateway mappings, cannot write the backup retention
 * record, and ends INCOMPLETE RETENTION. The inventory record whose `name`
 * equals the subdomain (how `inventory_upsert` keys records) wins when it
 * carries a `gateway_host`; no inventory writer sets that field today, so the
 * server's `HAPI_VM_GATEWAY_HOST` is the fallback. `buildJob` pattern-checks
 * the result like any other `--gateway-host`.
 */
export async function lookupDeprovisionGatewayHost(opts: {
  subdomain: string;
  inventoryPath: string;
  readInventory: (path: string) => Promise<string>;
  defaultGatewayHost?: string;
}): Promise<string | undefined> {
  const fallback = opts.defaultGatewayHost || undefined;
  try {
    const arr = JSON.parse(await opts.readInventory(opts.inventoryPath));
    if (!Array.isArray(arr)) return fallback;
    const rec = arr.find(
      (r: unknown) =>
        r != null &&
        typeof r === "object" &&
        (r as Record<string, unknown>).name === opts.subdomain
    ) as Record<string, unknown> | undefined;
    const gh = rec?.gateway_host;
    return typeof gh === "string" && gh.length > 0 ? gh : fallback;
  } catch {
    // An unreadable inventory must never block a deprovision.
    return fallback;
  }
}
