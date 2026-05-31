# Job & Task Lifecycle (Statuses)

This doc is the single source of truth for **every status in the system** — what each one means,
**what triggers each transition**, **who writes it**, and **how progress is reported** to the UI.

There are two independent state machines:

- **Job status** — the lifecycle of a whole submission (`Jobs.status` in DynamoDB).
- **Task status** — the lifecycle of one ≤5-input merge task (`Tasks.status` in DynamoDB).

A job is made of many tasks (leaf + merge) merged eagerly into one result. Job status answers
*"where is this submission overall?"*; task status answers *"where is this one unit of work?"*.
Keeping them separate is what lets the API show a job as `RUNNING` while its individual tasks churn
through `QUEUED → IN_PROGRESS → DONE`.

---

## Job status

| Status | Meaning | Stored where |
|--------|---------|--------------|
| `GENERATING` | Accepted and durably stored, but its input files do not exist yet — they are being **materialized to S3 in the background** (the local stand-in for a user upload). The dispatcher never sees this job, so generation never blocks the fleet. | `Jobs.status` |
| `PENDING` | Inputs exist in S3; the job is now **waiting in the admission room** with no tasks enqueued yet. Submissions are **never rejected**, so backpressure shows up here (ITD 6). | `Jobs.status` + a `status`/`submittedAt` GSI the dispatcher scans oldest-first |
| `RUNNING` | **Admitted** by the dispatcher; leaf tasks are on the queue. The job stays `RUNNING` for its whole life — admission happens once, then merge tasks are queued eagerly as partials accumulate. | `Jobs.status` |
| `COMPLETE` | The final merge produced `result.csv` and the count check (`Σcount == F`) passed. Terminal. | `Jobs.status` + `Jobs.resultKey` |
| `FAILED` | A task exhausted its retries (landed in the DLQ) **or** the final integrity check failed. Terminal. | `Jobs.status` + `Jobs.error` |
| `CANCELLED` | An operator cancelled the job while it was `GENERATING`, `PENDING`, or `RUNNING`. The job row is **kept** (soft cancel, not deleted) so history and diagnostics stay visible. Terminal. | `Jobs.status` |

There is deliberately **no** `REDUCING` or `AGGREGATING` status: there is no separate reduce stage
(ITD 3) — finalize is just the last merge task, so the job is `RUNNING` right up to `COMPLETE`.

**Cancellation is a soft delete.** `DELETE /jobs/:id` does not remove the record; it transitions
`GENERATING|PENDING|RUNNING → CANCELLED` via a conditional write. Already-terminal jobs
(`COMPLETE|FAILED|CANCELLED`) return `409`. A `RUNNING` job may have in-flight tasks: the worker
re-reads job status and, if `CANCELLED`, stops producing the result and skips enqueuing follow-up
merges (a task already executing may finish, but it will not finalize or spawn more work), and it
still releases its in-flight slot. This is best-effort cancellation without a hard barrier.

### Job state machine

```mermaid
stateDiagram-v2
    [*] --> GENERATING: POST /jobs accepted (202); input generation kicked off in background
    GENERATING --> PENDING: all F input files written to S3
    GENERATING --> FAILED: input generation errors
    PENDING --> RUNNING: dispatcher admits (in-flight < k*W), leaf tasks enqueued
    RUNNING --> RUNNING: >=5 partials ready (or tail) -> claim + enqueue a merge task
    RUNNING --> COMPLETE: reductionsRemaining hits 0, result.csv written, count == F
    RUNNING --> FAILED: a task hits the DLQ, or finalize count check fails
    GENERATING --> CANCELLED: operator DELETE /jobs/:id (before inputs ready)
    PENDING --> CANCELLED: operator DELETE /jobs/:id (never admitted)
    RUNNING --> CANCELLED: operator DELETE /jobs/:id (best-effort stop)
    COMPLETE --> [*]
    FAILED --> [*]
    CANCELLED --> [*]
```

### Job transitions in detail

| From → To | Trigger | Who writes it | Side effects |
|-----------|---------|---------------|--------------|
| `(none)` → `GENERATING` | `POST /jobs {F,C,reuseSampleFile?}` | **API** | Write `Jobs` item (`status=GENERATING`, `submittedAt`, `reuseSampleFile`); return `202 Accepted`; kick off background input generation |
| `GENERATING` → `PENDING` | Background generation finishes writing all F input files to S3 | **API** (submit path) | Conditional `SET status=PENDING`; ping dispatcher. Generation runs off the request/dispatcher critical path |
| `GENERATING` → `FAILED` | Input generation throws | **API** (submit path) | Set `error`; job never reaches the queue |
| `PENDING` → `RUNNING` | Dispatcher sees `inFlight < k·W` and this is the oldest PENDING job | **Dispatcher** | Snapshot `chunkSizeUsed` for this job, compute `leafTasksTotal = ceil(F/chunkSizeUsed)` and `reductionsRemaining = leafTasksTotal - 1`, enqueue leaf tasks, `ADD inFlight +<numTasks>` |
| `RUNNING` → `RUNNING` | A task produces a partial and the ready pool has ≥5 (or the tail) | **Worker** (that wins the conditional claim) | Claim ≤5 ready partials; enqueue one merge task; `ADD inFlight +1` |
| `RUNNING` → `COMPLETE` | A merge drives `reductionsRemaining` to **0** (one partial left) | **Worker** (finalize) | `result.csv = sum_vector / count` (assert `count == F`); set `resultKey`; `ADD inFlight -…`; ping dispatcher (capacity freed) |
| `RUNNING` → `FAILED` | A task exceeds `maxReceiveCount` (→ DLQ) or finalize count check fails | **Worker / DLQ handler** | Set `error`; release in-flight capacity; ping dispatcher |
| `GENERATING` → `CANCELLED` | Operator `DELETE /jobs/:id` before inputs are ready | **API** (conditional write) | Set `status=CANCELLED`; row kept; the generation completion write (`→ PENDING`) is conditional on `GENERATING`, so it no-ops |
| `PENDING` → `CANCELLED` | Operator `DELETE /jobs/:id` on a not-yet-admitted job | **API** (conditional write) | Set `status=CANCELLED`; row kept; dispatcher will skip it (only admits `PENDING`) |
| `RUNNING` → `CANCELLED` | Operator `DELETE /jobs/:id` on an admitted job | **API** (conditional write) | Set `status=CANCELLED`; workers stop finalizing / enqueuing follow-ups for this job; in-flight tasks drain and release their slots |

> **Why `PENDING` is a job status and not "in a queue":** a PENDING job has **no SQS messages** —
> it lives only in DynamoDB. Putting un-admitted work on the queue is what we are avoiding; the
> queue holds only *admitted* tasks, so the dispatcher controls load by choosing when to move a job
> from `PENDING` to `RUNNING` (ITD 5/6).

---

## Task status

A task is one merge of ≤5 inputs (a leaf over files, or a merge over partials). Its status is for
**observability and idempotency**, not for correctness of completion (that is the `reductionsRemaining`
counter, see [aggregation.md](./aggregation.md)).

| Status | Meaning | Set by |
|--------|---------|--------|
| `QUEUED` | Message is on the SQS work queue, not yet picked up. | Dispatcher (leaf) or worker (merge) at enqueue |
| `IN_PROGRESS` | An SQS event-source invocation is currently processing it (message invisible for `visibilityTimeout`). | Worker, on receive |
| `DONE` | Partial written to S3; `reductionsRemaining` was decremented **exactly once** on this transition. | Worker, on success |
| `FAILED` | Exhausted retries and routed to the DLQ. | Worker / redrive policy |

### Task state machine

```mermaid
stateDiagram-v2
    [*] --> QUEUED: enqueued (leaf by dispatcher, or merge by a worker claim)
    QUEUED --> IN_PROGRESS: SQS event source invokes a worker
    IN_PROGRESS --> DONE: partial written, reductionsRemaining -(c-1) (first time only)
    IN_PROGRESS --> QUEUED: invocation errors/timeouts → message reappears (retry)
    QUEUED --> FAILED: maxReceiveCount exceeded → DLQ
    DONE --> [*]
```

### Idempotency (why redelivery is safe)

SQS is at-least-once, so a task can be delivered more than once. `reductionsRemaining` is decremented
**only on the first `IN_PROGRESS → DONE` transition** (guarded by the `Tasks` row): a redelivered
task re-writes the same partial to the same deterministic S3 key and does **not** decrement again.
Claiming is likewise safe — the conditional `ADD claimedCount` gives each claimer a disjoint range,
so no two merge tasks ever consume the same partial.

---

## How job status relates to the queue, counters, and capacity

```mermaid
flowchart LR
    subgraph DynamoDB
        PJ["PENDING jobs (waiting room)"]
        RP["ready pool (readyCount/claimedCount)"]
        RR["reductionsRemaining"]
        IF["inFlight counter"]
    end
    PJ -->|dispatcher: inFlight < k*W| Q[[SQS work queue]]
    Q -->|worker picks up| WK[Worker]
    WK -->|partial produced: readyCount +1| RP
    RP -->|">=5 ready (or tail): claim <=5, enqueue merge"| Q
    WK -->|merge done: -(c-1)| RR
    RR -->|hits 0: one partial left| DONE[result.csv → job COMPLETE]
    WK -->|+1 on enqueue / -1 on done| IF
    IF -->|frees capacity| PJ
```

- **`PENDING` jobs** never touch the queue; they are released by capacity.
- **`inFlight`** (in-flight task count) is the admission signal: the dispatcher keeps it near `k·W`.
- The **ready pool** drives intra-job progression (every 5 ready partials spawn a merge), and
  **`reductionsRemaining`** detects the end (one partial left).
- `W` can change mid-flight (capacity only), but each job's `chunkSizeUsed` snapshot is immutable,
  so in-flight partition math and counters never shift during redeploy/config changes.

---

## Progress reporting (`GET /jobs/:id`)

The API derives a human-readable progress view from the same state, no extra bookkeeping:

| Field | Source | Example |
|-------|--------|---------|
| `status` | `Jobs.status` | `RUNNING` |
| `reuseSampleFile` | `Jobs.reuseSampleFile` — whether inputs were one shared vector copied F times (test mode) or F distinct vectors | `true` |
| `queuePosition` | rank among `PENDING` jobs by `submittedAt` (only while `PENDING`) | `3rd in line` |
| `percent` | work-step progress: `(file steps + tree steps done) / (file steps + tree steps + finalize)` (forced to `1` when `COMPLETE`) | `~62%` |
| `reductionsRemaining` | `Jobs.reductionsRemaining` (raw merges still to do) | `8000` |
| `resultUrl` | `Jobs.resultKey` (presigned) once `COMPLETE` | — |
| `chunkSizeUsed` / `leafTasksTotal` / `leafTasksDone` | `Jobs.*` snapshot counters | `5 / 3 / 2` |
| `readyCount` / `claimedCount` | `Jobs.*` ready-pool counters | `7 / 5` |
| `taskSummary` | aggregated counts from a `Tasks` query, including a per-`level` breakdown (`byLevel`) | `{ done: 4, byLevel: [...] }` |
| `taskDetails` | per-task lineage from `Tasks` (taskId, kind, level, status, inputKeys, partialKey) — bounded by a server limit, with `taskDetailsTruncated`/`taskDetailsLimit` flags | for the job-detail processing map |
| `inputManifestPreview` | derived (not stored): first N `fileIndex → inputKey → plannedLeafTaskId` rows so the operator can verify which inputs feed which leaf | first 25 files |

The list endpoint (`GET /jobs`) omits `taskSummary`/`taskDetails` (one `Tasks` query per job is too
expensive for a list); the single-job endpoint (`GET /jobs/:id`) includes them for the detail view.

`percent` reports **work-step progress**, not leaf-only progress. The numerator estimates completed
file-read steps plus completed tree steps; the denominator is planned file steps + tree steps + one
finalize step. This prevents `RUNNING` jobs from showing `100%` while final merge/finalize work is still
in flight. `reductionsRemaining` is still surfaced as the exact, grouping-independent merge completion
signal: it starts at `ceil(F/chunkSizeUsed)-1` and counts monotonically down to `0`. The UI polls this
endpoint (ITD 13 polling), so no always-on push channel is needed (ITD 7).

### Worked example — `F = 30, W = 5` (eager, no level barrier)

`ceil(30/5) = 6` leaf partials ⇒ `leafTasksTotal = 6`, `reductionsRemaining` starts at `5`.

| Time | Job status | Ready pool / counters | What the UI shows (`percent` = work-step progress) |
|------|-----------|-----------------------|-------------------|
| generating | `GENERATING` | inputs being written to S3 | `GENERATING · 0%` |
| submit done | `PENDING` | nothing queued; waiting room | `PENDING · 1st in line · 0%` |
| admitted | `RUNNING` | 6 leaf tasks `QUEUED`; `reductionsRemaining=5` | `RUNNING · 0%` (0/6 leaves) |
| 5 leaves done | `RUNNING` | ready pool = 5 → claim 5, enqueue merge(5); 6th leaf still running | `RUNNING · ~83%` (5/6 leaves) |
| 6th leaf + merge(5) done | `RUNNING` | all leaves done (`leafTasksDone=6`); `reductionsRemaining → 1`; 2 ready → merge(2) | `RUNNING · <100%, 1 reduction left` |
| merge(2) done | `COMPLETE` | `reductionsRemaining → 0`; `result.csv` written, `count==30` ✓ | `COMPLETE · download` |

Note the 6th leaf and `merge(5)` run **concurrently** — no waiting for a level to drain. With work-step
progress, the bar stays below 100% until final merge/finalize work is done; `reductionsRemaining`
remains the exact merge-side completion signal.

### Edge case — `F ≤ 5`

The job has one leaf task and `reductionsRemaining = 0` from the start, so that single leaf partial
*is* the result — it finalizes directly (divide by the count, no merge). The dispatcher still admits
**up to `k·W`** such tiny jobs together so the fleet is not left idle on one trivial task (ITD 6).
