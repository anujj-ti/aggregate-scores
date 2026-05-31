import type { JobStatus, MergeTask } from '@aggregate/shared';

import type { DynamoPort, FleetRecord, JobRecord, RunningJobCounters } from '../../src/clients/dynamo.js';
import type { S3Port } from '../../src/clients/s3.js';
import type { SqsPort } from '../../src/clients/sqs.js';

export class MockDynamoStore implements DynamoPort {
  public readonly jobs = new Map<string, JobRecord>();

  public readonly tasks: Array<{
    jobId: string;
    taskId: string;
    kind: 'leaf' | 'merge';
    level: number;
    inputKeys: string[];
    inputKind: 'file' | 'partial';
  }> = [];

  private fleet: FleetRecord = {
    pk: 'FLEET',
    W: 5,
    inFlight: 0
  };

  public createPendingJob(input: { jobId: string; f: number; c: number; nowMs: number }): Promise<void> {
    this.jobs.set(input.jobId, {
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
    });
    return Promise.resolve();
  }

  public getJob(jobId: string): Promise<JobRecord | null> {
    return Promise.resolve(this.jobs.get(jobId) ?? null);
  }

  public listJobs(status?: JobStatus, limit: number = 50): Promise<JobRecord[]> {
    const rows = Array.from(this.jobs.values())
      .filter((row) => (status === undefined ? true : row.status === status))
      .sort((left, right) => right.submittedAt - left.submittedAt);
    return Promise.resolve(rows.slice(0, limit));
  }

  public countPendingBefore(submittedAt: number): Promise<number> {
    return Promise.resolve(Array.from(this.jobs.values()).filter(
      (row) => row.status === 'PENDING' && row.submittedAt < submittedAt
    ).length);
  }

  public deleteJob(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    return Promise.resolve();
  }

  public markJobRunning(jobId: string, counters: RunningJobCounters, nowMs: number): Promise<void> {
    const row = this.jobs.get(jobId);
    if (row === undefined) {
      return Promise.resolve();
    }
    this.jobs.set(jobId, {
      ...row,
      status: 'RUNNING',
      chunkSizeUsed: counters.chunkSizeUsed,
      leafTasksTotal: counters.leafTasksTotal,
      reductionsRemaining: counters.reductionsRemaining,
      readyCount: 0,
      claimedCount: 0,
      leafTasksDone: 0,
      updatedAt: nowMs
    });
    return Promise.resolve();
  }

  public getOldestPendingJob(): Promise<JobRecord | null> {
    const pending = Array.from(this.jobs.values())
      .filter((row) => row.status === 'PENDING')
      .sort((left, right) => left.submittedAt - right.submittedAt);
    return Promise.resolve(pending.length > 0 ? (pending[0] ?? null) : null);
  }

  public putQueuedTask(input: {
    jobId: string;
    taskId: string;
    kind: 'leaf' | 'merge';
    level: number;
    inputKeys: string[];
    inputKind: 'file' | 'partial';
  }): Promise<void> {
    this.tasks.push(input);
    return Promise.resolve();
  }

  public getFleet(): Promise<FleetRecord> {
    return Promise.resolve(this.fleet);
  }

  public setFleetW(w: number): Promise<FleetRecord> {
    this.fleet = { ...this.fleet, W: w };
    return Promise.resolve(this.fleet);
  }

  public addFleetInFlight(delta: number): Promise<FleetRecord> {
    this.fleet = {
      ...this.fleet,
      inFlight: this.fleet.inFlight + delta
    };
    return Promise.resolve(this.fleet);
  }
}

export class MockS3Store implements S3Port {
  public readonly objects = new Map<string, Uint8Array>();

  public putObject(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
    return Promise.resolve();
  }

  public getSignedDownloadUrl(key: string): Promise<string> {
    return Promise.resolve(`https://example.local/${key}`);
  }
}

export class MockSqsQueue implements SqsPort {
  public readonly tasks: MergeTask[] = [];

  public sendMergeTask(task: MergeTask): Promise<void> {
    this.tasks.push(task);
    return Promise.resolve();
  }
}

