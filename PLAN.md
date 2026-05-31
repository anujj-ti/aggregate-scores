# Build Plan

The **what to do and how to do it** for turning the design in [`docs/`](./docs) into a running
system. The architecture is already decided (see [`docs/architecture`](./docs/architecture) and the
[ITDs](./docs/ITD/itd-decisions.md)); this file is the execution order, with concrete tooling and a
"done when" bar for each step. Work top-to-bottom — later phases assume the earlier ones are green.

> Ground rules that apply to **every** phase (ITD 7, quality gates):
> - **Serverless only** — Lambda + pay-per-use stores. Nothing always-on (no ECS/Fargate/EC2/poller).
> - **Strict types + validation** — `mypy --strict` + **Pydantic** (Python), `tsc --strict` + **zod**
>   (TS). No `Any`/`any`. Structured data is always a model, never a loose `dict`/`tuple`.
> - **Nothing merges red** — ruff, black, ESLint, Prettier, and tests run in `ci.yml` and block merge.
> - Every AWS resource is tagged `Owner=Anuj Jadhav`, `Project=learning`, `CanDeleteSafely=true`.

---

## Target repository layout

```text
aggregate-scores/
├── apps/
│   ├── web/                # Next.js + TS — submit jobs, live dashboard, set W (bonus)
│   ├── api/                # Node + Express + TS — API handlers + Dispatcher Lambda
│   └── worker/             # Python (Lambda) — the eager-merge engine
├── packages/
│   └── shared/             # zod schemas + TS types (+ JSON Schema export); mirrored Pydantic models; constants
├── infra/                  # AWS CDK (TS) — storage / queue / api / dispatcher / worker / web stacks
├── docs/
│   ├── architecture/       # (exists) prose design
│   ├── ITD/                # (exists) decisions
│   ├── algos/              # (exists) numerical accuracy
│   ├── diagrams/           # NEW — single-glance ER + final architecture + end-to-end sequence
│   └── api/                # NEW — REST API contract reference
├── scripts/                # deploy.sh, destroy.sh
├── .github/workflows/ci.yml
├── PLAN.md                 # this file
└── TASK.md
```

> **Folder note (diagrams vs contract).** Visual artifacts go in `docs/diagrams/`; the REST surface
> goes in `docs/api/`. Both are *derived from* the architecture docs and from `packages/shared`
> (the real source of truth for message/DTO shapes), so they stay in sync rather than drifting.

---

## Phase 0 — Repo & tooling foundation

**Goal:** an empty-but-strict monorepo where the *first* line of code already passes every gate.

- [ ] Scaffold the monorepo: **pnpm workspaces + Turborepo** (D1); create the `apps/*`, `packages/shared`, `infra` workspaces.
- [ ] Python tooling in `apps/worker`: **uv** for env/deps; configure **ruff**, **black**, **mypy --strict**, **pytest** in `pyproject.toml`.
- [ ] TS tooling (root + each TS package): **tsc** `strict`/`noEmit`, **ESLint** (`@typescript-eslint`, `no-explicit-any: error`), **Prettier**, **vitest**.
- [ ] Pre-commit hook (lefthook/Husky + `pre-commit`) running the fast local gate (ruff/black/mypy · prettier/eslint/tsc).
- [ ] **`.github/workflows/ci.yml`** with the parallel jobs from [quality-and-ci.md](./docs/architecture/quality-and-ci.md):
      `python-quality`, `ts-quality`, `contracts` (zod-vs-Pydantic parity).

**How:** `pnpm dlx create-turbo`; `uv init apps/worker`; commit the config files (`pyproject.toml`,
`tsconfig.base.json`, `.eslintrc`, `.prettierrc`, `ci.yml`) before any feature code.

**Done when:** an empty PR runs CI and every job is green; pre-commit blocks a deliberately bad file.

---

## Phase 1 — Contracts & diagrams (lock the interfaces before coding)

**Goal:** freeze the shapes everyone codes against, and produce the reference diagrams.

- [ ] `docs/diagrams/er-diagram.md` — the data model: `Jobs`, `Ready`, `Tasks`, `Fleet` (DynamoDB) + S3 prefixes, as a single `erDiagram` (consolidated from [database.md](./docs/architecture/database.md)).
- [ ] `docs/diagrams/architecture.md` — the **final** AWS architecture: API GW → API Lambda, Dispatcher (EventBridge tick), SQS + DLQ, Worker Lambda (reserved concurrency = W), DynamoDB, S3, CloudFront/Next.js.
- [ ] `docs/diagrams/sequence-flow.md` — end-to-end: submit → PENDING → admit → leaf tasks → **eager merge** (claim ≥5 / tail) → `reductionsRemaining == 0` → finalize.
- [ ] `docs/api/api-contract.md` — the REST surface (table below), each with request/response and status codes.
- [ ] `packages/shared` contracts (the real source of truth):
  - [ ] `MergeTask` (jobId, taskId, inputKind, **level**, inputKeys, C), `JobStatus`, `TaskStatus`, `InputKind` — as **zod** schemas + `z.infer` types, with a JSON-Schema export.
  - [ ] API DTOs: `CreateJobRequest`, `JobView` (status, percent, reductionsRemaining, queuePosition?, resultUrl?), `FleetView`.
  - [ ] Mirrored **Pydantic** models for the worker.
  - [ ] **Constants:** table names, queue/DLQ names, bucket name, `CHUNK_SIZE = 5`, admission factor `k`, default `W`.

**API contract (first cut):**

| Method | Path | Body / Query | Returns |
|--------|------|--------------|---------|
| `POST` | `/jobs` | `{ F, C }` | `202 { jobId }` (accepted as `PENDING`, never rejected — ITD 6) |
| `GET` | `/jobs/:id` | — | `{ status, percent, reductionsRemaining, queuePosition?, resultUrl? }` |
| `GET` | `/jobs` | `?status` | list of `JobView` |
| `DELETE` | `/jobs/:id` | — | cancel a `PENDING` job (only while pending) |
| `GET` | `/fleet` | — | `{ W, inFlight, free }` |
| `POST` | `/workers` | `{ count }` | set `W` via `PutFunctionConcurrency` (bonus) |

**Done when:** `packages/shared` builds, the `contracts` CI job passes (zod and Pydantic agree on the
example messages), and the three diagrams render.

---

## Phase 2 — Local dev environment (test-first)

**Goal:** be able to run the whole backend **on a laptop** and drive it with `curl` before any AWS
or UI exists. Everything after this is built and debugged against this loop, so we can see logic
work (or break) immediately.

- [ ] `docker-compose.yml` bringing up **LocalStack** (S3 + SQS + DynamoDB + Lambda) — one local AWS surface.
- [ ] `scripts/dev-up.sh` — start compose, then run an **init script** that creates the bucket, the SQS queue + DLQ, and the `Jobs`/`Ready`/`Tasks`/`Fleet` tables **from `packages/shared` constants** (so local resources match the CDK ones exactly).
- [ ] Run the **worker** locally as a loop against the LocalStack queue (the *same* container image we deploy), and the **API** locally — endpoints switched via `AWS_ENDPOINT_URL`.
- [ ] Debug helpers (so we can "begus and fix"): `scripts/seed-job.sh F C` (curl `POST /jobs`), `scripts/dump-state.sh <jobId>` (print the `Jobs` row, ready pool, tasks, and S3 keys), `scripts/tail-worker.sh` (stream worker logs).

**How:** `awscli-local`/`cdklocal` or a small Python/TS init using the shared constants. One env file
flips every component between LocalStack and real AWS.

**Done when:** `dev-up.sh` boots the stack and `curl localhost:.../jobs` works end-to-end **locally**
(even against a stub handler) — the harness is ready before the real logic lands.

---

## Phase 3 — Worker (Python) — the eager-merge engine

**Goal:** the core compute. Highest-risk phase; build and test it hard, **locally**, against Phase 2.

- [ ] Message handling: parse the SQS record into the **Pydantic** `MergeTask`; reject malformed messages.
- [ ] Merge: **stream** the ≤5 inputs one at a time from S3 (files for a leaf, partials for a merge) — fold each into the **float64** accumulator and release it (peak ~2×C) — with NumPy pairwise summation, write one `(sum_vector, count)` partial (ITD 2/4, [aggregation.md](./docs/architecture/aggregation.md)).
- [ ] Register the partial: `ADD readyCount +1` → `seq`; write the `Ready` row (`seq`, `partialKey`, `count`, `level`).
- [ ] **Completion counter:** `ADD reductionsRemaining -(c-1)`; if it hits **0**, finalize — divide by the accumulated count, assert `count == F` (raise `JobIntegrityError` otherwise), write `result.csv`, set job `COMPLETE`.
- [ ] **Eager claim:** while available (`readyCount - claimedCount`) `>= 5`, or (all leaves produced and) `>= 2` for the tail — conditional `ADD claimedCount n` (no overlap), then enqueue **one** merge task for the claimed keys with `level = max(input levels) + 1`.
- [ ] **Idempotency:** decrement/claim only on a task's first `→ DONE` (guarded by the `Tasks` row); redelivery rewrites the same deterministic S3 key and does not double-count.

**Tests (pytest):** mean correctness vs a brute-force `np.mean`; the `[5,5,2]` weighting pitfall;
`F ≤ 5` finalizes at the single leaf; the reductions counter reaches 0 exactly once; a simulated
double-delivery does not double-count; concurrent claims never overlap.

**Done when:** unit tests green **and** dropping a hand-made task onto the local queue produces the
correct partial in LocalStack S3 (verified with `dump-state.sh`).

---

## Phase 4 — API + Dispatcher (the curl-testable loop)

**Goal:** wire the public surface and admission so the **full local loop runs from a `curl`** —
submit → admit → leaf tasks → eager merge → result. This is the milestone where we can really test.

**API (Node + Express + TS):**

- [ ] `POST /jobs` — validate with **zod**, generate `F` input files to S3 (float32), write `Jobs` row `PENDING` + `submittedAt`, ping the dispatcher, return `202 { jobId }`.
- [ ] `GET /jobs/:id` — derive progress from `reductionsRemaining` (`percent = 1 - reductionsRemaining / (ceil(F/5)-1)`), include `queuePosition` while `PENDING`, presigned `resultUrl` once `COMPLETE`.
- [ ] `GET /jobs`, `DELETE /jobs/:id` (cancel while `PENDING`), `GET /fleet`, `POST /workers` (set W).

**Dispatcher (admission, ITD 6):**

- [ ] Query oldest `PENDING` jobs via the GSI; while `inFlight < k·W`, admit: enqueue `ceil(F/5)` leaf tasks, set `leafTasksTotal` + `reductionsRemaining = ceil(F/5) - 1`, `ADD inFlight +n`, set job `RUNNING`.
- [ ] Triggers: on submit, on job completion, and a (locally, a timer) **EventBridge** tick so a draining queue is always topped up.
- [ ] Both API and Dispatcher live in `apps/api`, packaged as Lambda handlers; run locally in Phase 2's loop.

**Tests:** vitest for schema/status/cancel; admission tests — many tiny jobs fill the fleet together,
one large job runs alone, nothing is ever rejected.

**Done when:** `curl POST /jobs {F,C}` on the local stack runs to completion and `GET /jobs/:id`
reports `COMPLETE` with a downloadable result whose mean matches `np.mean` — **no UI involved**.

---

## Phase 5 — Infrastructure (AWS CDK) + real deploy

**Goal:** the same system the local loop proved, now defined as code and deployed to AWS.

- [ ] CDK stacks per [infrastructure.md](./docs/architecture/infrastructure.md):
  - [ ] `storage-stack` — S3 bucket; DynamoDB `Jobs` (+ GSI `status`/`submittedAt`), `Ready`, `Tasks`, `Fleet` item.
  - [ ] `queue-stack` — SQS work queue + DLQ + redrive policy.
  - [ ] `api-stack` — API Lambda + API Gateway; exec role → S3/DDB + `lambda:PutFunctionConcurrency`.
  - [ ] `dispatcher-stack` — Dispatcher Lambda + **EventBridge** tick; on-submit + on-complete triggers.
  - [ ] `worker-stack` — Worker Lambda (container image) + **SQS event-source mapping**, `reservedConcurrency = W`.
  - [ ] `web-stack` — S3 + CloudFront for the Next.js build (filled in Phase 6).
- [ ] Apply the mandatory **tags** to every resource (`Owner=Anuj Jadhav`, `Project=learning`, `CanDeleteSafely=true`).
- [ ] `scripts/deploy.sh` and `scripts/destroy.sh` (cdk deploy/destroy, all stacks).

**How:** `infra/` imports names/constants from `packages/shared` — the same ones Phase 2's init used —
so local and cloud stay identical.

**Done when:** `deploy.sh` stands the stack up in a sandbox account, the Phase-4 curl flow passes
against AWS, and `destroy.sh` tears it down clean.

---

## Phase 6 — Frontend (Next.js) — **last**

**Goal:** a UI on top of the already-proven API. Built last on purpose — the backend is fully
testable by curl without it.

- [ ] Submit form (`F`, `C`); jobs list with status; job detail with **polling** progress (ITD 13) and result download.
- [ ] Fleet panel (`W`, in-flight, free) and the bonus "set W" control.

**Done when:** a user can submit a job and watch it go `PENDING → RUNNING → COMPLETE` and download the result.

---

## Phase 7 — End-to-end & teardown

- [ ] One scripted end-to-end test (submit → poll → assert mean) run against **both** LocalStack and AWS.
- [ ] Verify `destroy.sh` leaves no billable resources.

**Done when:** the E2E test passes locally and on AWS, and teardown is clean.

---

## Quality gates & CI (enforced throughout)

`.github/workflows/ci.yml` — merge blocked unless all green (see [quality-and-ci.md](./docs/architecture/quality-and-ci.md)):

```text
job: python-quality   # uv sync → ruff check → black --check → mypy --strict → pytest
job: ts-quality       # pnpm i → tsc --noEmit → eslint → prettier --check → vitest
job: contracts        # validate example messages against zod AND pydantic (fail on disagreement)
```

Deploy (CDK) is a **separate** tagged/manual workflow, not part of the PR gate.

---

## Suggested order of attack

Backend-first, UI last, every step testable locally:

`P0 (tooling) → P1 (contracts) → P2 (local dev env) → P3 (worker) → P4 (API + dispatcher)` is the
critical path. By the end of **P4 the whole system is curl-testable on a laptop** — that's the point
we can really debug the logic. **P5** deploys the proven system to AWS; **P6 (frontend) is built
last** on top of the already-working API. The local dev env (P2) exists *before* the worker so every
later phase is debuggable from the first line of code.
