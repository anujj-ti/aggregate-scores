# Distributed Mean — Architecture

> Compute the per-index mean across **F** files (each with **C** random numbers) using a
> fleet of **W** workers, where each worker can hold at most **5 files** in memory at a time.

This folder is the **design-first** layer of the project. We agree on the design here
**before** writing any service code. Each numbered doc drills into one concern.

| Doc | Topic |
|-----|-------|
| [system-design.md](./system-design.md) | Components, data flow, end-to-end sequence |
| [job-splitting.md](./job-splitting.md) | How a job becomes queue tasks; pull-based load balancing |
| [aggregation.md](./aggregation.md) | The merge tree (one operation) + completion detection |
| [lifecycle.md](./lifecycle.md) | Every job & task **status**, what triggers each transition, how progress is reported |
| [database.md](./database.md) | DynamoDB tables, keys, GSIs, access patterns; S3 layout; message schemas |
| [infrastructure.md](./infrastructure.md) | AWS CDK stacks and service mapping (Lambda/SQS/DynamoDB/S3) |
| [quality-and-ci.md](./quality-and-ci.md) | Type/lint/format gates, Pydantic/zod, CI/CD |

---

## The key insight (why the design looks the way it does)

The per-index mean is **decomposable**. For the value at index `i`:

```
mean[i] = (sum over all F files of file[f][i]) / F
```

A worker that processes a chunk of ≤5 files emits a **partial** of the form
`(sum_vector, count)` — the element-wise sum across its files, plus how many files it summed.
The final result is just:

```
final[i] = (Σ of every partial sum_vector at index i) / (Σ of every partial count)
```

where `Σ count` must equal `F` (a built-in correctness check). Workers emit **sums, never
averages** — averaging early would mis-weight unequal chunks (e.g. `[5, 5, 2]`).

Because addition is associative and commutative, partial work can be produced in **any order**,
by **any number of workers**, at **any speed**, and still combine into the correct answer.
This single fact drives every decision below:

- **Splitting** → cut F into `ceil(F / 5)` chunks of ≤5 files each (respects the RAM limit).
- **One operation: merge** → every task combines ≤5 partials into one, applied repeatedly until a
  single partial remains (ITD 3). No separate map/reduce.
- **Eager merging (no level barrier)** → produced partials join a ready pool; the moment ≥5 are
  ready (or the tail of 2–4), a worker claims them and queues a merge — workers never wait for a
  whole "level" to finish (ITD 10).
- **Load balancing** → workers **pull** tasks off one SQS queue via a Lambda event-source mapping
  (no always-on poller, ITD 5/7). A fast worker simply pulls more; no central scheduler.
- **Completion** → one grouping-free counter `reductionsRemaining = ceil(F/5) − 1`; each c-input
  merge subtracts `c − 1`, and reaching 0 means one partial is left → finalize (divide once by the
  validated count).
- **Admission** → submissions are never rejected (accepted as `PENDING`); a dispatcher releases
  jobs into the queue by capacity (~`k·W` in-flight tasks) so started jobs finish fast (ITD 6).

---

## Parts of the system (monorepo, not multiple git repos)

This is **one repository** with **3 deployable services** and **2 supporting packages**:

```text
aggregate-scores/
├── docs/
│   ├── architecture/    # design docs (this folder)
│   ├── ITD/             # initial technical decisions
│   └── algos/           # algorithm deep-dives (e.g. numerical accuracy)
├── apps/
│   ├── web/             # [deployable] Next.js frontend — submit jobs + live dashboard
│   ├── api/             # [deployable] Node + Express + TypeScript API
│   └── worker/          # [deployable] Python worker — merge in one image
├── packages/
│   └── shared/          # [support] shared message/contract types
└── infra/               # [support] AWS CDK (SQS, DynamoDB, S3, Lambda, API Gateway)
```

**3 deployables:** `web`, `api`, and `worker`.

The **aggregator is not a separate service** — there is only one **merge** operation (ITD 3). The
same Python image runs every task (combine ≤5 inputs → one partial); the task that finds one
partial left simply divides once and writes the result. Language split is fixed by the task:
**API in Node/Express/TS, workers in Python.** The `api` deployable also hosts the **dispatcher**
Lambda (admission, ITD 6).

---

## Decisions taken (open for your feedback)

These are defaults chosen to keep the system simple. Flag any you disagree with.

The full decision log with options and trade-offs is in [`../ITD/itd-decisions.md`](../ITD/itd-decisions.md).
This table is a quick index of the defaults.

| # | Decision | Default | Alternative |
|---|----------|---------|-------------|
| D1 | Monorepo tooling | **pnpm workspaces + Turborepo** | Nx, plain npm workspaces |
| D2 | Compute operation | **One `merge`** (≤5 inputs → 1 partial), recursive tree; finalize is the last merge (ITD 3) | Separate map + reduce stages |
| D3 | API runtime | **Lambda + API Gateway** | ECS Fargate (banned, ITD 7) |
| D4 | Work queue | **One SQS queue** consumed by Lambda event-source mapping; merge tasks re-queue onto it (ITD 5) | Priority lanes + poller / per-level queues |
| D5 | State store | **DynamoDB** — reductions + ready-pool counters, `InFlight`, PENDING waiting room (never vectors) | Postgres/RDS |
| D6 | File + intermediate storage | **S3** for inputs, partials, result | DynamoDB (costly per-KB) |
| D7 | Live UI updates | **Polling `/status`** | WebSocket API Gateway upgrade |
| D8 | Worker compute lib | **NumPy**, pairwise summation | Pure-Python loops |
| D9 | Mean algorithm | **`(sum_vector, count)` partials, divide once** by validated count (ITD 2) | Welford / running mean |
| D10 | Quality gates | **strict mypy + ruff + black (Pydantic) / strict tsc + ESLint + Prettier (zod), in CI** | looser/no gates |
| D11 | Range + dtype | values in **`[0, 1]`**; **inputs float32**, **accumulate/partials/result float64** | float64 everywhere (2× storage) |
| D12 | Worker runtime | **Lambda** (container image) via **SQS event-source mapping**, reserved concurrency = `W` | ECS Fargate fleet (banned, ITD 7) |
| D13 | Job admission | **Capacity-based** — accept all as PENDING, dispatcher releases while in-flight `< k·W` (ITD 6) | Flood (all at once) / fixed job-count batch |
| D14 | Compute substrate | **Serverless only** — Lambda + pay-per-use stores; nothing always-on (ITD 7) | Always-on ECS/Fargate/poller |
| D15 | Merge scheduling + completion | **Eager merge** (claim ≥5 ready partials, no level barrier) + one `reductionsRemaining` counter (ITD 10) | Level-synchronized merge / S3 polling |

See each doc for the reasoning behind these. The numerical rationale is in
[aggregation.md](./aggregation.md) and [`../algos/numerical-accuracy.md`](../algos/numerical-accuracy.md).
