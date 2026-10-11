// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Scan-aware install helper (#3131) shared by the marketplace + harness install flows.
 *
 * `POST /api/ext/install` relays the CLI's `--json` envelope verbatim. On a scan PASS the
 * envelope carries `scanVerdict`; on a scan BLOCK the CLI exits non-zero, so the server
 * returns a non-2xx whose BODY still carries `{ code: "scan_blocked", findings }`. The
 * client's `request` throws an {@link ApiError} on non-2xx — but its `.body` holds that
 * JSON, so we normalize a scan block into a RESULT (not a bare error) and the UI can
 * render the verdict + override control instead of losing the findings.
 */
import type { ScanFinding } from "@hapi/protocol";

import { ApiError } from "@/api/client";
import type { ScanVerdictData } from "@/components/settings/ScanVerdict";

export interface InstallResponse {
  ok: boolean;
  id?: string;
  version?: string;
  warnings?: string[];
  error?: string;
  code?: string;
  /** Present on a PASS envelope (may carry advisory findings + an override note). */
  scanVerdict?: ScanVerdictData | null;
  /** Present on a `scan_blocked` envelope. */
  verdict?: "pass" | "block";
  findings?: ScanFinding[];
}

export interface InstallVars {
  id: string;
  override?: boolean;
  overrideReason?: string;
}

/** Minimal surface of the app-context API client this helper needs. */
interface ExtensionApi {
  extensionRequest<T>(path: string, init?: RequestInit): Promise<T>;
}

/**
 * Install via the marketplace subprocess route, normalizing a scan-block non-2xx into an
 * {@link InstallResponse} (parsing the findings from the `ApiError` body). Genuine
 * transport failures (network, timeout, non-envelope errors) still reject.
 */
export async function runScanAwareInstall(
  api: ExtensionApi,
  vars: InstallVars
): Promise<InstallResponse> {
  try {
    return await api.extensionRequest<InstallResponse>("/api/ext/install", {
      method: "POST",
      body: JSON.stringify(vars),
    });
  } catch (err) {
    const body = err instanceof ApiError ? err.body : undefined;
    if (body) {
      try {
        const parsed = JSON.parse(body) as InstallResponse;
        if (parsed && typeof parsed === "object" && "ok" in parsed) {
          return parsed;
        }
      } catch {
        // Not a JSON envelope — fall through to the generic error.
      }
    }
    throw err;
  }
}

/** Derive the data a `ScanVerdict` renders from an install response (pass or block). */
export function verdictFromResponse(
  r: InstallResponse
): ScanVerdictData | null {
  if (r.scanVerdict) return r.scanVerdict;
  if (r.code === "scan_blocked" || r.verdict === "block") {
    return { verdict: "block", findings: r.findings ?? [], override: null };
  }
  return null;
}
