import { randomUUID } from 'node:crypto';

import type { CreateJobRequest, CreateJobResponse, JobStatus, JobView } from '@aggregate/shared';

import type { DynamoPort, JobRecord } from '../clients/dynamo.js';
import type { S3Port } from '../clients/s3.js';
import { HttpError } from '../middleware/error-handler.js';

type JobDeps = {
  readonly dynamo: DynamoPort;
  readonly s3: S3Port;
};

export class JobService {
  private readonly dynamo: DynamoPort;

  private readonly s3: S3Port;

  public constructor(deps: JobDeps) {
    this.dynamo = deps.dynamo;
    this.s3 = deps.s3;
  }

  public async createJob(payload: CreateJobRequest): Promise<CreateJobResponse> {
    const nowMs = Date.now();
    const jobId = `job_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await this.dynamo.createPendingJob({
      jobId,
      f: payload.F,
      c: payload.C,
      nowMs
    });
    return { jobId };
  }

  public async getJobView(jobId: string): Promise<JobView> {
    const record = await this.dynamo.getJob(jobId);
    if (record === null) {
      throw new HttpError(404, `Job ${jobId} not found`);
    }
    return this.toJobView(record);
  }

  public async listJobViews(status?: JobStatus, limit?: number): Promise<JobView[]> {
    const records = await this.dynamo.listJobs(status, limit);
    const views: JobView[] = [];
    for (const record of records) {
      views.push(await this.toJobView(record));
    }
    return views;
  }

  public async cancelPending(jobId: string): Promise<{ cancelled: true }> {
    const record = await this.dynamo.getJob(jobId);
    if (record === null) {
      throw new HttpError(404, `Job ${jobId} not found`);
    }
    if (record.status !== 'PENDING') {
      throw new HttpError(409, `Job ${jobId} cannot be cancelled in status ${record.status}`);
    }
    await this.dynamo.deleteJob(jobId);
    return { cancelled: true };
  }

  private async toJobView(record: JobRecord): Promise<JobView> {
    const totalReductions = Math.max((record.leafTasksTotal ?? 1) - 1, 0);
    const reductionsRemaining = record.reductionsRemaining ?? totalReductions;
    const percent =
      totalReductions === 0
        ? record.status === 'COMPLETE'
          ? 1
          : 0
        : 1 - reductionsRemaining / totalReductions;

    const view: JobView = {
      jobId: record.jobId,
      status: record.status,
      F: record.F,
      C: record.C,
      submittedAt: record.submittedAt,
      percent: Math.min(Math.max(percent, 0), 1),
      reductionsRemaining
    };

    if (record.status === 'PENDING') {
      const beforeCount = await this.dynamo.countPendingBefore(record.submittedAt);
      view.queuePosition = beforeCount + 1;
    }
    if (record.status === 'COMPLETE' && record.resultKey !== undefined) {
      view.resultUrl = await this.s3.getSignedDownloadUrl(record.resultKey);
    }
    if (record.status === 'FAILED' && record.error !== undefined) {
      view.error = record.error;
    }
    return view;
  }
}

