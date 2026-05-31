# Distributed Mean — Interview Guide (Q&A)

A self-contained walkthrough of the system: the problem, the design, the decisions, and the
trade-offs. Written to be read top-to-bottom in ~10 minutes, or dipped into by question. Deeper
detail lives in the linked architecture docs.

---

## 1. The problem

**Q: What was the task?**

Compute the per-index mean across **F** files, each holding **C** random numbers, using a fleet of
**W** workers. Example: `F=2, C=3`, files `[1,2,3]` and `[4,5,6]` → `[2.5, 3.5, 4.5]`. The problem
states `1 < F < 100k` and `1 < C < 10k` (the API itself enforces only `F, C ≥ 1`; the upper bounds are
a workload assumption, not a hard validation), and a worker may hold **at most 5 files in memory at
once**. Workers
run at different speeds and should idle as little as possible. The required pieces are an API
(Node/Express/TS), a queue, a DB, and Python workers.

**Q: What did you build?**

A serverless, queue-driven pipeline: a Next.js operator UI, a Node/Express/TypeScript API plus a
dispatcher, a single SQS work queue, a Python worker that performs one **merge** operation, with
DynamoDB for coordination state and S3 for bulk data. It runs end-to-end locally on LocalStack and
maps 1:1 onto AWS Lambda/SQS/DynamoDB/S3.

---

## 2. The core algorithm

**Q: How do you compute a mean across so many files without loading them all?**

The mean is **decomposable**. For index `i`, `mean[i] = (Σ over all files of file[f][i]) / F`. A worker
that processes ≤5 files emits a **partial** `(sum_vector, count)` — the element-wise sum plus how many
files it summed. The final answer is `(Σ partial sum_vectors) / (Σ partial counts)`, where `Σ count`
must equal `F` (a built-in correctness check).

**Q: Why emit sums and counts instead of averaging early?**

Because averaging early mis-weights unequal chunks. `mean(mean([5,5]), mean([2]))` ≠ `mean([5,5,2])`.
Carrying `(sum, count)` keeps the operation an associative, commutative monoid, so partials can be
produced **in any order, by any number of workers, at any speed** and still combine correctly. That
single property is what makes the whole distributed design safe.

**Q: How is this only one operation and not map + reduce?**

A "leaf" task sums ≤5 *files*; a "merge" task sums ≤5 *partials*. They are the same operation over
different inputs, applied repeatedly until one partial remains. The finalize step is just the last
merge, dividing once by the validated count. No separate reduce stage, no aggregator service.

---

## 3. Splitting and distributing work

**Q: How do you split a job when F > 5?**

`numTasks = ceil(F / CHUNK_SIZE)`, `CHUNK_SIZE = 5` (the RAM ceiling, configurable). Messages carry
**S3 keys, not bytes** (SQS caps messages at 256 KB), and the worker streams inputs one at a time, so
peak memory stays small (~2 vectors) even though a task can fold many inputs.

**Q: How do workers stay busy when they run at different speeds?**

Pull-based, not push. There's no scheduler assigning chunks. Workers (Lambda invocations) are driven
by an **SQS event-source mapping**: AWS hands a message to any available worker, and a worker that
finishes early immediately pulls the next. Fast workers naturally process more — load balancing is
*emergent*, with no heartbeats, no work-stealing, no central tracker.

**Q: Is there a 1:1 job-to-queue-item relationship?**

No. One job produces `ceil(F/5)` leaf tasks plus a stream of merge tasks created dynamically as
partials accumulate. Tasks come from a per-job ready pool, not pinned to the submission.

---

## 4. Completion and the merge strategy

**Q: How does the system know a job is finished, without a level barrier?**

Reducing `N` leaf partials to one always takes exactly `N − 1` reductions, regardless of how they're
grouped. So a single per-job counter, `reductionsRemaining = ceil(F/5) − 1`, is enough: a merge of
`c` inputs does `c − 1` reductions and subtracts that; when it hits **0**, one partial remains and
that worker finalizes. No per-level counters, no coordination — just one atomic decrement.

**Q: What is "eager merge" and why not wait for each level to finish?**

Every partial joins a ready pool. A worker merges as soon as it has a **full chunk** of `CHUNK_SIZE`
(5) unclaimed partials, claiming exactly 5 (`min(available, CHUNK_SIZE)`). It does **not** wait for a
whole tree level to drain. The only time it merges fewer than 5 is the **genuine tail** — when the
ready pool already holds *every* remaining live partial (nothing else is in flight and no leaves are
left), detected by `available == reductionsRemaining + 1`. At that point waiting for a 5th partial
would deadlock, so it drains the leftover 2–4. This is deliberate: it keeps merges at the full chunk
width instead of greedily pairing partials, while still guaranteeing progress. The trade-off is that
completion can't be a per-level count, which is exactly why the single `reductionsRemaining` counter
matters.

**Q: How do two workers avoid grabbing the same partials?**

Claiming is a compare-and-swap: `ADD claimedCount :n` guarded by a condition on the current
`claimedCount`/`readyCount`. Each winner gets a disjoint `seq` range, so no partial is ever consumed
twice. Combined with idempotent task completion (below), the merge is race-free.

---

## 5. Multiple jobs, fairness, and the queue decision

**Q: How do you support multiple concurrent jobs without one starving the others?**

Every task carries its `jobId`; counters are per-job in DynamoDB and partials are namespaced per-job
in S3, so jobs are independent. Fairness is handled by **capacity-based admission**: submissions are
accepted immediately and held as `PENDING` in DynamoDB (a waiting room), and a dispatcher admits the
**oldest** pending jobs (a GSI on `status`+`submittedAt`, FIFO) while in-flight tasks are below a
target of `k·W` (`k = ADMISSION_FACTOR_K = 2`).

Two important specifics: (1) `k·W` is the gate to start **another** pending job, **not** a hard cap on
concurrent tasks — admitting a job enqueues **all** its `ceil(F/5)` leaf tasks at once and adds that
to `inFlight`, so a single large job can push `inFlight` well above `k·W` (that's fine: it means the
fleet is saturated and no further jobs are admitted until it drains). (2) Because the gate is checked
between admissions, many small jobs are admitted together to fill the fleet, while one big job is
admitted alone — admission adapts to size automatically.

**Q: Why one queue? Wouldn't multiple priority queues be better?**

This is the key trade-off. With **one SQS queue + Lambda event-source mapping**, you can't control
*which* queue a worker polls — AWS distributes across mapped queues, so multiple queues give no firm
priority guarantee and add idle, always-on machinery. We deliberately moved scheduling **up a level**
to admission: instead of prioritizing *messages*, we control *which jobs become tasks at all*. A
multi-queue/priority design would let high-priority work jump the line per-message, at the cost of
complexity and (for true priority) a poller that runs even when idle. We chose the single queue +
capacity admission: simpler, scale-to-zero, no starvation (oldest-first FIFO admission), at the cost
of fine-grained per-message priority — which this workload (long-running batch jobs, tuned for fleet
utilization, not per-job latency) does not need.

**Q: Can a submission ever be rejected?**

No — that's a hard requirement. Load shows up as `PENDING` depth, never as a rejection. The system
absorbs bursts by queueing in the DB, not by dropping work.

---

## 6. Job lifecycle

**Q: What states does a job move through?**

`GENERATING → PENDING → RUNNING → COMPLETE` (or `FAILED`), with `CANCELLED` reachable from the first
three.

- **GENERATING** — accepted (`202`), inputs being written to S3 in the background. → `FAILED` if
  generation errors.
- **PENDING** — inputs exist; waiting for admission capacity.
- **RUNNING** — admitted; leaf/merge tasks churning through the queue.
- **COMPLETE** — final merge wrote `result.csv` and the `count == F` check passed. → `FAILED` if a task
  errors or the count check fails.

**Q: Why a separate GENERATING state — isn't generation instant?**

Generation is our local stand-in for a user upload, and for large `F` it isn't free. Originally it
ran inside the submit/dispatch path, so a big job's generation blocked smaller jobs behind it. Moving
it to a background step (its own `GENERATING` state, off the dispatcher's critical path) means the
worker fleet only ever sees jobs whose inputs already exist — it never idles waiting on file creation,
and small jobs aren't stuck behind a big one's generation.

**Q: How does cancellation work mid-job?**

Soft cancel: `DELETE /jobs/:id` flips the status to `CANCELLED` via a conditional write and **keeps
the row** for history. A running job is stopped best-effort — workers re-read status and skip
finalizing/enqueuing follow-up merges (an in-flight task may finish but won't spawn more), and each
task still releases its capacity slot. There's no hard barrier, which is the right cost/benefit for
this workload.

---

## 7. Correctness under concurrency

**Q: SQS is at-least-once — how do retries not corrupt the result?**

Idempotency is enforced at task **start**, not at completion. The first thing a worker does is a
conditional `try_start` (`QUEUED|absent → IN_PROGRESS`). A redelivered message whose task is already
`DONE` short-circuits immediately and performs **no** side effects, so `reductionsRemaining` (which a
merge task decrements once, mid-processing) is never applied twice. Leaf tasks contribute `0` to that
counter; only merges of `c` partials subtract `c−1`. Partial keys are deterministic *given a reserved
ready `seq`*, but the real redelivery guard is the task-row state machine, not key-overwrite.

**Q: What happens when a task actually fails?**

The worker catches the exception, marks the task `FAILED`, sets the **job** `FAILED` immediately
(first error, fail-fast), and re-raises so SQS does not delete the message. On the redelivery that
follows, `try_start` sees the task row is already `FAILED` (not `QUEUED`/absent), short-circuits as
`ALREADY_DONE`, and the message is deleted — so a deterministically-failing task does **not** climb to
`maxReceiveCount`. The dead-letter queue therefore catches a **different** class of failure: messages
whose worker died/timed out *before* `set_failed` durably ran (crash, OOM, visibility-timeout
expiry). Those exhaust `maxReceiveCount` and land in the DLQ for inspection. (Honest scope: the DLQ is
an inspection/redrive target — there is no automated DLQ consumer yet, so a crash-before-`set_failed`
can leave a job stuck `RUNNING`; an automated handler would close that gap.)

**Q: What actually guarantees the mean is correct regardless of worker count or timing?**

Two layers. (1) Shared-state mutations are atomic: counters use `ADD` (`readyCount`,
`reductionsRemaining`, `inFlight`) and the claim is a **read + conditional CAS** (`ADD claimedCount`
guarded by the expected `claimedCount`/`readyCount`), so two workers can never claim the same `seq`
range. (2) The sum/count monoid is order-independent, so as long as each input is counted exactly once,
the answer is fixed. The claim CAS gives disjoint inputs; the start-once guard prevents double
counting. Together that *is* "each input counted once," independent of worker count or timing.

**Q: How does this behave locally vs. at scale?**

Locally, `dev-up.sh` runs **one** worker process whose poll loop fetches one message at a time
(`WORKER_MAX_MESSAGES_PER_POLL` defaults to `1`), so execution is strictly sequential and exact —
ideal for a deterministic demo. For horizontal scale there's a known window
where a claimed `seq` could be read before its `Ready` row is durable; rather than risk a silently
short sum, `claim_ready` re-reads the claimed range and **fails closed** (`ReadyPoolConsistencyError`)
if the rows don't resolve. The job fails loudly (retryable) instead of returning a wrong mean. Making
multi-worker the default would add seq-ordered publication or a transactional claim — the guard marks
that boundary.

---

## 8. Numerical accuracy

**Q: How do you keep the mean accurate across up to ~100k files (workload assumption)?**

Inputs are bounded to `[0,1]` and stored as **float32** (halves S3 cost/transfer; ~7 significant
digits is plenty for that range). Accumulation, partials, and the result are **float64**: each task
streams its ≤5 inputs one at a time into a float64 accumulator (`acc += vector`), so peak memory is
~2 vectors and we never hold a chunk in float32-summed form. Accuracy across the whole job comes from
three things: bounded magnitudes (`[0,1]`, so max sum ~`10⁵` — no overflow), float64 accumulators
everywhere it counts, and a **shallow merge tree** (each level folds ≤5, keeping rounding-error depth
low). Two documented upgrade paths if exact arithmetic is ever required: `np.sum`'s pairwise reduction
within a task, and Kahan compensated summation — both are described in the numerical-accuracy doc but
are intentionally **not** wired in today (the bounded-input error budget doesn't need them).

---

## 9. Bonus features

**Q: Is W configurable?**

Yes — `POST /workers` sets `W` on the singleton `Fleet` record in DynamoDB, which is the value
admission uses (`target = k·W`). It changes capacity/throughput only; it never rewrites in-flight job
math. In an AWS deployment this same `W` maps to the worker Lambda's **reserved concurrency**; that
wiring is target architecture (locally the knob drives admission, not an OS-level worker count). Each
job also snapshots `chunkSizeUsed` and its counters at admission, so changing `W` mid-flight can't
shift a running job's partition math — config changes apply only to jobs admitted afterward.

**Q: If a task started with `W=5` and mid-run I change to `W=10`, what exactly changes?**

Two layers:

1. **Scheduling/capacity changes immediately**: the admission threshold changes from `k·5` to `k·10`,
   so the dispatcher can admit more pending work in subsequent ticks.
2. **Task/job definition does not change**: for an already admitted/running job, `F`, `C`,
   `chunkSizeUsed`, leaf partitioning, and reduction counters stay as-is. No repartition/restart.

So the practical effect is usually **throughput/latency**, not mathematical intent. The computed mean
remains the same target quantity. With parallel floating-point reductions, tiny least-significant-digit
variation can still occur from operation ordering, but this is normal numeric behavior, not a semantic
change to the computation.

**Q: What does the UI show?**

A live dashboard (1s polling): queue depth, generating/pending/running/complete/failed/cancelled
counts, derived fleet utilization (`busy = min(W, inFlight)`, `buffered = max(0, inFlight − W)`), a
work-units completion trend, and the worker control. A per-job page shows progress, a full per-level
task breakdown (counts across every task), an input manifest, and downloads (one input, all-inputs
`.zip`, `result.csv`). There's also an interactive architecture explorer with an embedded docs viewer.

---

## 10. Infrastructure, cost, and operations

**Q: Why two stores — DynamoDB *and* S3?**

They hold different things. DynamoDB holds **coordination state**: job rows, the merge/ready/in-flight
counters, task rows. It's chosen for atomic counters (the whole completion/claim story), single-digit-ms
reads for the dashboard, and conditional writes for idempotency. S3 holds **bulk numeric data**: input
files, partial vectors, the result — cheap, durable, parallel-readable. Hard rule: vectors never go in
DynamoDB (per-KB write cost and a 400 KB item cap make it the wrong tool); DynamoDB stores *pointers
and state*, S3 stores *data*.

**Q: How does this stay cheap?**

Everything is **scale-to-zero serverless** — Lambda, SQS, DynamoDB on-demand, S3. There's no
always-on poller or VM/ECS task billing while idle; when no jobs run, compute cost is ~$0 and you pay
only for stored bytes. The dispatcher is a short Lambda invocation, not a daemon. This was a hard
design constraint, and it's why scheduling lives in *admission* rather than in an always-running
priority broker.

**Q: `inFlight` vs `W` — what's the difference, and why can `free` go negative?**

`W` is worker capacity (concurrency). `inFlight` is the count of **admitted tasks** in the pipeline
(enqueued leaves + follow-up merges not yet finished). Because a job releases all its leaves at once,
`inFlight` can exceed `W`, so raw `free = W − inFlight` can be negative — that's expected. The UI never
shows the raw value; it derives `busy = min(W, inFlight)`, `idle = max(0, W − busy)`, and
`buffered = max(0, inFlight − W)` (tasks queued beyond current capacity). As a fail-safe, reads clamp a
negative `inFlight` back to `0`.

**Q: What keeps the dispatcher running?**

It runs on a periodic tick (locally a `setInterval`; in AWS an EventBridge schedule) plus a
post-generation nudge (fired once a job finishes generating and becomes `PENDING`). So even if a
nudge is missed, the next tick re-checks capacity and admits the oldest pending job — admission is
**self-healing**, not dependent on a single trigger firing.

## 11. Trade-offs and honest limitations

**Q: What did you consciously trade away?**

- **No per-message priority** — single queue + capacity admission instead. Right for batch
  throughput; wrong if you need latency SLAs per job.
- **Progress is still modeled, not wall-clock exact** — it is now work-step based (file + tree +
  finalize) so `RUNNING` does not show 100% before completion, but it remains an operator-facing
  estimate rather than a strict per-op timer.
- **Local execution is single-worker** for exactness; true multi-worker needs the extra publication
  ordering described above (the fail-closed guard is in place today).
- **`reuseSampleFile` test mode** copies one vector to all F inputs for fast demos — production would
  always generate distinct inputs (or accept real uploads).
- **Archive download caps inputs at 500** to keep the stream bounded.

**Q: What would you harden for production?**

Multi-worker seq-ordered publication (or transactional claims) to make horizontal scale the default;
an automated DLQ consumer (redrive + mark-job-failed for poison/crash messages); per-job
metrics/alarms on DLQ depth and stuck `IN_PROGRESS` tasks; authn/authz and per-tenant isolation
(today there is none — any caller can submit/cancel any job) with scoped, short-lived presigned URLs;
S3 lifecycle cleanup of partials on `FAILED`/`CANCELLED`; and submission quotas if one tenant could
monopolize admission.

---

## Reference map

| Topic | Doc |
|-------|-----|
| Components & end-to-end flow | [architecture/system-design.md](./architecture/system-design.md) |
| Splitting & pull-based balancing | [architecture/job-splitting.md](./architecture/job-splitting.md) |
| Merge tree & completion | [architecture/aggregation.md](./architecture/aggregation.md) |
| Every status & transition | [architecture/lifecycle.md](./architecture/lifecycle.md) |
| Data model, atomicity, consistency | [architecture/database.md](./architecture/database.md) |
| Numerical accuracy | [algos/numerical-accuracy.md](./algos/numerical-accuracy.md) |
| Decision log (options + rationale) | [ITD/itd-decisions.md](./ITD/itd-decisions.md) |
| API contract | [api/api-contract.md](./api/api-contract.md) |
