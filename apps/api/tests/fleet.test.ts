import request from 'supertest';
import { describe, expect, test } from 'vitest';

import { fleetViewSchema } from '@aggregate/shared';

import { buildTestApp } from './helpers/test-app.js';

describe('fleet endpoints', () => {
  test('GET /fleet returns W/inFlight/free', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/fleet');
    const view = fleetViewSchema.parse(response.body);

    expect(response.status).toBe(200);
    expect(view.W).toBe(5);
    expect(view.inFlight).toBe(0);
    expect(view.free).toBe(5);
  });

  test('POST /workers updates W', async () => {
    const { app } = buildTestApp();
    const response = await request(app).post('/workers').send({ count: 8 });
    const view = fleetViewSchema.parse(response.body);

    expect(response.status).toBe(200);
    expect(view.W).toBe(8);
    expect(view.free).toBe(8);
  });
});

