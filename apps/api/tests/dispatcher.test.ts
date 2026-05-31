import { describe, expect, test } from 'vitest';

import { DispatcherService } from '../src/services/dispatcher.js';
import { MockDynamoStore, MockSqsQueue } from './helpers/mock-clients.js';

describe('dispatcher admission', () => {
  test('admits oldest pending jobs up to inFlight target', async () => {
    const dynamo = new MockDynamoStore();
    const queue = new MockSqsQueue();
    const dispatcher = new DispatcherService({
      dynamo,
      queue,
      admissionFactorK: 2
    });

    // Jobs become admissible only after generation releases them to PENDING.
    await dynamo.createJob({ jobId: 'job_old', f: 12, c: 3, reuseSampleFile: false, nowMs: 100 });
    await dynamo.createJob({ jobId: 'job_new', f: 10, c: 3, reuseSampleFile: false, nowMs: 200 });
    await dynamo.markGenerationComplete('job_old', 110);
    await dynamo.markGenerationComplete('job_new', 210);

    await dispatcher.runAdmissionCycle();

    const oldJob = await dynamo.getJob('job_old');
    const newJob = await dynamo.getJob('job_new');
    expect(oldJob?.status).toBe('RUNNING');
    expect(newJob?.status).toBe('RUNNING');
    expect(oldJob?.leafTasksTotal).toBe(3);
    expect(oldJob?.reductionsRemaining).toBe(2);
    expect(queue.tasks.length).toBe(5);
  });

  test('resets stale inFlight when there are no running jobs', async () => {
    const dynamo = new MockDynamoStore();
    const queue = new MockSqsQueue();
    const dispatcher = new DispatcherService({
      dynamo,
      queue,
      admissionFactorK: 2
    });

    await dynamo.addFleetInFlight(20);
    expect((await dynamo.getFleet()).inFlight).toBe(20);

    await dispatcher.runAdmissionCycle();

    expect((await dynamo.getFleet()).inFlight).toBe(0);
  });
});

