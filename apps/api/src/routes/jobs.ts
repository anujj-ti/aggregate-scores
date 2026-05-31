import archiver from 'archiver';
import { Router } from 'express';
import { z } from 'zod';

import { createJobRequestSchema, inputKey, jobStatusSchema } from '@aggregate/shared';

import type { S3Port } from '../clients/s3.js';
import { HttpError } from '../middleware/error-handler.js';
import { validateBody } from '../middleware/validate.js';
import { DispatcherService } from '../services/dispatcher.js';
import { GenerationCancelledError, GeneratorService } from '../services/generator.js';
import { JobService } from '../services/job-service.js';

type JobsRouteDeps = {
  readonly jobs: JobService;
  readonly dispatcher: DispatcherService;
  readonly generator: GeneratorService;
  readonly s3: S3Port;
  readonly dispatchOnSubmit: boolean;
};

const listQuerySchema = z.object({
  status: jobStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
});
const inputFileIndexSchema = z.coerce.number().int().min(0);

export const createJobsRouter = (deps: JobsRouteDeps): Router => {
  const router = Router();

  // Generation is the local stand-in for user-uploaded inputs. It runs off the request and
  // dispatcher critical path: write all files, release the job from GENERATING to PENDING,
  // then (optionally) trigger admission. The worker fleet only ever sees jobs whose inputs
  // already exist, so it never idles waiting for generation.
  const materializeInputs = async (
    jobId: string,
    f: number,
    c: number,
    reuseSampleFile: boolean
  ): Promise<void> => {
    try {
      let lastCheckMs = 0;
      let cachedShouldContinue = true;
      const shouldContinue = async (): Promise<boolean> => {
        const nowMs = Date.now();
        if (nowMs - lastCheckMs < 250) {
          return cachedShouldContinue;
        }
        lastCheckMs = nowMs;
        cachedShouldContinue = await deps.jobs.isGenerationActive(jobId);
        return cachedShouldContinue;
      };
      await deps.generator.generateFiles(jobId, f, c, {
        reuseSampleFile,
        shouldContinue
      });
      const released = await deps.jobs.markInputsReady(jobId);
      if (released && deps.dispatchOnSubmit) {
        try {
          await deps.dispatcher.runAdmissionCycle();
        } catch (error) {
          // Input generation already succeeded and the job was released to PENDING.
          // Do not fail the job if dispatch tick has a transient issue.
          console.error('dispatch after generation failed', jobId, error);
        }
      }
    } catch (error) {
      if (error instanceof GenerationCancelledError) {
        console.info('input generation cancelled', jobId);
        return;
      }
      console.error('input generation failed', jobId, error);
      try {
        await deps.jobs.failGeneration(jobId, error instanceof Error ? error.message : String(error));
      } catch (failError) {
        console.error('failed to flag generation failure', jobId, failError);
      }
    }
  };

  router.post('/', validateBody(createJobRequestSchema), async (req, res, next) => {
    try {
      const body = createJobRequestSchema.parse(req.body as unknown);
      const created = await deps.jobs.createJob(body);
      res.status(202).json(created);
      void materializeInputs(created.jobId, body.F, body.C, body.reuseSampleFile);
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

  router.get('/:jobId/inputs/:fileIndex', async (req, res, next) => {
    try {
      const jobId = req.params.jobId;
      if (jobId === undefined || jobId.length === 0) {
        throw new HttpError(400, 'jobId is required');
      }
      const parsedFileIndex = inputFileIndexSchema.safeParse(req.params.fileIndex);
      if (!parsedFileIndex.success) {
        throw new HttpError(400, 'fileIndex must be a non-negative integer');
      }
      const fileIndex = parsedFileIndex.data;
      const view = await deps.jobs.getJobView(jobId);
      if (view.status === 'GENERATING') {
        throw new HttpError(409, `Job ${jobId} is still generating input files`);
      }
      if (fileIndex >= view.F) {
        throw new HttpError(400, `fileIndex ${fileIndex} is out of range for F=${view.F}`);
      }
      const key = inputKey(jobId, fileIndex);
      try {
        const bytes = await deps.s3.getObjectBytes(key);
        res.status(200);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="input-${fileIndex}.npy"`);
        res.send(Buffer.from(bytes));
      } catch {
        throw new HttpError(404, `Input file ${fileIndex} is not available yet`);
      }
    } catch (error) {
      next(error);
    }
  });

  router.get('/:jobId/archive', async (req, res, next) => {
    try {
      const jobId = req.params.jobId;
      if (jobId === undefined || jobId.length === 0) {
        throw new HttpError(400, 'jobId is required');
      }
      // Resolve the plan first so a 404/409 is returned before any bytes are streamed.
      const plan = await deps.jobs.getJobArchivePlan(jobId);

      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${jobId}-files.zip"`);

      const archive = archiver('zip', { store: true });
      archive.on('error', (error: Error) => {
        res.destroy(error);
      });
      archive.pipe(res);

      const missing: string[] = [];
      for (const entry of plan.inputs) {
        try {
          const bytes = await deps.s3.getObjectBytes(entry.key);
          archive.append(Buffer.from(bytes), { name: entry.archiveName });
        } catch {
          missing.push(entry.archiveName);
        }
      }
      if (plan.result !== null) {
        try {
          const bytes = await deps.s3.getObjectBytes(plan.result.key);
          archive.append(Buffer.from(bytes), { name: plan.result.archiveName });
        } catch {
          missing.push(plan.result.archiveName);
        }
      }

      const notes: string[] = [`Job ${jobId}: ${plan.inputs.length} input file(s) included.`];
      if (plan.inputsTruncated) {
        notes.push(`Job has ${plan.f} input files; archive capped to the first ${plan.inputs.length}.`);
      }
      if (missing.length > 0) {
        notes.push(`Missing (not yet written) objects skipped: ${missing.join(', ')}.`);
      }
      archive.append(`${notes.join('\n')}\n`, { name: 'MANIFEST.txt' });

      await archive.finalize();
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
      const cancelled = await deps.jobs.cancelJob(jobId);
      res.status(200).json(cancelled);
    } catch (error) {
      next(error);
    }
  });

  return router;
};

