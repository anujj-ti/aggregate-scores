import fs from 'node:fs/promises';
import path from 'node:path';

import { zodToJsonSchema } from 'zod-to-json-schema';

import { schemaRegistry } from '../src/contracts/schema-registry.js';

const run = async (): Promise<void> => {
  const outDir = path.resolve(process.cwd(), 'schemas');
  await fs.mkdir(outDir, { recursive: true });

  for (const [name, schema] of Object.entries(schemaRegistry)) {
    const jsonSchema = zodToJsonSchema(schema, {
      name,
      target: 'jsonSchema7'
    });
    const outFile = path.join(outDir, `${name}.schema.json`);
    await fs.writeFile(outFile, `${JSON.stringify(jsonSchema, null, 2)}\n`, 'utf8');
  }
};

void run();
