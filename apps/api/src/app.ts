import express from 'express';
import { setWorkersRequestSchema } from '@aggregate/shared';
import type { Express } from 'express';

import { createFleetRouter } from './routes/fleet.js';
import { createJobsRouter } from './routes/jobs.js';
import { DispatcherService } from './services/dispatcher.js';
import { FleetService } from './services/fleet-service.js';
import { JobService } from './services/job-service.js';
import { errorHandler } from './middleware/error-handler.js';
import { validateBody } from './middleware/validate.js';

type AppDeps = {
  readonly jobs: JobService;
  readonly fleet: FleetService;
  readonly dispatcher: DispatcherService;
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

