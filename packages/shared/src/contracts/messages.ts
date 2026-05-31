import { z } from 'zod';

import { inputKindSchema } from './enums.js';

export const mergeTaskSchema = z.object({
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  inputKind: inputKindSchema,
  level: z.number().int().min(0),
  inputKeys: z.array(z.string().min(1)).min(1).max(5),
  C: z.number().int().min(1)
});

export type MergeTask = z.infer<typeof mergeTaskSchema>;
