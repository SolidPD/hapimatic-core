// SPDX-License-Identifier: AGPL-3.0-only
// Sub F's per-VM parity status file → the `vmParity` summary (#3557), split out
// of adminVms.ts so the route file stays under the max-lines cap. Consumers:
// GET /admin-vms/inventory (one summary per fleet VM) and GET
// /admin-vms/parity-hub (RP1's own record, #3996). Tests reach it through the
// routes.
import { join } from "node:path";
import { z } from "zod";
import {
  VM_PARITY_SOURCES,
  VM_PARITY_STALE_AFTER_MS,
  VmParityVerdictSchema,
  type VmParitySummary,
} from "@hapi/protocol/adminVms";

// ── #3557: Sub F's per-VM parity status file → the row's `vmParity` ──────────
/** Sub F's subdomain grammar (provision.sh's own shape) — also the file name. */
const VM_PARITY_SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * INPUT schema for ONE `<subdomain>.json` — Sub F's twelve schema-v1 fields
 * (`docs/internal/architecture/vm-parity.md` § "Status file"). Deliberately NOT
 * `.strict()`: F's contract lets a field be ADDED without bumping
 * `schema_version`, so unknown keys are stripped, never fatal. A rename, retype
 * or removal bumps the version, which `z.literal(1)` rejects.
 */
const VmParityStatusRecordSchema = z.object({
  schema_version: z.literal(1),
  subdomain: z.string().regex(VM_PARITY_SUBDOMAIN),
  target: z.string(),
  compliant: z.boolean(),
  verdict: VmParityVerdictSchema,
  drift: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  manifest_version: z.string().min(1),
  checked_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
  checked_by: z.string(),
  checker_exit: z.number().int().min(-1).max(255),
  source: z.enum(VM_PARITY_SOURCES),
});

const VM_PARITY_UNREADABLE: VmParitySummary = { state: "unreadable" };

/**
 * Project one status-file body onto the row summary. Pure. Anything that is not
 * a self-consistent schema-v1 record for THIS subdomain is `unreadable` — shown
 * as such, never passed off as "never checked" or as compliant. Only the
 * rendered fields survive the projection.
 */
function toVmParitySummary(
  text: string,
  subdomain: string,
  nowMs: number
): VmParitySummary {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return VM_PARITY_UNREADABLE;
  }
  const parsed = VmParityStatusRecordSchema.safeParse(json);
  if (!parsed.success) return VM_PARITY_UNREADABLE;
  const rec = parsed.data;
  const checkedMs = Date.parse(rec.checked_at);
  if (
    rec.subdomain !== subdomain ||
    rec.compliant !== (rec.verdict === "pass") ||
    !Number.isFinite(checkedMs)
  ) {
    return VM_PARITY_UNREADABLE;
  }
  return {
    state: "recorded",
    verdict: rec.verdict,
    compliant: rec.compliant,
    drift: rec.drift,
    manifestVersion: rec.manifest_version,
    checkedAt: rec.checked_at,
    stale: nowMs - checkedMs > VM_PARITY_STALE_AFTER_MS,
  };
}

/**
 * Read + project one VM's status file. `undefined` = no file (ENOENT: never
 * checked) or a name outside the subdomain grammar (no path is built from it).
 * Never throws: any other read failure is `unreadable`, so one bad file can
 * never 500 the whole inventory.
 */
export async function readVmParitySummary(deps: {
  stateDir: string;
  subdomain: string;
  readVmParityStatus: (path: string) => Promise<string>;
  nowMs: number;
}): Promise<VmParitySummary | undefined> {
  if (!VM_PARITY_SUBDOMAIN.test(deps.subdomain)) return undefined;
  let text: string;
  try {
    text = await deps.readVmParityStatus(
      join(deps.stateDir, `${deps.subdomain}.json`)
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return VM_PARITY_UNREADABLE;
  }
  return toVmParitySummary(text, deps.subdomain, deps.nowMs);
}
