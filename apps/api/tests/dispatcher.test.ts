import { describe, expect, test } from 'vitest';

import { DispatcherService } from '../src/services/dispatcher.js';
import { GeneratorService } from '../src/services/generator.js';
import { MockDynamoStore, MockS3Store, MockSqsQueue } from './helpers/mock-clients.js';

describe('dispatcher admission', () => {
  test('admits oldest pending jobs up to inFlight target', async () => {
    const dynamo = new MockDynamoStore();
    const s3 = new MockS3Store();
    const queue = new MockSqsQueue();
    const generator = new GeneratorService({ s3 });
    const dispatcher = new DispatcherService({
      dynamo,
      queue,
      generator,
      admissionFactorK: 2
    });

    await dynamo.createPendingJob({ jobId: 'job_old', f: 12, c: 3, nowMs: 100 });
    await dynamo.createPendingJob({ jobId: 'job_new', f: 10, c: 3, nowMs: 200 });

    await dispatcher.runAdmissionCycle();

    const oldJob = await dynamo.getJob('job_old');
    const newJob = await dynamo.getJob('job_new');
    expect(oldJob?.status).toBe('RUNNING');
    expect(newJob?.status).toBe('RUNNING');
    expect(oldJob?.leafTasksTotal).toBe(3);
    expect(oldJob?.reductionsRemaining).toBe(2);
    expect(queue.tasks.length).toBe(5);
  });
});

