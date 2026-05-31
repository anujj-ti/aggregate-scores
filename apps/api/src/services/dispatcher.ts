import { CHUNK_SIZE, inputKey, taskId } from '@aggregate/shared';
import type { MergeTask } from '@aggregate/shared';

import type { DynamoPort } from '../clients/dynamo.js';
import type { SqsPort } from '../clients/sqs.js';
import { GeneratorService } from './generator.js';

type DispatcherDeps = {
  readonly dynamo: DynamoPort;
  readonly queue: SqsPort;
  readonly generator: GeneratorService;
  readonly admissionFactorK: number;
};

export class DispatcherService {
  private readonly dynamo: DynamoPort;

  private readonly queue: SqsPort;

  private readonly generator: GeneratorService;

  private readonly admissionFactorK: number;

  public constructor(deps: DispatcherDeps) {
    this.dynamo = deps.dynamo;
    this.queue = deps.queue;
    this.generator = deps.generator;
    this.admissionFactorK = deps.admissionFactorK;
  }

  public async runAdmissionCycle(): Promise<void> {
    let fleet = await this.dynamo.getFleet();
    const targetInFlight = fleet.W * this.admissionFactorK;

    while (fleet.inFlight < targetInFlight) {
      const pending = await this.dynamo.getOldestPendingJob();
      if (pending === null) {
        return;
      }
      if (pending.status !== 'PENDING') {
        return;
      }

      await this.generator.generateFiles(pending.jobId, pending.F, pending.C);

      const leafTasksTotal = Math.ceil(pending.F / CHUNK_SIZE);
      const reductionsRemaining = leafTasksTotal - 1;
      const nowMs = Date.now();
      await this.dynamo.markJobRunning(
        pending.jobId,
        {
          chunkSizeUsed: CHUNK_SIZE,
          leafTasksTotal,
          reductionsRemaining
        },
        nowMs
      );

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

