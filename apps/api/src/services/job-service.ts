import { randomUUID } from 'node:crypto';

import { CHUNK_SIZE, inputKey, resultKey, taskId } from '@aggregate/shared';
import type { CreateJobRequest, CreateJobResponse, JobStatus, JobView } from '@aggregate/shared';

import type { DynamoPort, JobRecord } from '../clients/dynamo.js';
import type { S3Port } from '../clients/s3.js';
import { HttpError } from '../middleware/error-handler.js';

type JobDeps = {
  readonly dynamo: DynamoPort;
  readonly s3: S3Port;
};

export type JobArchiveEntry = {
  readonly key: string;
  readonly archiveName: string;
};

export type JobArchivePlan = {
  readonly jobId: string;
  readonly f: number;
  readonly inputs: JobArchiveEntry[];
  readonly result: JobArchiveEntry | null;
  readonly inputsTruncated: boolean;
};

export class JobService {
  private static readonly TASK_DETAILS_LIMIT = 300;

  private static readonly ARCHIVE_INPUT_LIMIT = 500;

  private readonly dynamo: DynamoPort;

  private readonly s3: S3Port;

  public constructor(deps: JobDeps) {
    this.dynamo = deps.dynamo;
    this.s3 = deps.s3;
  }

  private static planLevelTaskCounts(f: number, chunkSizeUsed: number): number[] {
    const chunk = Math.max(1, chunkSizeUsed);
    const levels: number[] = [];
    let remaining = Math.max(1, f);
    while (true) {
      const tasksAtLevel = Math.max(1, Math.ceil(remaining / chunk));
      levels.push(tasksAtLevel);
      if (tasksAtLevel <= 1) {
        return levels;
      }
      remaining = tasksAtLevel;
    }
  }

  private static plannedWorkUnitsForRecord(record: JobRecord, chunkSizeUsed: number): number {
    const levelTaskCounts = JobService.planLevelTaskCounts(record.F, chunkSizeUsed);
    const taskSteps = levelTaskCounts.reduce((sum, count) => sum + count, 0);
    return Math.max(0, record.F + taskSteps + 1);
  }

  private static estimatedWorkUnitsDoneForRecord(
    record: JobRecord,
    chunkSizeUsed: number,
    leafTasksTotal: number,
    leafTasksDone: number,
    reductionsRemaining: number
  ): number {
    const totalUnits = JobService.plannedWorkUnitsForRecord(record, chunkSizeUsed);
    if (totalUnits === 0) {
      return 0;
    }
    if (record.status === 'COMPLETE') {
      return totalUnits;
    }

    const clampedLeafDone = Math.min(leafTasksTotal, Math.max(0, leafTasksDone));
    const fileStepsDone = Math.min(record.F, clampedLeafDone * chunkSizeUsed);

    const levelTaskCounts = JobService.planLevelTaskCounts(record.F, chunkSizeUsed);
    const mergeTasksTotal = Math.max(
      0,
      levelTaskCounts.reduce((sum, count) => sum + count, 0) - (levelTaskCounts[0] ?? 0)
    );
    const reductionsTotal = Math.max(leafTasksTotal - 1, 0);
    const reductionsCompleted = Math.max(0, reductionsTotal - reductionsRemaining);
    const mergeTasksDoneEstimate =
      reductionsTotal === 0
        ? 0
        : Math.min(
            mergeTasksTotal,
            Math.round((reductionsCompleted / reductionsTotal) * mergeTasksTotal)
          );

    return Math.min(totalUnits, fileStepsDone + clampedLeafDone + mergeTasksDoneEstimate);
  }

  public async createJob(payload: CreateJobRequest): Promise<CreateJobResponse> {
    const nowMs = Date.now();
    const jobId = `job_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await this.dynamo.createJob({
      jobId,
      f: payload.F,
      c: payload.C,
      reuseSampleFile: payload.reuseSampleFile,
      nowMs
    });
    return { jobId };
  }

  // Called by the submit path once all input files are written, releasing the job from
  // GENERATING to PENDING so the dispatcher can admit it.
  public async markInputsReady(jobId: string): Promise<boolean> {
    return this.dynamo.markGenerationComplete(jobId, Date.now());
  }

  public async failGeneration(jobId: string, error: string): Promise<void> {
    await this.dynamo.failJob(jobId, error, Date.now());
  }

  public async isGenerationActive(jobId: string): Promise<boolean> {
    const record = await this.dynamo.getJob(jobId);
    return record?.status === 'GENERATING';
  }

  public async getJobView(jobId: string): Promise<JobView> {
    const record = await this.dynamo.getJob(jobId);
    if (record === null) {
      throw new HttpError(404, `Job ${jobId} not found`);
    }
    return this.toJobView(record, { includeTaskSummary: true });
  }

  public async listJobViews(status?: JobStatus, limit?: number): Promise<JobView[]> {
    const records = await this.dynamo.listJobs(status, limit);
    const views: JobView[] = [];
    for (const record of records) {
      views.push(await this.toJobView(record, { includeTaskSummary: false }));
    }
    return views;
  }

  public async cancelJob(jobId: string): Promise<{ cancelled: true }> {
    const record = await this.dynamo.getJob(jobId);
    if (record === null) {
      throw new HttpError(404, `Job ${jobId} not found`);
    }
    if (record.status === 'COMPLETE' || record.status === 'FAILED' || record.status === 'CANCELLED') {
      throw new HttpError(409, `Job ${jobId} cannot be cancelled in status ${record.status}`);
    }
    const cancelled = await this.dynamo.cancelJob(jobId, Date.now());
    if (!cancelled) {
      throw new HttpError(409, `Job ${jobId} could not be cancelled due to a concurrent update`);
    }
    return { cancelled: true };
  }

  // Input files are written to S3 only when the dispatcher admits the job, so a
  // still-PENDING job has nothing to download yet. The result.csv is added only once
  // the job is COMPLETE. The input list is capped to keep the streamed archive bounded.
  public async getJobArchivePlan(jobId: string): Promise<JobArchivePlan> {
    const record = await this.dynamo.getJob(jobId);
    if (record === null) {
      throw new HttpError(404, `Job ${jobId} not found`);
    }
    if (record.status === 'GENERATING') {
      throw new HttpError(409, `Job ${jobId} is still generating input files; download is not available yet`);
    }
    const inputCount = Math.min(record.F, JobService.ARCHIVE_INPUT_LIMIT);
    const inputs: JobArchiveEntry[] = [];
    for (let fileIndex = 0; fileIndex < inputCount; fileIndex += 1) {
      inputs.push({
        key: inputKey(jobId, fileIndex),
        archiveName: `input/${fileIndex}.npy`
      });
    }
    const result: JobArchiveEntry | null =
      record.status === 'COMPLETE'
        ? { key: resultKey(jobId), archiveName: 'result.csv' }
        : null;
    return {
      jobId,
      f: record.F,
      inputs,
      result,
      inputsTruncated: record.F > JobService.ARCHIVE_INPUT_LIMIT
    };
  }

  private async toJobView(
    record: JobRecord,
    options: { includeTaskSummary: boolean }
  ): Promise<JobView> {
    const chunkSizeUsedForProgress = record.chunkSizeUsed ?? CHUNK_SIZE;
    const leafTasksTotalForProgress =
      record.leafTasksTotal ?? Math.max(1, Math.ceil(record.F / chunkSizeUsedForProgress));
    const leafTasksDoneForProgress = Math.min(
      leafTasksTotalForProgress,
      Math.max(0, record.leafTasksDone ?? 0)
    );
    const totalReductions = Math.max(leafTasksTotalForProgress - 1, 0);
    const reductionsRemaining = record.reductionsRemaining ?? totalReductions;
    const totalUnits = JobService.plannedWorkUnitsForRecord(record, chunkSizeUsedForProgress);
    const doneUnits = JobService.estimatedWorkUnitsDoneForRecord(
      record,
      chunkSizeUsedForProgress,
      leafTasksTotalForProgress,
      leafTasksDoneForProgress,
      reductionsRemaining
    );
    const percent = totalUnits === 0 ? 0 : doneUnits / totalUnits;

    const view: JobView = {
      jobId: record.jobId,
      status: record.status,
      F: record.F,
      C: record.C,
      reuseSampleFile: record.reuseSampleFile ?? false,
      submittedAt: record.submittedAt,
      percent: Math.min(Math.max(percent, 0), 1),
      reductionsRemaining,
      chunkSizeUsed: record.chunkSizeUsed,
      leafTasksTotal: record.leafTasksTotal,
      leafTasksDone: record.leafTasksDone,
      readyCount: record.readyCount,
      claimedCount: record.claimedCount
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
    if (options.includeTaskSummary) {
      const tasks = await this.dynamo.listTasksForJob(record.jobId, JobService.TASK_DETAILS_LIMIT);
      const levelMap = new Map<number, { queued: number; inProgress: number; done: number; failed: number }>();
      let queued = 0;
      let inProgress = 0;
      let done = 0;
      let failed = 0;
      for (const task of tasks) {
        const current = levelMap.get(task.level) ?? { queued: 0, inProgress: 0, done: 0, failed: 0 };
        if (task.status === 'QUEUED') {
          queued += 1;
          current.queued += 1;
        } else if (task.status === 'IN_PROGRESS') {
          inProgress += 1;
          current.inProgress += 1;
        } else if (task.status === 'DONE') {
          done += 1;
          current.done += 1;
        } else if (task.status === 'FAILED') {
          failed += 1;
          current.failed += 1;
        }
        levelMap.set(task.level, current);
      }
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
      view.taskSummary = {
        queued,
        inProgress,
        done,
        failed,
        total: tasks.length,
        byLevel
      };
      view.taskDetails = tasks.map((task) => ({
        taskId: task.taskId,
        kind: task.kind,
        level: task.level,
        status: task.status,
        inputKind: task.inputKind,
        inputKeys: task.inputKeys,
        attempts: task.attempts,
        ...(task.partialKey !== undefined ? { partialKey: task.partialKey } : {}),
        ...(task.error !== undefined ? { error: task.error } : {})
      }));
      view.taskDetailsLimit = JobService.TASK_DETAILS_LIMIT;
      view.taskDetailsTruncated = tasks.length >= JobService.TASK_DETAILS_LIMIT;
    }
    const chunkSizeUsed = record.chunkSizeUsed ?? CHUNK_SIZE;
    const leafTasksTotal = record.leafTasksTotal ?? Math.ceil(record.F / chunkSizeUsed);
    const previewRows: Array<{
      fileIndex: number;
      inputKey: string;
      plannedLeafTaskId: string;
      plannedLeafLevel: number;
    }> = [];
    const previewLimit = Math.min(record.F, 25);
    for (let fileIdx = 0; fileIdx < previewLimit; fileIdx += 1) {
      const leafIdx = Math.floor(fileIdx / chunkSizeUsed);
      previewRows.push({
        fileIndex: fileIdx,
        inputKey: inputKey(record.jobId, fileIdx),
        plannedLeafTaskId: taskId(record.jobId, 'leaf', leafIdx),
        plannedLeafLevel: 0
      });
    }
    if (previewRows.length > 0) {
      view.inputManifestPreview = previewRows;
    }

    view.chunkSizeUsed = chunkSizeUsed;
    view.leafTasksTotal = leafTasksTotal;

    return view;
  }
}

