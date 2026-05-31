import express from 'express';
import { setWorkersRequestSchema } from '@aggregate/shared';
import type { Express } from 'express';

import type { S3Port } from './clients/s3.js';
import { createFleetRouter } from './routes/fleet.js';
import { createJobsRouter } from './routes/jobs.js';
import { DispatcherService } from './services/dispatcher.js';
import { FleetService } from './services/fleet-service.js';
import { GeneratorService } from './services/generator.js';
import { JobService } from './services/job-service.js';
import { errorHandler } from './middleware/error-handler.js';
import { validateBody } from './middleware/validate.js';

type AppDeps = {
  readonly jobs: JobService;
  readonly fleet: FleetService;
  readonly dispatcher: DispatcherService;
  readonly generator: GeneratorService;
  readonly s3: S3Port;
  readonly dispatchOnSubmit?: boolean;
};

export const createApp = (deps: AppDeps): Express => {
  const app = express();
  app.use(express.json());

  app.use(
    '/jobs',
    createJobsRouter({
      jobs: deps.jobs,
      dispatcher: deps.dispatcher,
      generator: deps.generator,
      s3: deps.s3,
      dispatchOnSubmit: deps.dispatchOnSubmit ?? true
    })
  );
  app.use('/fleet', createFleetRouter({ fleet: deps.fleet }));
  app.post('/workers', validateBody(setWorkersRequestSchema), async (req, res, next) => {
    try {
      const body = setWorkersRequestSchema.parse(req.body as unknown);
      const view = await deps.fleet.setWorkers(body.count);
      res.status(200).json(view);
    } catch (error) {
      next(error);
    }
  });
  app.post('/internal/dispatcher/tick', async (_req, res, next) => {
    try {
      await deps.dispatcher.runAdmissionCycle();
      res.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  app.use(errorHandler);
  return app;
};

