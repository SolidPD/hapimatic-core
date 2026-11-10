// SPDX-License-Identifier: AGPL-3.0-only
// Compiled-binary entrypoint of the telemetry query worker (issue #6516). The
// build lists this file beside `bootstrap.ts`, so the bundle root stays
// `cli/src` and the server loads it as `./workers/telemetryQueryWorker.ts`
// (server/src/telemetry/workerSpecifier.ts).
import "../../../server/src/telemetry/queryWorker";
