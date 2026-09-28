import { z } from "zod";
import { type ReportsSummary, reportsService } from "../../services/reports-service";
import { publicProcedure, t } from "../trpc";

/**
 * Reports sub-router (issue #425).
 *
 * Thin validator → service delegate. All aggregation logic, bucket-size
 * selection, and side-effects (kicking the disk scanner) live on
 * `ReportsService`; this file's job is to enforce the input schema and
 * type the wire shape.
 *
 * Lives behind `publicProcedure` to match the rest of the router
 * surface: Band runs as a single-user local app and authentication is
 * handled at the transport layer (tunnel token, localhost binding)
 * rather than per procedure.
 */

// Re-export so consumers (the dashboard's tRPC client, tests) still
// have one canonical place for the response shape.
export type { BucketSize, ReportsSummary } from "../../services/reports-service";

export const reportsRouter = t.router({
  /**
   * Aggregate usage in the half-open range `[fromMs, toMs)`.
   *
   * `fromMs` and `toMs` are epoch milliseconds. The "day" buckets
   * inside `byBucket` are rendered in the server's local timezone —
   * Band is a single-user local app so the server and client always
   * share a TZ; no per-request override is wired through.
   */
  summary: publicProcedure
    .input(
      z.object({
        fromMs: z.number().int().nonnegative(),
        toMs: z.number().int().positive(),
      }),
    )
    .query(({ input }): ReportsSummary => reportsService.summary(input.fromMs, input.toMs)),
});

export type ReportsRouter = typeof reportsRouter;
