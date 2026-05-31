import { Router } from 'express';
import { z } from 'zod';

import { createJobRequestSchema, jobStatusSchema } from '@aggregate/shared';

import { HttpError } from '../middleware/error-handler.js';
import { validateBody } from '../middleware/validate.js';
import { DispatcherService } from '../services/dispatcher.js';
import { JobService } from '../services/job-service.js';

type JobsRouteDeps = {
  readonly jobs: JobService;
  readonly dispatcher: DispatcherService;
  readonly dispatchOnSubmit: boolean;
};

const listQuerySchema = z.object({
  status: jobStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
});

export const createJobsRouter = (deps: JobsRouteDeps): Router => {
  const router = Router();

  router.post('/', validateBody(createJobRequestSchema), async (req, res, next) => {
    try {
      const body = createJobRequestSchema.parse(req.body as unknown);
      const created = await deps.jobs.createJob(body);
      res.status(202).json(created);
      if (deps.dispatchOnSubmit) {
        setImmediate(() => {
          deps.dispatcher.runAdmissionCycle().catch((error: unknown) => {
            console.error('dispatcher trigger failed', error);
          });
        });
      }
    } catch (error) {
      next(error);
    }
  });

  router.get('/:jobId', async (req, res, next) => {
    try {
      const jobId = req.params.jobId;
      if (jobId === undefined || jobId.length === 0) {
        throw new HttpError(400, 'jobId is required');
      }
      const view = await deps.jobs.getJobView(jobId);
      res.status(200).json(view);
    } catch (error) {
      next(error);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join('; '));
      }
      const views = await deps.jobs.listJobViews(parsed.data.status, parsed.data.limit);
      res.status(200).json(views);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:jobId', async (req, res, next) => {
    try {
      const jobId = req.params.jobId;
      if (jobId === undefined || jobId.length === 0) {
        throw new HttpError(400, 'jobId is required');
      }
      const cancelled = await deps.jobs.cancelPending(jobId);
      res.status(200).json(cancelled);
    } catch (error) {
      next(error);
    }
  });

  return router;
};

