import { CHUNK_SIZE, inputKey, taskId } from '@aggregate/shared';
import type { MergeTask } from '@aggregate/shared';

import type { DynamoPort } from '../clients/dynamo.js';
import type { SqsPort } from '../clients/sqs.js';

type DispatcherDeps = {
  readonly dynamo: DynamoPort;
  readonly queue: SqsPort;
  readonly admissionFactorK: number;
};

export class DispatcherService {
  private readonly dynamo: DynamoPort;

  private readonly queue: SqsPort;

  private readonly admissionFactorK: number;

  public constructor(deps: DispatcherDeps) {
    this.dynamo = deps.dynamo;
    this.queue = deps.queue;
    this.admissionFactorK = deps.admissionFactorK;
  }

  public async runAdmissionCycle(): Promise<void> {
    let fleet = await this.dynamo.getFleet();
    const hasRunningJobs = await this.dynamo.hasRunningJobs();
    if (!hasRunningJobs && fleet.inFlight !== 0) {
      fleet = await this.dynamo.setFleetInFlight(0);
    }
    const targetInFlight = fleet.W * this.admissionFactorK;

    while (fleet.inFlight < targetInFlight) {
      const pending = await this.dynamo.getOldestPendingJob();
      if (pending === null) {
        return;
      }
      if (pending.status !== 'PENDING') {
        return;
      }

      // Input files were already written during the GENERATING phase, so admission only
      // needs to flip the job to RUNNING and enqueue leaf tasks — no generation here.
      const leafTasksTotal = Math.ceil(pending.F / CHUNK_SIZE);
      const reductionsRemaining = leafTasksTotal - 1;
      const nowMs = Date.now();
      const movedToRunning = await this.dynamo.markJobRunning(
        pending.jobId,
        {
          chunkSizeUsed: CHUNK_SIZE,
          leafTasksTotal,
          reductionsRemaining
        },
        nowMs
      );
      if (!movedToRunning) {
        continue;
      }

      for (let leafIdx = 0; leafIdx < leafTasksTotal; leafIdx += 1) {
        const start = leafIdx * CHUNK_SIZE;
        const endExclusive = Math.min(pending.F, start + CHUNK_SIZE);
        const keys: string[] = [];
        for (let fileIdx = start; fileIdx < endExclusive; fileIdx += 1) {
          keys.push(inputKey(pending.jobId, fileIdx));
        }

        const queuedTaskId = taskId(pending.jobId, 'leaf', leafIdx);
        await this.dynamo.putQueuedTask({
          jobId: pending.jobId,
          taskId: queuedTaskId,
          kind: 'leaf',
          level: 0,
          inputKeys: keys,
          inputKind: 'file'
        });
        const mergeTask: MergeTask = {
          jobId: pending.jobId,
          taskId: queuedTaskId,
          inputKind: 'file',
          level: 0,
          inputKeys: keys,
          C: pending.C
        };
        await this.queue.sendMergeTask(mergeTask);
      }

      fleet = await this.dynamo.addFleetInFlight(leafTasksTotal);
    }
  }
}

