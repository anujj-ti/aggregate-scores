import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { createJobResponseSchema, jobViewSchema } from '@aggregate/shared';

import { buildTestApp } from './helpers/test-app.js';

describe('jobs endpoints', () => {
  test('POST /jobs returns 202 and job id', async () => {
    const { app } = buildTestApp();
    const response = await request(app)
      .post('/jobs')
      .send({ F: 4, C: 3 });

    const created = createJobResponseSchema.parse(response.body);
    expect(response.status).toBe(202);
    expect(created.jobId.length).toBeGreaterThan(4);
  });

  test('GET /jobs/:id returns job view', async () => {
    const { app } = buildTestApp();
    const created = await request(app).post('/jobs').send({ F: 3, C: 2 });
    const createdBody = createJobResponseSchema.parse(created.body);
    const response = await request(app).get(`/jobs/${createdBody.jobId}`);
    const view = jobViewSchema.parse(response.body);

    expect(response.status).toBe(200);
    expect(view.jobId).toBe(createdBody.jobId);
    expect(view.F).toBe(3);
    expect(view.C).toBe(2);
  });

  test('DELETE /jobs/:id cancels a pending job', async () => {
    const { app } = buildTestApp();
    const created = await request(app).post('/jobs').send({ F: 20, C: 2 });
    const createdBody = createJobResponseSchema.parse(created.body);
    const cancelResponse = await request(app).delete(`/jobs/${createdBody.jobId}`);
    const cancelled = z.object({ cancelled: z.literal(true) }).parse(cancelResponse.body);

    expect(cancelResponse.status).toBe(200);
    expect(cancelled.cancelled).toBe(true);
  });
});

