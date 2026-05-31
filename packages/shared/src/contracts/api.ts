import { z } from 'zod';

import { jobStatusSchema } from './enums.js';

export const createJobRequestSchema = z.object({
  F: z.number().int().min(1),
  C: z.number().int().min(1)
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
  submittedAt: z.number().int().nonnegative(),
  percent: z.number().min(0).max(1),
  reductionsRemaining: z.number().int().nonnegative(),
  queuePosition: z.number().int().positive().optional(),
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
