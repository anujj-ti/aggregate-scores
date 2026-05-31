import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { DynamoStore } from './clients/dynamo.js';
import { S3Store } from './clients/s3.js';
import { SqsWorkQueue } from './clients/sqs.js';
import { JobService } from './services/job-service.js';
import { FleetService } from './services/fleet-service.js';
import { DispatcherService } from './services/dispatcher.js';
import { GeneratorService } from './services/generator.js';

const config = loadConfig();
const dynamo = new DynamoStore({ config });
const s3 = new S3Store({ config });
const queue = new SqsWorkQueue({ config });

const jobs = new JobService({ dynamo, s3 });
const fleet = new FleetService({ dynamo, maxWorkers: config.maxWorkers });
const generator = new GeneratorService({ s3 });
const dispatcher = new DispatcherService({
  dynamo,
  queue,
  admissionFactorK: config.admissionFactorK
});

const app = createApp({
  jobs,
  fleet,
  dispatcher,
  generator,
  s3
});

app.listen(config.apiPort, () => {
  console.log(`API listening on http://localhost:${config.apiPort}`);
  console.log(`API AWS endpoint=${config.awsEndpointUrl ?? 'aws-default'} key=${config.awsAccessKeyId}`);
});

setInterval(() => {
  dispatcher.runAdmissionCycle().catch((error: unknown) => {
    console.error('dispatcher tick failed', error);
  });
}, config.dispatcherTickMs);
