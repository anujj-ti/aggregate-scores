import {
  DDB_TABLES,
  DEFAULT_W,
  FLEET_PK,
  QUEUES,
  S3_BUCKET_NAME
} from '../packages/shared/src/constants.js';

const FLEET_TABLE = 'AggregateFleet';

const vars: Record<string, string | number> = {
  S3_BUCKET_NAME,
  QUEUE_WORK: QUEUES.WORK,
  QUEUE_DLQ: QUEUES.DLQ,
  DDB_TABLE_JOBS: DDB_TABLES.JOBS,
  DDB_TABLE_READY: DDB_TABLES.READY,
  DDB_TABLE_TASKS: DDB_TABLES.TASKS,
  DDB_TABLE_FLEET: FLEET_TABLE,
  FLEET_PK,
  DEFAULT_W
};

for (const [key, value] of Object.entries(vars)) {
  const safeValue = String(value).replace(/'/g, "'\\''");
  console.log(`export ${key}='${safeValue}'`);
}
