import { z } from 'zod';

export const jobStatusSchema = z.enum([
  'GENERATING',
  'PENDING',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'CANCELLED'
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const taskStatusSchema = z.enum(['QUEUED', 'IN_PROGRESS', 'DONE', 'FAILED']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const inputKindSchema = z.enum(['file', 'partial']);
export type InputKind = z.infer<typeof inputKindSchema>;
