import { describe, expect, test } from 'vitest';

import { GenerationCancelledError, GeneratorService, encodeNpyFloat32 } from '../src/services/generator.js';
import { MockS3Store } from './helpers/mock-clients.js';

describe('generator', () => {
  test('writes F input files', async () => {
    const s3 = new MockS3Store();
    const generator = new GeneratorService({ s3 });

    await generator.generateFiles('job_1', 7, 4);
    expect(s3.objects.size).toBe(7);
  });

  test('reuseSampleFile writes identical bytes to every input', async () => {
    const s3 = new MockS3Store();
    const generator = new GeneratorService({ s3 });

    await generator.generateFiles('job_reuse', 5, 3, { reuseSampleFile: true });

    expect(s3.objects.size).toBe(5);
    const payloads = Array.from(s3.objects.values());
    const first = payloads[0];
    expect(first).toBeDefined();
    for (const payload of payloads) {
      expect(Array.from(payload)).toEqual(Array.from(first as Uint8Array));
    }
  });

  test('stops generation early when cancellation callback flips false', async () => {
    const s3 = new MockS3Store();
    const generator = new GeneratorService({ s3 });
    let checks = 0;

    await expect(
      generator.generateFiles('job_cancel', 100, 16, {
        shouldContinue: () => {
          checks += 1;
          return checks < 8;
        }
      })
    ).rejects.toBeInstanceOf(GenerationCancelledError);

    expect(s3.objects.size).toBeLessThan(100);
  });

  test('encodes numpy magic header', () => {
    const bytes = encodeNpyFloat32(new Float32Array([0.1, 0.2]));
    expect(bytes[0]).toBe(0x93);
    expect(bytes[1]).toBe(0x4e);
    expect(bytes[2]).toBe(0x55);
    expect(bytes[3]).toBe(0x4d);
    expect(bytes[4]).toBe(0x50);
    expect(bytes[5]).toBe(0x59);
  });
});

