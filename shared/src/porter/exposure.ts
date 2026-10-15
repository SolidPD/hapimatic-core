// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — exposure-gate wire contract (issues #4533 and #5165,
 * epic #4290).
 *
 * The server exposes Porter by default (#5165) and withholds it under the kill
 * switch `HAPI_PORTER_EXPOSED=0`. While withheld, every `/api/porter/*` and `/p/*` request answers 404 with
 * {@link PorterWithheldBody}; while exposed, `GET /api/porter/status` answers
 * 200 {@link PorterStatusResponse}. The server emits these shapes and the web
 * reads them, so the code string lives here once and cannot drift.
 *
 * NODE-FREE (R7): like every non-test module under `shared/src/porter`, this
 * file imports nothing from `node:*`.
 */
import { z } from "zod";

/** The stable error code every withheld Porter request carries. */
export const PORTER_WITHHELD_CODE = "porter_withheld" as const;

/** The human-readable message paired with {@link PORTER_WITHHELD_CODE}. */
export const PORTER_WITHHELD_MESSAGE =
  "Configuration Porter is not available on this instance" as const;

/** The 404 body of a withheld Porter request. */
export interface PorterWithheldBody {
  error: typeof PORTER_WITHHELD_MESSAGE;
  code: typeof PORTER_WITHHELD_CODE;
}

/**
 * `GET /api/porter/status` response. The route is itself behind the exposure
 * gate, so it is reachable only when Porter is exposed — `exposed` is always
 * `true`, and a withheld instance answers the 404 {@link PorterWithheldBody}.
 */
export const PorterStatusResponseSchema = z.object({
  exposed: z.literal(true),
});

export type PorterStatusResponse = z.infer<typeof PorterStatusResponseSchema>;
