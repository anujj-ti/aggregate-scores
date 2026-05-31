import { z } from 'zod';

import { jobStatusSchema } from './enums.js';

export const taskDetailSchema = z.object({
  taskId: z.string().min(1),
  kind: z.enum(['leaf', 'merge']),
  level: z.number().int().nonnegative(),
  status: z.enum(['QUEUED', 'IN_PROGRESS', 'DONE', 'FAILED']),
  inputKind: z.enum(['file', 'partial']),
  inputKeys: z.array(z.string().min(1)).min(1),
  attempts: z.number().int().nonnegative(),
  partialKey: z.string().min(1).optional(),
  error: z.string().min(1).optional()
});

export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const createJobRequestSchema = z.object({
  F: z.number().int().min(1),
  C: z.number().int().min(1),
  // Test/demo speedup: when true, one random vector is generated and copied to all F input
  // keys (mean of identical vectors equals that vector, so results stay verifiable).
  reuseSampleFile: z.boolean().optional().default(false)
});

export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;

export const createJobResponseSchema = z.object({
  jobId: z.string().min(1)
});

export type CreateJobResponse = z.infer<typeof createJobResponseSchema>;

export const jobViewSchema = z.object({
  jobId: z.string().min(1),
  status: jobStatusSchema,
  F: z.number().int().min(1),
  C: z.number().int().min(1),
  // True when inputs were synthesized by copying one random vector to every key
  // (test/demo speedup); false/absent when each input is an independent random vector.
  reuseSampleFile: z.boolean().optional(),
  submittedAt: z.number().int().nonnegative(),
  percent: z.number().min(0).max(1),
  reductionsRemaining: z.number().int().nonnegative(),
  queuePosition: z.number().int().positive().optional(),
  chunkSizeUsed: z.number().int().positive().optional(),
  leafTasksTotal: z.number().int().nonnegative().optional(),
  leafTasksDone: z.number().int().nonnegative().optional(),
  readyCount: z.number().int().nonnegative().optional(),
  claimedCount: z.number().int().nonnegative().optional(),
  taskSummary: z
    .object({
      queued: z.number().int().nonnegative(),
      inProgress: z.number().int().nonnegative(),
      done: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      byLevel: z.array(
        z.object({
          level: z.number().int().nonnegative(),
          queued: z.number().int().nonnegative(),
          inProgress: z.number().int().nonnegative(),
          done: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          total: z.number().int().nonnegative()
        })
      )
    })
    .optional(),
  taskDetails: z.array(taskDetailSchema).optional(),
  taskDetailsTruncated: z.boolean().optional(),
  taskDetailsLimit: z.number().int().positive().optional(),
  inputManifestPreview: z
    .array(
      z.object({
        fileIndex: z.number().int().nonnegative(),
        inputKey: z.string().min(1),
        plannedLeafTaskId: z.string().min(1),
        plannedLeafLevel: z.number().int().nonnegative()
      })
    )
    .optional(),
  resultUrl: z.string().url().optional(),
  error: z.string().min(1).optional()
});

export type JobView = z.infer<typeof jobViewSchema>;

export const fleetViewSchema = z.object({
  W: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
  free: z.number().int()
});

export type FleetView = z.infer<typeof fleetViewSchema>;

export const setWorkersRequestSchema = z.object({
  count: z.number().int().nonnegative()
});

export type SetWorkersRequest = z.infer<typeof setWorkersRequestSchema>;
