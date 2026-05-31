export const CHUNK_SIZE = 5;
export const ADMISSION_FACTOR_K = 2;
export const DEFAULT_W = 5;
export const MAX_W = 10;

export const DDB_TABLES = {
  JOBS: 'AggregateJobs',
  READY: 'AggregateReady',
  TASKS: 'AggregateTasks'
} as const;

export const FLEET_PK = 'FLEET';

export const QUEUES = {
  WORK: 'aggregate-work-queue',
  DLQ: 'aggregate-work-dlq'
} as const;

export const S3_BUCKET_NAME = 'aggregate-scores-bucket';
