import { inputKey } from '@aggregate/shared';

import type { S3Port } from '../clients/s3.js';

type GeneratorDeps = {
  readonly s3: S3Port;
};

export class GeneratorService {
  private readonly s3: S3Port;

  public constructor(deps: GeneratorDeps) {
    this.s3 = deps.s3;
  }

  public async generateFiles(jobId: string, f: number, c: number): Promise<void> {
    for (let fileIndex = 0; fileIndex < f; fileIndex += 1) {
      const vector = new Float32Array(c);
      for (let idx = 0; idx < c; idx += 1) {
        vector[idx] = Math.random();
      }
      const bytes = encodeNpyFloat32(vector);
      await this.s3.putObject(inputKey(jobId, fileIndex), bytes);
    }
  }
}

export const encodeNpyFloat32 = (array: Float32Array): Uint8Array => {
  const magic = new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);
  const version = new Uint8Array([0x01, 0x00]);
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${array.length},), }`;
  const headerBytes = new TextEncoder().encode(header);
  const preambleLength = magic.length + version.length + 2;
  const newlineLength = 1;
  const minimumHeaderLength = headerBytes.length + newlineLength;
  const padLength = (16 - ((preambleLength + minimumHeaderLength) % 16)) % 16;
  const totalHeaderLength = minimumHeaderLength + padLength;
  const headerLengthBuffer = new Uint8Array(2);
  const headerLengthView = new DataView(headerLengthBuffer.buffer);
  headerLengthView.setUint16(0, totalHeaderLength, true);

  const dataBytes = new Uint8Array(array.length * 4);
  const dataView = new DataView(dataBytes.buffer);
  for (let idx = 0; idx < array.length; idx += 1) {
    const value = array[idx];
    if (value === undefined) {
      throw new Error(`Missing float value at index ${idx}`);
    }
    dataView.setFloat32(idx * 4, value, true);
  }

  const output = new Uint8Array(magic.length + version.length + 2 + totalHeaderLength + dataBytes.length);
  let offset = 0;
  output.set(magic, offset);
  offset += magic.length;
  output.set(version, offset);
  offset += version.length;
  output.set(headerLengthBuffer, offset);
  offset += headerLengthBuffer.length;
  output.set(headerBytes, offset);
  offset += headerBytes.length;
  for (let padIdx = 0; padIdx < padLength; padIdx += 1) {
    output[offset + padIdx] = 0x20;
  }
  offset += padLength;
  output[offset] = 0x0a;
  offset += 1;
  output.set(dataBytes, offset);
  return output;
};

