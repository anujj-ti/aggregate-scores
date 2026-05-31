import { createApp } from '../../src/app.js';
import { DispatcherService } from '../../src/services/dispatcher.js';
import { FleetService } from '../../src/services/fleet-service.js';
import { GeneratorService } from '../../src/services/generator.js';
import { JobService } from '../../src/services/job-service.js';
import { MockDynamoStore, MockS3Store, MockSqsQueue } from './mock-clients.js';

export const buildTestApp = () => {
  const dynamo = new MockDynamoStore();
  const s3 = new MockS3Store();
  const queue = new MockSqsQueue();
  const generator = new GeneratorService({ s3 });
  const dispatcher = new DispatcherService({
    dynamo,
    queue,
    admissionFactorK: 2
  });
  const jobs = new JobService({ dynamo, s3 });
  const fleet = new FleetService({ dynamo, maxWorkers: 10 });
  const app = createApp({ jobs, fleet, dispatcher, generator, s3, dispatchOnSubmit: false });
  return { app, dynamo, s3, queue, dispatcher, jobs, fleet, generator };
};

