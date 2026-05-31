import {
  DynamoDBClient
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
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
  status: z.enum(['PENDING', 'RUNNING', 'COMPLETE', 'FAILED']),
  submittedAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  F: z.number().int().positive(),
  C: z.number().int().positive(),
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

export type FleetRecord = z.infer<typeof fleetRecordSchema>;

const taskRecordSchema = z.object({
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  kind: z.enum(['leaf', 'merge']),
  level: z.number().int().nonnegative(),
  status: z.enum(['QUEUED', 'IN_PROGRESS', 'DONE', 'FAILED']),
  inputKeys: z.array(z.string().min(1)).max(5).min(1),
  inputKind: z.enum(['file', 'partial']),
  attempts: z.number().int().nonnegative()
});

export type TaskRecord = z.infer<typeof taskRecordSchema>;

export type RunningJobCounters = {
  readonly chunkSizeUsed: number;
  readonly leafTasksTotal: number;
  readonly reductionsRemaining: number;
};

export interface DynamoPort {
  createPendingJob(input: { jobId: string; f: number; c: number; nowMs: number }): Promise<void>;
  getJob(jobId: string): Promise<JobRecord | null>;
  listJobs(status?: JobStatus, limit?: number): Promise<JobRecord[]>;
  countPendingBefore(submittedAt: number): Promise<number>;
  deleteJob(jobId: string): Promise<void>;
  markJobRunning(jobId: string, counters: RunningJobCounters, nowMs: number): Promise<void>;
  getOldestPendingJob(): Promise<JobRecord | null>;
  putQueuedTask(input: {
    jobId: string;
    taskId: string;
    kind: 'leaf' | 'merge';
    level: number;
    inputKeys: string[];
    inputKind: 'file' | 'partial';
  }): Promise<void>;
  getFleet(): Promise<FleetRecord>;
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

  public async createPendingJob(input: { jobId: string; f: number; c: number; nowMs: number }): Promise<void> {
    await this.docClient.send(
      new PutCommand({
        TableName: this.config.jobsTableName,
        Item: {
          jobId: input.jobId,
          status: 'PENDING',
          submittedAt: input.nowMs,
          createdAt: input.nowMs,
          updatedAt: input.nowMs,
          F: input.f,
          C: input.c,
          readyCount: 0,
          claimedCount: 0,
          leafTasksDone: 0
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

  public async deleteJob(jobId: string): Promise<void> {
    await this.docClient.send(
      new DeleteCommand({
        TableName: this.config.jobsTableName,
        Key: { jobId }
      })
    );
  }

  public async markJobRunning(jobId: string, counters: RunningJobCounters, nowMs: number): Promise<void> {
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.config.jobsTableName,
        Key: { jobId },
        UpdateExpression:
          'SET #status = :running, chunkSizeUsed = :chunk, leafTasksTotal = :leafTotal, reductionsRemaining = :reductions, readyCount = :zero, claimedCount = :zero, leafTasksDone = :zero, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':running': 'RUNNING',
          ':chunk': counters.chunkSizeUsed,
          ':leafTotal': counters.leafTasksTotal,
          ':reductions': counters.reductionsRemaining,
          ':zero': 0,
          ':now': nowMs
        }
      })
    );
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
    return fleetRecordSchema.parse(output.Item);
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
    return fleetRecordSchema.parse(output.Attributes ?? {});
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
    return fleetRecordSchema.parse(output.Attributes ?? {});
  }
}

