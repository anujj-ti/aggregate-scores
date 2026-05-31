# Distributed Mean - Initial Technical Decisions

Technical decisions for the distributed-mean system. Each ITD states the decision, the options
weighed, and the tradeoffs accepted, so a reader can understand *why* without reading the code.
Full design context lives in `../architecture/`.

## Workload assumptions & objective

These are **long-running batch computations**, not interactive requests - a large job sums ~200k
files over ~8 merge levels, i.e. minutes of work. The system is tuned for **fleet utilization, not
per-job latency**: the goal is to **keep the W workers busy and get every submitted job done**, not
to minimize any single job's wall-clock or offer per-job latency SLAs.

A useful test for the queue/scheduling decisions: *"how important is the latency of an individual
job?"* Our answer is *"we only care about keeping workers busy and finishing jobs"* - so **priority
scheduling is an explicit non-goal**. This is precisely why ITD 5 uses one queue with no priority
lanes and ITD 6 admits purely by capacity (fill the fleet) rather than by any per-job deadline. If a
per-job latency SLA is ever introduced, ITD 5 and ITD 6 are the decisions to revisit.

| # | Decision |
| :---- | :---- |
| ITD 1 | Binary `.npy` for bulk data (float32 inputs, float64 partials), CSV for the result |
| ITD 2 | Compute the mean as `(sum, count)` partials in float64; divide once at the end |
| ITD 3 | One operation - `merge` - applied recursively until a single partial remains |
| ITD 4 | Hard cap of <=5 inputs per task; speed comes from fleet width, not single-worker streaming |
| ITD 5 | Single SQS work queue, consumed by Lambda event-source mapping (no priority lanes, no poller) |
| ITD 6 | Capacity-based job admission via a dispatcher; submissions are never rejected |
| ITD 7 | Serverless-only compute - Lambda + pay-per-use stores; no always-on services |
| ITD 8 | Monorepo with 3 deployables (web/api/worker); API in TypeScript, workers in Python |
| ITD 9 | Pull-based load balancing (workers pull from SQS), not a push scheduler |
| ITD 10 | Eager merge with a reductions counter (no level barrier), not level-synchronized merge or S3 polling |
| ITD 11 | DynamoDB for coordination state + atomic counters; S3 for all bulk vectors |
| ITD 12 | PENDING jobs wait in a DynamoDB waiting room, not a second SQS queue |
| ITD 13 | Live UI updates via client polling, not WebSocket push |

---

| ITD 1 - Binary `.npy` for bulk data, CSV for the result | |
| :---- | :---- |
| **THE PROBLEM** | What on-disk format should we use for the three kinds of data: input files, intermediate partials, and the final result? |
| **OPTIONS CONSIDERED (Decision in bold)** | **`.npy` float32 inputs + `.npy` float64 partials + CSV result** / CSV everywhere / Parquet / JSON |
| **REASONING** | Inputs dominate volume (up to 200k files x 10k values ~= 2x10^9 numbers). Binary `.npy` loads near-instantly and float32 halves storage and transfer versus float64; since source values are random in `[0,1]` they need only ~7 significant digits, which float32 covers. Partials are sums and must accumulate in float64 for precision, but there are few of them so the extra width is negligible. The result is a single length-C vector - tiny - so CSV wins on human-readability and matches the example in the task. CSV-everywhere is rejected because text-parsing ~2x10^9 floats is far too slow and large; Parquet and JSON add dependencies and framing overhead with no benefit at this shape. |
| **TRADEOFFS** | `.npy` is NumPy-centric, so only the Python worker touches numeric I/O while the Node API stays out of it. Binary data is not human-inspectable; mitigated by allowing CSV for small/demo inputs and using CSV for the result. |
| **NOTES** | `count` is stored in DynamoDB, not in the partial file, so a partial on disk is just a vector. CSV inputs are permitted for small/demo jobs. |

---

| ITD 2 - Compute the mean as `(sum, count)` partials in float64, divide once | |
| :---- | :---- |
| **THE PROBLEM** | How do we compute a per-index mean across F files without overflow or precision loss, in a form that also distributes cleanly? |
| **OPTIONS CONSIDERED (Decision in bold)** | **`(sum_vector, count)` partials in float64, combined then divided once at the end** / Welford running mean / integer accumulation / per-chunk averaging |
| **REASONING** | The computation must satisfy four requirements: (R1) **distributable** - partials combine in any order/grouping so a tree of workers can merge them; (R2) **overflow-safe** at scale; (R3) **accurate** - bounded rounding error; (R4) **simple** - one vectorizable code path that is easy to test. `(sum_vector, count)` meets all four: it is a monoid (`(sumA,countA) + (sumB,countB) = (sumA+sumB, countA+countB)`), so R1 holds; values in `[0,1]` over F < 100k give a max sum ~10^5 against a float64 ceiling ~1.8x10^308, so R2 holds with huge margin; NumPy pairwise summation keeps error ~log F (not F), so R3 holds; and it is a single vectorized add plus one final divide, so R4 holds. Dividing once by the *validated* total count (which must equal F) also doubles as a correctness check. Each alternative misses a requirement: **Welford** satisfies R1-R3 but fails R4 - its parallel merge algebraically reduces to `(sum, count)` anyway, so it only adds per-step division and `M2` state, and the stability it is famous for solves R3 problems we do not have at this scale. **Integer accumulation** fails R2/R3 - scaling `[0,1]` floats to integers needs a scale factor, quantizes the data, and risks overflow as counts grow. **Per-chunk averaging** fails R1 - averaging averages mis-weights unequal chunks unless you also carry counts, at which point it simply *is* `(sum, count)`. |
| **TRADEOFFS** | float64 partials are twice the size of float32, accepted because partials are few. Carrying `count` alongside each vector adds minor bookkeeping. |
| **NOTES** | Kahan (compensated) summation is **not a competing option** but an *orthogonal refinement* of the summation step inside the chosen approach - it pushes R3 further (error ~O(epsilon) instead of O(epsilon * log F)) at the cost of slower scalar addition. NumPy pairwise summation already satisfies R3 with large margin at this scale, so Kahan stays an off-by-default lever, switched on only if exact arithmetic is ever required. Full derivation - naive vs pairwise vs Kahan, error bounds, and the compute cost - is in [`../algos/numerical-accuracy.md`](../algos/numerical-accuracy.md). |

---

| ITD 3 - One operation: `merge`, applied until a single partial remains | |
| :---- | :---- |
| **THE PROBLEM** | Should the system have distinct MAP and REDUCE stages, or a single unified operation? |
| **OPTIONS CONSIDERED (Decision in bold)** | **A single `merge` operation - every file is a `count = 1` partial, a task combines <=5 partials into one, applied recursively up the tree, finalized by dividing when `count == F`** / separate MAP + REDUCE stages |
| **REASONING** | Combining partials is the same associative operation at every level, so "map" and "reduce" are not actually different - there is only merge, applied repeatedly. One operation means one code path, fewer artifacts, and far simpler testing, which matters under a tight time budget. The final divide is just the last merge, recognized by `count == F`. Edge cases vanish: a leftover single file is a `count = 1` partial that rides up the tree with no special handling. Separate stages are rejected as duplicated logic for no benefit. |
| **TRADEOFFS** | Recursive re-queuing means a job spans ~log5(F) levels with intermediate partials persisted to S3 - more round-trips than one monolithic reduce - offset by fast convergence (each level shrinks the pile ~5x). |
| **NOTES** | Terminology is fixed: the design and docs say **merge** only; "reduce" is dropped. |

---

| ITD 4 - Hard cap of <=5 inputs per task; speed from fleet width, not single-worker streaming | |
| :---- | :---- |
| **THE PROBLEM** | The RAM rule allows a worker to hold at most 5 files at once. Does that permit one worker to *stream* all F files (5 resident at a time) and skip distribution entirely? |
| **OPTIONS CONSIDERED (Decision in bold)** | **Cap every task at <=5 inputs; get speed from width (W parallel workers)** / one worker streams everything / unlimited per-task streaming |
| **REASONING** | "5 at a time" means 5 resident in memory. A single worker streaming all F files would be correct and arguably legal, but it discards the entire point of the exercise - a fleet of W workers, orchestration, completion detection, concurrent jobs - and is sequential and slow. We treat it as out of scope and cap each task at <=5 inputs, taking speed from *width*: many tasks running concurrently. Distribution is precisely what the task evaluates, so it stays central; streaming is used only as memory hygiene *within* a task. |
| **TRADEOFFS** | A strict <=5 cap produces more tasks and more tree levels (~log5 F), hence more orchestration and S3 round-trips than a coarse single-worker pass. Each level runs fully in parallel, so wall-clock stays low. |
| **NOTES** | The red line is *width-1* (one worker doing everything). Within a task we **stream inputs one at a time** (fold each into the float64 accumulator, then release it), so peak memory is ~2xC floats regardless of input count - the cap is about distribution, streaming is about memory; the two are independent. SQS `batchSize > 1` may let one invocation process several <=5-input tasks back-to-back for efficiency - a lever, not the default, and not a violation, since the fleet stays parallel. |

---

| ITD 5 - Single SQS work queue, consumed by a Lambda event-source mapping | |
| :---- | :---- |
| **THE PROBLEM** | A merge produces a partial that becomes input to a later merge, so tasks are re-queued and several jobs' tasks share the system. How many queues do we use, and how are they consumed, so that work terminates, a started job finishes fast, and we stay within serverless (no always-on) compute? *(Scope: how tasks flow once they exist. Which jobs are allowed to start is ITD 6; how partials are grouped into merges is ITD 10.)* |
| **OPTIONS CONSIDERED (Decision in bold)** | (1) **One SQS work queue (standard) + DLQ, consumed by the worker Lambda via an SQS event-source mapping; merge tasks re-queue onto the same queue** / (2) one queue **per tree level** (~8 queues for F=200k, deepest non-empty level drained first) / (3) **two priority lanes** - a HIGH queue for re-queued continuation tasks and a LOW queue for new-job leaf tasks, drained HIGH-first by a custom poller |
| **REASONING** | The queue must (R1) **terminate** - re-queuing its own output must not loop forever; (R2) **keep the fleet busy** - no worker idles while work exists; (R3) run on **serverless, scale-to-zero** compute (ITD 7 bans always-on services); (R4) stay **simple**. What is deliberately *not* a requirement: **per-job latency** (see *Workload assumptions*) - these are long-running batch jobs optimized for utilization, not for any single job's wall-clock - so **priority scheduling is off the table from the start**, which by itself settles the question in favour of one queue ("only care about throughput -> single queue, stop worrying"). The rest of this analysis records why priority would be both unnecessary *and* unaffordable even if one did want it. R1 holds for every option because the merge tree strictly converges (`200000 -> 40000 -> ... -> 1`, ~F/4 finite tasks), so the decision turns on R2/R3/R4. The decision path: **Start - one queue, no priority.** SQS has no message-priority primitive (Standard has none; FIFO only orders *within* a group), so if several jobs' tasks coexist, a started job's tail can sit behind a newer job's leaves - a per-job latency cost that, per the workload assumption above, we accept. **Option 2 - queue per level.** Insight: a task at a *deeper* level is closer to done, so routing each level to its own queue and always draining the **deepest non-empty** queue first gives exact "closest-to-completion-first" priority - the finest-grained anti-starvation possible. Rejected on R3/R4: it needs ~8 queues + 8 DLQs **and** a hand-written consumer that scans the lanes deepest-first (because SQS has no cross-queue priority), and that consumer must poll **continuously** = an always-on process, which ITD 7 forbids. **Option 3 - two lanes.** The minimal form of the same idea (continuation vs new-leaf instead of 8 levels); strictly less machinery than Option 2 but identical fatal flaw - strict HIGH-before-LOW still needs an always-on poller. **The pivot:** every multi-queue option exists *only* to prioritize one job's tasks over another's, which matters *only* while jobs overlap and the fleet would otherwise idle on the wrong work. But on Lambda **idle costs nothing**, so we choose not to overlap at all - admission (ITD 6) serializes big jobs, so a started job **runs alone**, nothing foreign can jump its tail, and **R2 holds with zero task priority**. That removes the only motivation for Options 2 and 3, which are now simultaneously unnecessary (idle is free) and unaffordable (need a banned poller). **Option 1** consumes SQS via a Lambda event-source mapping - the scale-to-zero way to read a queue, where AWS runs the pollers for free - and wins on R3 + R4 while tying on R1 + R2. |
| **TRADEOFFS** | A single queue has no task prioritization, so this decision is only safe *because* ITD 6 does not overlap big jobs; if admission were ever changed to overlap, a started job's tail could wait behind a newer job's leaves and we would revisit Options 2/3. Re-queuing intermediate partials adds S3 round-trips versus one monolithic pass, offset by ~5x convergence per merge step. |
| **NOTES** | Worker consumes via SQS event-source mapping (AWS-managed pollers, billed only per invocation). A worker that produces a partial may claim <=5 ready partials and enqueue a merge task onto the same queue (eager merge, ITD 10). **Conditional upgrade** (only if idle ever becomes costly, e.g. workers move to always-on compute and jobs overlap): adopt Option 3 (two lanes) for coarse priority, or Option 2 (per-level queues) for strict closest-to-done priority - both then affordable because the poller is no longer the thing we are avoiding. |

---

| ITD 6 - Capacity-based job admission via a dispatcher; submissions are never rejected | |
| :---- | :---- |
| **THE PROBLEM** | Which submitted jobs are fed into the work queue, and when, so that (a) a started job runs to completion fast instead of crawling behind others, and (b) the fleet never idles - even when every job is tiny - while a customer submission is *never* rejected? *(Scope: which jobs may start. How their tasks then flow and are ordered is ITD 5.)* |
| **OPTIONS CONSIDERED (Decision in bold)** | **Capacity-based admission on in-flight *tasks*: accept every submission as PENDING, and a dispatcher tops up the work queue while in-flight tasks are below a target (~k x W), continuously (no batch barrier)** / serialize - admit the next job only when in-flight `== 0` (one job at a time) / fixed job-count limit (N active jobs, e.g. "W jobs per batch") / no admission (every submission floods the queue immediately) |
| **REASONING** | Admission must satisfy three needs: (R1) **never reject** a submission; (R2) **steady overall progress** - a flood of newcomers must not dilute the fleet across all jobs so that nothing finishes in good time (the metric is utilization + completion, not per-job latency; see *Workload assumptions*); (R3) **good utilization** regardless of job size. All options meet R1 by accepting submissions; they differ on R2/R3. The signal must be **in-flight tasks, not job count**, because a job is not a unit of work - it ranges from 1 task (F=1) to ~40,000 (F=200k). The decision path: **No admission** (flood) fails R2 - every new job's tasks immediately share the fleet, so all jobs crawl (N big jobs each finish at ~Nx). **Serialize** (one job at a time) fixes R2 but fails R3 for small jobs: an F=1 job holds the fleet with a single task while W-1 workers idle, and many tiny jobs run strictly one-after-another - it is really capacity admission with the target pinned too low (1). Raising that idea to a count gives **a job-count limit** ("W jobs per batch"), which breaks both ways - admitting W *big* jobs floods (they share the fleet), while admitting W *tiny* jobs still throttles (W tasks when hundreds could stream) - and a batch *barrier* also stalls the next batch behind the slowest member. Counting **tasks** instead of jobs is what makes it adapt: a big job's `ceil(F/5)` tasks exceed the target so it runs **alone = optimal** (a saturated fleet cannot go faster), while many tiny jobs are admitted **together** to fill the target. So you neither "admit one" (idles the fleet) nor "admit W jobs" (size-blind); you admit *until in-flight reaches ~k x W*. Top-up is continuous (admit as the queue drains), not batched, so there is no barrier stall. The dispatcher fires on submit, on job completion, and on a gated periodic sweep. |
| **TRADEOFFS** | Adds a dispatcher plus a capacity signal (in-flight-task counter or SQS `ApproximateNumberOfMessages`) - more state to test than letting jobs flow straight in. Serializing big jobs means a small job submitted behind a big one waits (bounded, never rejected); finer fairness (let small jobs slip into spare capacity) is a later admission-policy tweak, not a queue change. |
| **NOTES** | Implementation: a DynamoDB PENDING-jobs waiting room (ordered by `submittedAt`, ITD 12) + the work queue (ITD 5) + a dispatcher Lambda. Admission is not rejection - every `POST /jobs` returns `202 Accepted` and backpressure is applied by *holding* PENDING jobs, never refusing them; the waiting room is effectively unbounded and `GET /jobs/:id` reports `PENDING -> RUNNING -> COMPLETE`. `k` is a tunable knob (e.g. `k=2` buffers ~2 waves so workers never wait on a dispatcher tick). |

---

| ITD 7 - Serverless-only compute; no always-on services | |
| :---- | :---- |
| **THE PROBLEM** | What compute substrate runs the API, workers, and dispatcher - and is any continuously-running (always-billed) service such as ECS/Fargate or a standalone poller allowed? |
| **OPTIONS CONSIDERED (Decision in bold)** | **Lambda for all compute (API, worker, dispatcher) + pay-per-use managed stores (S3, DynamoDB, SQS); nothing always-on** / a long-running ECS/Fargate service (API or worker fleet or queue poller) / a mix |
| **REASONING** | Hard project constraint: cost must scale to zero when idle, so any resource billed while doing nothing is banned. Lambda is billed per invocation and scales to zero; S3/DynamoDB/SQS are pay-per-use storage/transport - all acceptable. ECS/Fargate (and any custom always-on SQS poller) bill continuously whether or not work exists, so they are rejected outright. This constraint is load-bearing for other ITDs: it is *why* SQS is consumed by a Lambda event-source mapping rather than a hand-written poller, and *why* strict cross-queue priority (which needs continuous polling) is off the table (ITD 5). It also makes fleet idle **free**, which removes the incentive to overlap jobs and therefore to prioritize tasks. |
| **TRADEOFFS** | Lambda's constraints must be designed around: 15-minute max duration (fine - tasks are small and bounded by the <=5-input cap), cold starts (mitigated by the container image being small; acceptable for this workload), and no long-lived in-process priority polling (handled by ITD 5/6). Reserved concurrency on the worker Lambda stands in for "fleet width" W. |
| **NOTES** | Concretely banned: ECS, Fargate, EC2, any "always-on" container or poller. Allowed: Lambda, API Gateway, S3, DynamoDB, SQS, EventBridge (periodic dispatcher trigger, gated to run only while PENDING jobs exist so it is effectively free). |

---

| ITD 8 - Monorepo with 3 deployables; API in TypeScript, workers in Python | |
| :---- | :---- |
| **THE PROBLEM** | How is the codebase organized - one repository or several - and what are the deployable units and their languages? |
| **OPTIONS CONSIDERED (Decision in bold)** | **One monorepo: 3 deployables (`web` Next.js/TS, `api` Node-Express/TS incl. the dispatcher, `worker` Python) + a shared contracts package + infra** / multiple git repos (polyrepo) / a single deployable that does everything |
| **REASONING** | This is one product whose parts are bound by shared contracts (queue message shapes, table/queue names). A monorepo keeps those contracts in one `packages/shared` source of truth (DRY) that the API, UI, and infra all import, so application code and IaC cannot drift; a polyrepo would scatter the contract and add cross-repo version coordination for no benefit at this size and timebox. Three deployables map to three genuinely different runtime profiles - a static UI, a request/response API, and a compute worker - each scaling and deploying independently. There is no fourth "aggregator" service (ITD 3 - it is the final merge). The language split is fixed by the task: **API in Node/Express/TS, workers in Python** (NumPy for the numeric core); the UI is TS/Next so it shares types with the API. A single all-in-one deployable is rejected - it couples the UI's static hosting, the API's burst traffic, and the worker's heavy NumPy runtime into one artifact that cannot scale or deploy independently. |
| **TRADEOFFS** | A monorepo needs workspace tooling (pnpm workspaces + Turborepo) and a cross-language contract-parity check (zod vs Pydantic) so the TS and Python sides stay in sync. Two languages mean two toolchains and two CI lanes. |
| **NOTES** | Layout: `apps/{web,api,worker}`, `packages/shared`, `infra/`. The dispatcher (ITD 6) ships inside the `api` deployable, not as a separate repo or service. |

---

| ITD 9 - Pull-based load balancing (workers pull from SQS), not a push scheduler | |
| :---- | :---- |
| **THE PROBLEM** | Workers run at different speeds and must minimize idle time. How is work assigned to workers? |
| **OPTIONS CONSIDERED (Decision in bold)** | **Pull - each worker (a Lambda invocation) takes the next task off SQS when it is free** / push - a central scheduler assigns tasks to specific workers |
| **REASONING** | Requirements: (R1) **balance** across heterogeneous worker speeds; (R2) **minimize idle**; (R3) **no central bottleneck**; (R4) **simple**. Pull meets all: a worker that finishes early immediately pulls the next message, so faster workers naturally process more - balancing is *emergent*, and no component needs to track any worker's speed or load (R1/R2); there is no scheduler to bottleneck or fail (R3). Push fails R1/R2/R4: the scheduler must model each worker's speed and in-flight load, and a task assigned to a slow worker stalls while fast workers idle, which forces heartbeats, rebalancing, and work-stealing - a lot of machinery for a worse result. On Lambda + SQS, pull is also what AWS provides natively: the event-source mapping hands messages to available concurrency (ITD 5/7), so we get pull with zero scheduler code. |
| **TRADEOFFS** | Pull gives no global placement control (you cannot pin a task to a specific worker) - irrelevant here because tasks are uniform and stateless. Visibility-timeout must be tuned so a slow-but-progressing task is not redelivered prematurely. |
| **NOTES** | Realized by the SQS event-source mapping (ITD 5), not hand-written. Chunk granularity (<=5, ITD 4) sets how finely work can rebalance near a job's tail. |

---

| ITD 10 - Eager merge with a reductions counter; no level barrier, no S3 polling | |
| :---- | :---- |
| **THE PROBLEM** | How are partials grouped into <=5-input merges, and how is completion detected, without (a) a **level barrier** that idles workers while a level's slowest task finishes, (b) an always-on poller, or (c) races when several workers try to merge the same partials - all under at-least-once delivery? |
| **OPTIONS CONSIDERED (Decision in bold)** | **Eager pool + a single reductions counter** - each produced partial joins a per-job "ready pool"; as soon as >=5 unclaimed partials exist (or, once all leaves are produced, >=2 for the tail), a worker atomically claims up to 5 and enqueues one merge task; completion is a single counter `reductionsRemaining = ceil(F/5) - 1` (each c-input merge does `ADD -(c-1)`; reaching 0 means one partial remains -> finalize) / level-synchronized merge with a per-level counter (level L+1 enqueued only when *all* of level L is done) / poll S3 `LIST` for ready partials |
| **REASONING** | Requirements: (R1) **no artificial idle** - a worker should start merging the instant 5 partials exist, not wait for a level to drain; (R2) **exactly-once completion** under redelivery; (R3) **no always-on** component (ITD 7); (R4) **race-free claiming** - two workers must never merge the same partial. The key insight is the **reductions counter**: reducing N leaf partials to one always takes exactly `N-1` reductions, and a merge of c inputs performs `c-1` of them *regardless of how partials are grouped or interleaved* - so one atomic `ADD reductionsRemaining -(c-1)` detects "one partial left" with no concept of levels at all (gives R1 + R2). Claiming is serialized by an atomic **conditional** `ADD claimedCount n` over a per-job sequence of ready partials, so each claimer owns a disjoint range of <=5 keys (R4). Producers trigger claims inline, so nothing polls (R3). **Level-synchronized merge** is rejected on R1: level L+1 waits for the slowest level-L task, idling the fleet during every level's tail - e.g. F=30, W=5: the 6th leaf runs alone with 4 idle, then a barrier, then 2 merges, then 1, when the 5 already-ready partials could have been merging immediately. **S3 polling** is rejected on R2/R3: `LIST` is eventually consistent (a just-written partial may not appear, making the count racy) and it needs a banned poller. |
| **TRADEOFFS** | More per-job bookkeeping than one level counter: a ready-partial registry + `readyCount`/`claimedCount` + the conditional claim. Eager grouping yields a few sub-5 merges near the tail (slightly more merges, harmless). A transient lone partial in the pool re-waits for a partner; because `reductionsRemaining > 0` guarantees another partial exists or is coming, it always converges (a small redrive delay avoids busy-looping). |
| **NOTES** | Still **one work queue** (ITD 5): a claim enqueues an explicit <=5-key merge task onto it - this is not a second queue. Counters live on the `Jobs` row. `F <= 5` => `reductionsRemaining = 0` at the single leaf, which finalizes directly. Files -> leaf partials is *production* (N = `ceil(F/5)` of them); only partial -> partial steps count as reductions. Finalize divides by the validated count (must equal F). See `../architecture/aggregation.md`. |

---

| ITD 11 - DynamoDB for coordination state; S3 for all bulk vectors | |
| :---- | :---- |
| **THE PROBLEM** | Where does coordination state (job records, counters) live, and where do the large numeric artifacts (inputs, partials, result) live? |
| **OPTIONS CONSIDERED (Decision in bold)** | **DynamoDB for coordination state + atomic counters, S3 for all bulk vectors (inputs/partials/result)** / a relational DB (RDS/Postgres) for state / storing partials in DynamoDB as well |
| **REASONING** | Two data shapes with opposite needs. Coordination state needs atomic counters, single-digit-ms point reads, conditional writes, and scale-to-zero billing -> DynamoDB fits, and ITD 10's completion detection depends on its atomic `ADD`. **RDS/Postgres** is rejected: it bills while idle (ITD 7), needs connection management from Lambda, and offers nothing extra for key-value counters. Bulk vectors are huge (input alone ~2x10^9 numbers) and are only ever read/written whole by key -> S3 fits (cheap, durable, parallel-readable). **Partials in DynamoDB** is rejected on cost and limits: ~20k partials x 10k float64 each blow past the 400 KB item cap and cost ~$2/job in per-KB writes versus ~$0.10 in S3 PUTs. Hence the hard rule: **DynamoDB stores pointers/state, S3 stores data.** |
| **TRADEOFFS** | Two stores instead of one; a job's truth is split across S3 (data) and DynamoDB (state), so some reads touch both. Accepted - each store is used only for what it is best at. |
| **NOTES** | DynamoDB holds `Jobs` (status, `reductionsRemaining` + ready-pool counters), `Ready`, `Tasks`, and the `Fleet` in-flight counter; S3 holds inputs/partials/result. See `../architecture/database.md`. |

---

| ITD 12 - PENDING jobs wait in a DynamoDB waiting room, not a second SQS queue | |
| :---- | :---- |
| **THE PROBLEM** | Where do accepted-but-not-yet-admitted (`PENDING`) jobs wait, given that admission (ITD 6) holds them until capacity frees and submissions are never rejected? |
| **OPTIONS CONSIDERED (Decision in bold)** | **A DynamoDB waiting room (`Jobs` rows with `status=PENDING`, GSI on `status`+`submittedAt`)** / a second SQS "pending" queue / an SQS delay queue |
| **REASONING** | The dispatcher must (R1) admit the **oldest** waiting job (FIFO fairness), (R2) **know how many/which** jobs wait (dashboard "Nth in line"), (R3) allow **cancellation** of a waiting job, and (R4) **never lose** a submission. DynamoDB gives all four: the `status`+`submittedAt` GSI is a single indexed "oldest PENDING" query (R1/R2), a waiting job is a row that can be updated or cancelled (R3), and it is durable (R4). **A pending SQS queue** fails R1-R3: SQS is not queryable (you cannot list/rank/count waiting jobs without draining it), exposes no oldest-first peek, and you cannot cancel or inspect a specific message - it is a consume-once pipe, not a waiting room. **A delay queue** only defers by time, which does not model "admit when capacity frees." |
| **TRADEOFFS** | The dispatcher runs a GSI query rather than receiving a message - cheap, but admission becomes a *pull* (dispatcher reads DynamoDB) rather than a *push* (queue delivers), which is exactly what capacity-based admission needs. |
| **NOTES** | The waiting room is effectively unbounded (backpressure = holding rows, never rejecting). Only *admitted* tasks ever reach the SQS work queue (ITD 5). Directly complements ITD 6. |

---

| ITD 13 - Live UI updates via client polling, not WebSocket push | |
| :---- | :---- |
| **THE PROBLEM** | How does the dashboard show live job progress (status, current level, percent)? |
| **OPTIONS CONSIDERED (Decision in bold)** | **Client polls `GET /jobs/:id` on an interval** / WebSocket (API Gateway WebSocket) push / server-sent events (SSE) |
| **REASONING** | Requirements: (R1) **timely enough** for a batch job that runs seconds-to-minutes; (R2) **scale-to-zero**, no always-on connection infrastructure (ITD 7); (R3) **simple** under the timebox. Polling meets all three: a few-second interval is ample for this workload (R1), each poll is a stateless Lambda read of `Jobs` (R2), and it is trivial to build and reason about (R3). **WebSocket** is rejected - API Gateway WebSocket needs a persistent connection store and connection lifecycle management, i.e. more moving parts for sub-second latency we do not need. **SSE** has the same long-lived-connection overhead on Lambda. |
| **TRADEOFFS** | Polling has a latency floor (the interval) and makes redundant reads when nothing changed - negligible at this scale and DynamoDB read cost. If real-time push is ever needed, the status fields already exist; only the transport changes. |
| **NOTES** | Progress fields are derived from existing state (`Jobs.status`, `reductionsRemaining`, `submittedAt` rank) - see `../architecture/lifecycle.md` - so polling adds no extra bookkeeping. |
