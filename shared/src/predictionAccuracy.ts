// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// Epic #1965 (File Conflict Monitor) Sub G / #1972 — prediction-accuracy dataset
// schemas: the predicted-vs-actual file footprint for each closed issue, with
// computed precision/recall. The rp1-home closer POSTs the actual footprint
// (from `git diff --name-status base...merge`); this persists + serves it as the
// ground-truth self-correction dataset that powers the closer's accuracy report
// and the churn ignore-list auto-suggestion.
//
// Every schema is `.passthrough()` per the shared/CLAUDE.md forked-upstream rule.
// API shapes are camelCase views of the snake_case `prediction_accuracy` columns.

/** A stored prediction-accuracy record (camelCase view of the DB row). */
export const PredictionAccuracyRecordSchema = z
  .object({
    id: z.string(),
    repo: z.string(),
    issue: z.string(),
    predicted: z.array(z.string()),
    actual: z.array(z.string()),
    precision: z.number(), // 0..1
    recall: z.number(), // 0..1
    recordedAt: z.number(), // epoch ms
  })
  .passthrough();
export type PredictionAccuracyRecord = z.infer<
  typeof PredictionAccuracyRecordSchema
>;

/**
 * POST /prediction-accuracy — submit a predicted + actual footprint for a
 * (repo, issue). The server computes precision/recall and upserts, keyed on
 * (repo, issue): a re-submission REPLACES the prior record (idempotent, no
 * duplicate). `issue` is a string (matches the `issue?` provenance field on
 * RecordFootprintRequestSchema; the closer holds a number but string is the
 * established shape). Path arrays are bounded to guard a pathological payload.
 */
export const RecordPredictionAccuracyRequestSchema = z
  .object({
    repo: z.string().min(1),
    issue: z.string().min(1),
    predicted: z.array(z.string().min(1)).max(5000),
    actual: z.array(z.string().min(1)).max(5000),
  })
  .passthrough();
export type RecordPredictionAccuracyRequest = z.infer<
  typeof RecordPredictionAccuracyRequestSchema
>;

/**
 * GET /prediction-accuracy — query the dataset. `repo` is REQUIRED (the dataset
 * is repo-scoped and there is no issue-alone index); an optional `issue` narrows
 * to a single record.
 */
export const PredictionAccuracyQuerySchema = z
  .object({
    repo: z.string().min(1),
    issue: z.string().min(1).optional(),
  })
  .passthrough();
export type PredictionAccuracyQuery = z.infer<
  typeof PredictionAccuracyQuerySchema
>;

export const PredictionAccuracyListResponseSchema = z
  .object({ records: z.array(PredictionAccuracyRecordSchema) })
  .passthrough();
export type PredictionAccuracyListResponse = z.infer<
  typeof PredictionAccuracyListResponseSchema
>;
