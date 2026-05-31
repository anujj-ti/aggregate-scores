import { z } from 'zod';

import {
  ADMISSION_FACTOR_K,
  CHUNK_SIZE,
  DDB_TABLES,
  FLEET_PK,
  MAX_W,
  QUEUES,
  S3_BUCKET_NAME
} from '@aggregate/shared';

const envSchema = z.object({
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  AWS_SESSION_TOKEN: z.string().default('test'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_DISPATCHER_TICK_MS: z.coerce.number().int().positive().default(5000),
  S3_BUCKET_NAME: z.string().default(S3_BUCKET_NAME),
  QUEUE_WORK: z.string().default(QUEUES.WORK),
  DDB_TABLE_JOBS: z.string().default(DDB_TABLES.JOBS),
  DDB_TABLE_TASKS: z.string().default(DDB_TABLES.TASKS),
  DDB_TABLE_FLEET: z.string().default('AggregateFleet'),
  FLEET_PK: z.string().default(FLEET_PK)
});

export type ApiConfig = {
  readonly awsRegion: string;
  readonly awsEndpointUrl?: string;
  readonly awsAccessKeyId: string;
  readonly awsSecretAccessKey: string;
  readonly awsSessionToken: string;
  readonly apiPort: number;
  readonly dispatcherTickMs: number;
  readonly s3BucketName: string;
  readonly queueWorkName: string;
  readonly jobsTableName: string;
  readonly tasksTableName: string;
  readonly fleetTableName: string;
  readonly fleetPk: string;
  readonly chunkSize: number;
  readonly maxWorkers: number;
  readonly admissionFactorK: number;
};

export const loadConfig = (): ApiConfig => {
  const parsed = envSchema.parse(process.env);
  const isLocalstack =
    parsed.AWS_ENDPOINT_URL !== undefined &&
    (parsed.AWS_ENDPOINT_URL.includes('localhost:4566') ||
      parsed.AWS_ENDPOINT_URL.includes('localstack'));
  const awsAccessKeyId = isLocalstack ? 'test' : parsed.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = isLocalstack ? 'test' : parsed.AWS_SECRET_ACCESS_KEY;
  const awsSessionToken = isLocalstack ? 'test' : parsed.AWS_SESSION_TOKEN;

  return {
    awsRegion: parsed.AWS_REGION,
    awsAccessKeyId,
    awsSecretAccessKey,
    awsSessionToken,
    apiPort: parsed.API_PORT,
    dispatcherTickMs: parsed.API_DISPATCHER_TICK_MS,
    s3BucketName: parsed.S3_BUCKET_NAME,
    queueWorkName: parsed.QUEUE_WORK,
    jobsTableName: parsed.DDB_TABLE_JOBS,
    tasksTableName: parsed.DDB_TABLE_TASKS,
    fleetTableName: parsed.DDB_TABLE_FLEET,
    fleetPk: parsed.FLEET_PK,
    chunkSize: CHUNK_SIZE,
    maxWorkers: MAX_W,
    admissionFactorK: ADMISSION_FACTOR_K,
    ...(parsed.AWS_ENDPOINT_URL !== undefined ? { awsEndpointUrl: parsed.AWS_ENDPOINT_URL } : {})
  };
};

