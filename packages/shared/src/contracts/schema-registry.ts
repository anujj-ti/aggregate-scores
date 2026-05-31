import {
  createJobRequestSchema,
  createJobResponseSchema,
  fleetViewSchema,
  jobViewSchema,
  setWorkersRequestSchema
} from './api.js';
import { inputKindSchema, jobStatusSchema, taskStatusSchema } from './enums.js';
import { mergeTaskSchema } from './messages.js';

export const schemaRegistry = {
  CreateJobRequest: createJobRequestSchema,
  CreateJobResponse: createJobResponseSchema,
  FleetView: fleetViewSchema,
  InputKind: inputKindSchema,
  JobStatus: jobStatusSchema,
  JobView: jobViewSchema,
  MergeTask: mergeTaskSchema,
  SetWorkersRequest: setWorkersRequestSchema,
  TaskStatus: taskStatusSchema
} as const;
