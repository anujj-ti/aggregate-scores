import {
  DynamoDBClient
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';

import { DEFAULT_W } from '@aggregate/shared';
import type { JobStatus } from '@aggregate/shared';

import type { ApiConfig } from '../config.js';

const jobsStatusIndexName = 'status-submittedAt';

const jobRecordSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(['GENERATING', 'PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'CANCELLED']),
  submittedAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  F: z.number().int().positive(),
  C: z.number().int().positive(),
  reuseSampleFile: z.boolean().optional(),
  chunkSizeUsed: z.number().int().positive().optional(),
  leafTasksTotal: z.number().int().nonnegative().optional(),
  leafTasksDone: z.number().int().nonnegative().optional(),
  reductionsRemaining: z.number().int().nonnegative().optional(),
  readyCount: z.number().int().nonnegative().optional(),
  claimedCount: z.number().int().nonnegative().optional(),
  resultKey: z.string().min(1).optional(),
  error: z.string().min(1).optional()
});

export type JobRecord = z.infer<typeof jobRecordSchema>;

const fleetRecordSchema = z.object({
  pk: z.string().min(1),
  W: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative()
});

const fleetRecordRawSchema = z.object({
  pk: z.string().min(1),
  W: z.number().int().nonnegative(),
  inFlight: z.number().int()
});

export type FleetRecord = z.infer<typeof fleetRecordSchema>;

const taskRecordSchema = z.object({
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  kind: z.enum(['leaf', 'merge']),
  level: z.number().int().nonnegative(),
  status: z.enum(['QUEUED', 'IN_PROGRESS', 'DONE', 'FAILED']),
  inputKeys: z.array(z.string().min(1)).max(5).min(1),
  inputKind: z.enum(['file', 'partial']),
  attempts: z.number().int().nonnegative(),
  partialKey: z.string().min(1).optional(),
  error: z.string().min(1).optional()
});

const taskRecordRawSchema = z.object({
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  kind: z.enum(['leaf', 'merge']),
  level: z.number().int().nonnegative(),
  status: z.enum(['QUEUED', 'IN_PROGRESS', 'DONE', 'FAILED']),
  inputKeys: z.array(z.string().min(1)).max(5).min(1),
  inputKind: z.enum(['file', 'partial']),
  attempts: z.number().int().nonnegative(),
  partialKey: z.string().optional(),
  error: z.string().min(1).optional()
});

export type TaskRecord = z.infer<typeof taskRecordSchema>;

const taskLevelProjectionSchema = z.object({
  level: z.number().int().nonnegative(),
  status: z.enum(['QUEUED', 'IN_PROGRESS', 'DONE', 'FAILED'])
});

export type TaskLevelCounts = {
  readonly level: number;
  readonly queued: number;
  readonly inProgress: number;
  readonly done: number;
  readonly failed: number;
  readonly total: number;
};

export type TaskLevelSummary = {
  readonly queued: number;
  readonly inProgress: number;
  readonly done: number;
  readonly failed: number;
  readonly total: number;
  readonly byLevel: TaskLevelCounts[];
};

export type RunningJobCounters = {
  readonly chunkSizeUsed: number;
  readonly leafTasksTotal: number;
  readonly reductionsRemaining: number;
};

export interface DynamoPort {
  createJob(input: {
    jobId: string;
    f: number;
    c: number;
    reuseSampleFile: boolean;
    nowMs: number;
  }): Promise<void>;
  getJob(jobId: string): Promise<JobRecord | null>;
  listJobs(status?: JobStatus, limit?: number): Promise<JobRecord[]>;
  countPendingBefore(submittedAt: number): Promise<number>;
  cancelJob(jobId: string, nowMs: number): Promise<boolean>;
  markGenerationComplete(jobId: string, nowMs: number): Promise<boolean>;
  failJob(jobId: string, error: string, nowMs: number): Promise<void>;
  markJobRunning(jobId: string, counters: RunningJobCounters, nowMs: number): Promise<boolean>;
  getOldestPendingJob(): Promise<JobRecord | null>;
  putQueuedTask(input: {
    jobId: string;
    taskId: string;
    kind: 'leaf' | 'merge';
    level: number;
    inputKeys: string[];
    inputKind: 'file' | 'partial';
  }): Promise<void>;
  listTasksForJob(jobId: string, limit?: number): Promise<TaskRecord[]>;
  countTaskLevels(jobId: string): Promise<TaskLevelSummary>;
  hasRunningJobs(): Promise<boolean>;
  getFleet(): Promise<FleetRecord>;
  setFleetInFlight(inFlight: number): Promise<FleetRecord>;
  setFleetW(w: number): Promise<FleetRecord>;
  addFleetInFlight(delta: number): Promise<FleetRecord>;
}

type DynamoDeps = {
  readonly config: ApiConfig;
};

export class DynamoStore implements DynamoPort {
  private readonly config: ApiConfig;

  private readonly docClient: DynamoDBDocumentClient;

  public constructor(deps: DynamoDeps) {
    this.config = deps.config;
    const clientConfig = {
      region: this.config.awsRegion,
      credentials: {
        accessKeyId: this.config.awsAccessKeyId,
        secretAccessKey: this.config.awsSecretAccessKey,
        sessionToken: this.config.awsSessionToken
      },
      ...(this.config.awsEndpointUrl !== undefined ? { endpoint: this.config.awsEndpointUrl } : {})
    };
    const client = new DynamoDBClient(clientConfig);
    this.docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true
      }
    });
  }

  private async sanitizeFleetRecord(rawRecord: z.infer<typeof fleetRecordRawSchema>): Promise<FleetRecord> {
    if (rawRecord.inFlight >= 0) {
      return fleetRecordSchema.parse(rawRecord);
    }
    const corrected = await this.docClient.send(
      new UpdateCommand({
        TableName: this.config.fleetTableName,
        Key: { pk: rawRecord.pk },
        UpdateExpression: 'SET inFlight = :zero',
        ExpressionAttributeValues: { ':zero': 0 },
        ReturnValues: 'ALL_NEW'
      })
    );
    const correctedRaw = fleetRecordRawSchema.parse(corrected.Attributes ?? { ...rawRecord, inFlight: 0 });
    return fleetRecordSchema.parse(correctedRaw);
  }

  private sanitizeTaskRecord(rawRecord: z.infer<typeof taskRecordRawSchema>): TaskRecord {
    if (rawRecord.partialKey === '') {
      const { partialKey: _partialKey, ...withoutEmptyPartialKey } = rawRecord;
      return taskRecordSchema.parse(withoutEmptyPartialKey);
    }
    return taskRecordSchema.parse(rawRecord);
  }

  // A new job starts in GENERATING: its input files do not exist yet. The submit path
  // synthesizes them in the background and only then releases the job to PENDING, so the
  // dispatcher and worker fleet never block on file generation.
  public async createJob(input: {
    jobId: string;
    f: number;
    c: number;
    reuseSampleFile: boolean;
    nowMs: number;
  }): Promise<void> {
    await this.docClient.send(
      new PutCommand({
        TableName: this.config.jobsTableName,
        Item: {
          jobId: input.jobId,
          status: 'GENERATING',
          submittedAt: input.nowMs,
          createdAt: input.nowMs,
          updatedAt: input.nowMs,
          F: input.f,
          C: input.c,
          reuseSampleFile: input.reuseSampleFile,
          readyCount: 0,
          claimedCount: 0,
          leafTasksDone: 0
        }
      })
    );
  }

  public async markGenerationComplete(jobId: string, nowMs: number): Promise<boolean> {
    try {
      await this.docClient.send(
        new UpdateCommand({
          TableName: this.config.jobsTableName,
          Key: { jobId },
          UpdateExpression: 'SET #status = :pending, updatedAt = :now',
          ConditionExpression: '#status = :generating',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'PENDING',
            ':generating': 'GENERATING',
            ':now': nowMs
          }
        })
      );
      return true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: string }).name === 'ConditionalCheckFailedException'
      ) {
        return false;
      }
      throw error;
    }
  }

  public async failJob(jobId: string, error: string, nowMs: number): Promise<void> {
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.config.jobsTableName,
        Key: { jobId },
        UpdateExpression: 'SET #status = :failed, #error = :error, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: {
          ':failed': 'FAILED',
          ':error': error.slice(0, 1000),
          ':now': nowMs
        }
      })
    );
  }

  public async getJob(jobId: string): Promise<JobRecord | null> {
    const output = await this.docClient.send(
      new GetCommand({
        TableName: this.config.jobsTableName,
        Key: { jobId }
      })
    );
    if (output.Item === undefined) {
      return null;
    }
    return jobRecordSchema.parse(output.Item);
  }

  public async listJobs(status?: JobStatus, limit: number = 50): Promise<JobRecord[]> {
    if (status !== undefined) {
      const output = await this.docClient.send(
        new QueryCommand({
          TableName: this.config.jobsTableName,
          IndexName: jobsStatusIndexName,
          KeyConditionExpression: '#status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
          ScanIndexForward: false,
          Limit: limit
        })
      );
      return z.array(jobRecordSchema).parse(output.Items ?? []);
    }

    const output = await this.docClient.send(
      new ScanCommand({
        TableName: this.config.jobsTableName,
        Limit: limit
      })
    );
    return z
      .array(jobRecordSchema)
      .parse(output.Items ?? [])
      .sort((left, right) => right.submittedAt - left.submittedAt);
  }

  public async countPendingBefore(submittedAt: number): Promise<number> {
    const output = await this.docClient.send(
      new QueryCommand({
        TableName: this.config.jobsTableName,
        IndexName: jobsStatusIndexName,
        KeyConditionExpression: '#status = :status AND submittedAt < :submittedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'PENDING',
          ':submittedAt': submittedAt
        },
        Select: 'COUNT'
      })
    );
    return output.Count ?? 0;
  }

  public async cancelJob(jobId: string, nowMs: number): Promise<boolean> {
    try {
      await this.docClient.send(
        new UpdateCommand({
          TableName: this.config.jobsTableName,
          Key: { jobId },
          UpdateExpression: 'SET #status = :cancelled, updatedAt = :now',
          ConditionExpression: '#status IN (:generating, :pending, :running)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':cancelled': 'CANCELLED',
            ':generating': 'GENERATING',
            ':pending': 'PENDING',
            ':running': 'RUNNING',
            ':now': nowMs
          }
        })
      );
      return true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: string }).name === 'ConditionalCheckFailedException'
      ) {
        return false;
      }
      throw error;
    }
  }

  public async markJobRunning(jobId: string, counters: RunningJobCounters, nowMs: number): Promise<boolean> {
    try {
      await this.docClient.send(
        new UpdateCommand({
          TableName: this.config.jobsTableName,
          Key: { jobId },
          UpdateExpression:
            'SET #status = :running, chunkSizeUsed = :chunk, leafTasksTotal = :leafTotal, reductionsRemaining = :reductions, readyCount = :zero, claimedCount = :zero, leafTasksDone = :zero, updatedAt = :now',
          ConditionExpression: '#status = :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':running': 'RUNNING',
            ':pending': 'PENDING',
            ':chunk': counters.chunkSizeUsed,
            ':leafTotal': counters.leafTasksTotal,
            ':reductions': counters.reductionsRemaining,
            ':zero': 0,
            ':now': nowMs
          }
        })
      );
      return true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: string }).name === 'ConditionalCheckFailedException'
      ) {
        return false;
      }
      throw error;
    }
  }

  public async getOldestPendingJob(): Promise<JobRecord | null> {
    const output = await this.docClient.send(
      new QueryCommand({
        TableName: this.config.jobsTableName,
        IndexName: jobsStatusIndexName,
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'PENDING' },
        ScanIndexForward: true,
        Limit: 1
      })
    );
    const items = z.array(jobRecordSchema).parse(output.Items ?? []);
    return items.length > 0 ? (items[0] ?? null) : null;
  }

  public async putQueuedTask(input: {
    jobId: string;
    taskId: string;
    kind: 'leaf' | 'merge';
    level: number;
    inputKeys: string[];
    inputKind: 'file' | 'partial';
  }): Promise<void> {
    const record = taskRecordSchema.parse({
      jobId: input.jobId,
      taskId: input.taskId,
      kind: input.kind,
      level: input.level,
      status: 'QUEUED',
      inputKeys: input.inputKeys,
      inputKind: input.inputKind,
      attempts: 0
    });

    await this.docClient.send(
      new PutCommand({
        TableName: this.config.tasksTableName,
        Item: record
      })
    );
  }

  public async listTasksForJob(jobId: string, limit: number = 300): Promise<TaskRecord[]> {
    const output = await this.docClient.send(
      new QueryCommand({
        TableName: this.config.tasksTableName,
        KeyConditionExpression: 'jobId = :jobId',
        ScanIndexForward: true,
        Limit: limit,
        ExpressionAttributeValues: {
          ':jobId': jobId
        }
      })
    );
    const rawRecords = z.array(taskRecordRawSchema).parse(output.Items ?? []);
    return rawRecords.map((rawRecord) => this.sanitizeTaskRecord(rawRecord));
  }

  // Aggregates per-level/per-status task counts across ALL tasks for a job by
  // paginating the query (no row cap), so the level breakdown reflects the full
  // merge history rather than a truncated subset.
  public async countTaskLevels(jobId: string): Promise<TaskLevelSummary> {
    const levelMap = new Map<
      number,
      { queued: number; inProgress: number; done: number; failed: number }
    >();
    let queued = 0;
    let inProgress = 0;
    let done = 0;
    let failed = 0;
    let total = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const output = await this.docClient.send(
        new QueryCommand({
          TableName: this.config.tasksTableName,
          KeyConditionExpression: 'jobId = :jobId',
          ProjectionExpression: '#level, #status',
          ExpressionAttributeNames: { '#level': 'level', '#status': 'status' },
          ExpressionAttributeValues: { ':jobId': jobId },
          ...(exclusiveStartKey !== undefined ? { ExclusiveStartKey: exclusiveStartKey } : {})
        })
      );
      for (const item of output.Items ?? []) {
        const parsed = taskLevelProjectionSchema.parse(item);
        total += 1;
        const bucket = levelMap.get(parsed.level) ?? {
          queued: 0,
          inProgress: 0,
          done: 0,
          failed: 0
        };
        if (parsed.status === 'QUEUED') {
          queued += 1;
          bucket.queued += 1;
        } else if (parsed.status === 'IN_PROGRESS') {
          inProgress += 1;
          bucket.inProgress += 1;
        } else if (parsed.status === 'DONE') {
          done += 1;
          bucket.done += 1;
        } else {
          failed += 1;
          bucket.failed += 1;
        }
        levelMap.set(parsed.level, bucket);
      }
      exclusiveStartKey = output.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey !== undefined);

    const byLevel = Array.from(levelMap.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([level, counts]) => ({
        level,
        queued: counts.queued,
        inProgress: counts.inProgress,
        done: counts.done,
        failed: counts.failed,
        total: counts.queued + counts.inProgress + counts.done + counts.failed
      }));

    return { queued, inProgress, done, failed, total, byLevel };
  }

  public async hasRunningJobs(): Promise<boolean> {
    const output = await this.docClient.send(
      new QueryCommand({
        TableName: this.config.jobsTableName,
        IndexName: jobsStatusIndexName,
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'RUNNING' },
        Select: 'COUNT',
        Limit: 1
      })
    );
    return (output.Count ?? 0) > 0;
  }

  public async getFleet(): Promise<FleetRecord> {
    const output = await this.docClient.send(
      new GetCommand({
        TableName: this.config.fleetTableName,
        Key: { pk: this.config.fleetPk }
      })
    );
    if (output.Item === undefined) {
      const seeded: FleetRecord = {
        pk: this.config.fleetPk,
        W: DEFAULT_W,
        inFlight: 0
      };
      await this.docClient.send(
        new PutCommand({
          TableName: this.config.fleetTableName,
          Item: seeded
        })
      );
      return seeded;
    }
    const rawRecord = fleetRecordRawSchema.parse(output.Item);
    return this.sanitizeFleetRecord(rawRecord);
  }

  public async setFleetInFlight(inFlight: number): Promise<FleetRecord> {
    const output = await this.docClient.send(
      new UpdateCommand({
        TableName: this.config.fleetTableName,
        Key: { pk: this.config.fleetPk },
        UpdateExpression: 'SET inFlight = :inFlight',
        ExpressionAttributeValues: { ':inFlight': inFlight },
        ReturnValues: 'ALL_NEW'
      })
    );
    const rawRecord = fleetRecordRawSchema.parse(output.Attributes ?? {});
    return this.sanitizeFleetRecord(rawRecord);
  }

  public async setFleetW(w: number): Promise<FleetRecord> {
    const output = await this.docClient.send(
      new UpdateCommand({
        TableName: this.config.fleetTableName,
        Key: { pk: this.config.fleetPk },
        UpdateExpression: 'SET W = :w',
        ExpressionAttributeValues: { ':w': w },
        ReturnValues: 'ALL_NEW'
      })
    );
    const rawRecord = fleetRecordRawSchema.parse(output.Attributes ?? {});
    return this.sanitizeFleetRecord(rawRecord);
  }

  public async addFleetInFlight(delta: number): Promise<FleetRecord> {
    const output = await this.docClient.send(
      new UpdateCommand({
        TableName: this.config.fleetTableName,
        Key: { pk: this.config.fleetPk },
        UpdateExpression: 'ADD inFlight :delta',
        ExpressionAttributeValues: { ':delta': delta },
        ReturnValues: 'ALL_NEW'
      })
    );
    const rawRecord = fleetRecordRawSchema.parse(output.Attributes ?? {});
    return this.sanitizeFleetRecord(rawRecord);
  }
}

