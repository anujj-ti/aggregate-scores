# Phase 1 — Contracts & Diagrams (detailed plan)

Expands [`PLAN.md` Phase 1](../../PLAN.md). The goal of this phase is to **freeze the interfaces
everyone codes against** and produce the reference diagrams, *before* a line of worker/API logic is
written. The contracts in `packages/shared` are the **single source of truth**; the API doc and the
diagrams are derived from them and from the architecture docs, so nothing drifts.

## Dependencies & what can run in parallel

| Workstream | Needs Phase 0 (monorepo scaffold)? | Can start now? |
|------------|-----------------------------------|----------------|
| A. `packages/shared` contracts + constants | **Yes** (needs the TS workspace) | after P0 |
| B. `docs/api/api-contract.md` | No (pure doc) | now |
| C. `docs/diagrams/*` | No (pure doc) | now |

So **B and C can be done immediately**; A waits for the Phase 0 scaffold. Recommended order once P0
is green: **A → B → C** (the API doc references the shared DTOs; the ER diagram references the
tables). B/C can also be filled in parallel by extracting from existing architecture docs.

---

## Decision to confirm — cross-language contract source of truth

The contracts exist in **two languages** (TS for API/UI, Python for the worker). They must not
drift. Two ways to guarantee that:

| Option | How | Trade-off |
|--------|-----|-----------|
| **Recommended — generate** | **zod is the source** → emit JSON Schema (`zod-to-json-schema`) → generate Pydantic models (`datamodel-code-generator`). CI regenerates and fails if output differs. | One hand-written copy (zod). DRY (matches `code-design` rule). Adds two build tools. |
| Fallback — hand-mirror + parity test | Hand-write zod **and** Pydantic; CI validates a set of golden example payloads against both. | Two copies to keep in sync by discipline; simpler tooling. This is what `quality-and-ci.md` currently describes. |

**Action:** pick one. If we take the recommended path, update `quality-and-ci.md`'s "contract
integrity" section accordingly. The rest of this plan is written to work with either (the schema
*shapes* are identical; only the parity mechanism differs).

---

## Workstream A — `packages/shared` (the contract source)

### A1. Package layout

```text
packages/shared/
├── src/
│   ├── contracts/
│   │   ├── enums.ts        # JobStatus, TaskStatus, InputKind
│   │   ├── messages.ts     # MergeTask (the SQS task message)
│   │   ├── api.ts          # CreateJobRequest/Response, JobView, FleetView, SetWorkersRequest
│   │   └── index.ts
│   ├── constants.ts        # table/queue/bucket names, CHUNK_SIZE, k, default W
│   ├── keys.ts             # S3 key + DDB key helpers (one place builds every key)
│   └── index.ts
├── schemas/                # generated JSON Schema (emitted from zod) — committed
└── package.json
```

### A2. Schemas to define (zod → `z.infer` types)

Field-level shapes (all integers validated as non-negative ints; arrays length-bounded):

- **Enums** — `JobStatus = PENDING|RUNNING|COMPLETE|FAILED`, `TaskStatus = QUEUED|IN_PROGRESS|DONE|FAILED`, `InputKind = file|partial`.
- **`MergeTask`** — `jobId: string`, `taskId: string`, `inputKind: InputKind`, `level: int ≥ 0` (observability), `inputKeys: string[1..5]`, `C: int ≥ 1`.
- **`CreateJobRequest`** — `F: int ≥ 1`, `C: int ≥ 1`.
- **`CreateJobResponse`** — `jobId: string`.
- **`JobView`** — `jobId`, `status`, `F`, `C`, `submittedAt`, `percent: number 0..1`, `reductionsRemaining: int ≥ 0`, `queuePosition?: int`, `resultUrl?: string`, `error?: string`.
- **`FleetView`** — `W: int ≥ 0`, `inFlight: int ≥ 0`, `free: int`.
- **`SetWorkersRequest`** — `count: int 0..maxW`.

### A3. Constants (one source for app + infra)

`CHUNK_SIZE = 5`, `ADMISSION_FACTOR_K` (e.g. 2), `DEFAULT_W`, `MAX_W`; logical names for `JOBS`,
`READY`, `TASKS`, `FLEET` tables, the work queue + DLQ, the bucket; `FLEET_PK = "FLEET"`. `infra/`
and the Phase 2 local-init script both import these so local, cloud, and code never disagree.

### A4. Key builders (`keys.ts`)

Deterministic key construction in exactly one place (idempotency depends on this):
`inputKey(jobId, i)`, `partialKey(jobId, seq)`, `resultKey(jobId)`, `taskId(jobId, kind, idx)`,
`readySk(seq)`.

### A5. Emit JSON Schema + (recommended) generate Pydantic

`pnpm --filter shared build:schemas` runs `zod-to-json-schema` into `schemas/*.json`; the worker's
`datamodel-codegen` step turns those into Pydantic models. Wire both into `ci.yml`'s `contracts` job.

**Done when:** `pnpm --filter shared build` is clean, `schemas/*.json` is emitted, and the `contracts`
CI job is green (generated Pydantic matches, or golden payloads validate on both sides).

---

## Workstream B — `docs/api/api-contract.md`

Document every endpoint with method, path, request schema (referencing the A2 shapes), response
schema, status codes, and error cases.

| Method | Path | Request | Success | Errors |
|--------|------|---------|---------|--------|
| `POST` | `/jobs` | `CreateJobRequest` | `202 { jobId }` | `400` invalid `F`/`C` |
| `GET` | `/jobs/:id` | — | `200 JobView` | `404` unknown job |
| `GET` | `/jobs` | `?status=&limit=` | `200 JobView[]` | — |
| `DELETE` | `/jobs/:id` | — | `200` (cancelled) | `404`; `409` if not `PENDING` |
| `GET` | `/fleet` | — | `200 FleetView` | — |
| `POST` | `/workers` | `SetWorkersRequest` | `200 FleetView` | `400` out of range |

Include: the "never reject" contract (always `202`, backpressure shows as `PENDING` — ITD 6), the
progress formula (`percent = 1 − reductionsRemaining / (ceil(F/5) − 1)`), and that `resultUrl` is a
presigned S3 URL present only when `COMPLETE`.

**Done when:** every endpoint above is fully specified and cross-links the shared schema names.

---

## Workstream C — `docs/diagrams/`

Consolidated, single-glance diagrams (extracted/refined from the architecture docs so the design has
one canonical picture each):

- **`er-diagram.md`** — `Jobs`, `Ready`, `Tasks`, `Fleet` (DynamoDB attributes + keys/GSI) and the S3
  prefixes, as one `erDiagram` with relationships. Source: [database.md](../architecture/database.md).
- **`architecture.md`** — the final AWS topology: CloudFront/Next.js → API Gateway → API Lambda;
  Dispatcher Lambda + EventBridge tick; SQS work queue + DLQ; Worker Lambda (reserved concurrency W)
  via event-source mapping; DynamoDB; S3. Source: [infrastructure.md](../architecture/infrastructure.md).
- **`sequence-flow.md`** — end-to-end: submit → `PENDING` → admit → leaf tasks → **eager merge**
  (claim ≥5 / tail) → `reductionsRemaining == 0` → finalize. Source: [system-design.md](../architecture/system-design.md) + [aggregation.md](../architecture/aggregation.md).

**Done when:** all three render and match the current decisions (eager merge, reductions counter, no
level barrier, serverless-only).

---

## Phase 1 exit criteria

- [ ] `packages/shared` builds; types + zod schemas + constants + key builders exported.
- [ ] JSON Schema emitted; `contracts` CI job green (chosen parity mechanism in place).
- [ ] `docs/api/api-contract.md` fully specifies all six endpoints.
- [ ] `docs/diagrams/{er-diagram,architecture,sequence-flow}.md` render and are current.
- [ ] Cross-language contract decision recorded (and `quality-and-ci.md` updated if we chose "generate").
