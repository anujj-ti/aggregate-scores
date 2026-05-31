# Distributed Mean - ITD Decisions

This document captures key implementation tradeoff decisions (ITDs) in a concise interview-friendly format.
Architecture details live in `../architecture/`.

## Decision Index

| ITD | Decision |
| :-- | :-- |
| ITD 1 | Binary `.npy` for bulk vectors; CSV for final output |
| ITD 2 | `(sum_vector, count)` in float64; divide once at end |
| ITD 3 | Single recursive `merge` operation (no separate map/reduce codepaths) |
| ITD 4 | Hard task input cap `<= 5`; scale via fleet width |
| ITD 5 | One SQS work queue; Lambda event-source mapping consumes it |
| ITD 6 | Capacity-based admission (`PENDING` waiting room + dispatcher) |
| ITD 7 | Serverless-only compute (scale-to-zero) |
| ITD 8 | Monorepo with 3 deployables (`web`, `api`, `worker`) + shared contracts |
| ITD 9 | Pull-based scheduling (workers consume from queue), not push scheduler |
| ITD 10 | Eager merge + reductions counter for completion (no level barrier) |
| ITD 11 | DynamoDB for coordination state; S3 for bulk numeric artifacts |
| ITD 12 | `PENDING` waiting room in DynamoDB, not a second queue |
| ITD 13 | UI progress via polling, not WebSocket/SSE |

---

<table>
  <tr>
    <th colspan="2">ITD 1 - <em>Binary <code>.npy</code> for bulk data; CSV for final result</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Choose storage format for inputs, intermediate partials, and output.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>Float32 <code>.npy</code> inputs + float64 <code>.npy</code> partials + CSV result</strong> / CSV everywhere / Parquet / JSON</td></tr>
  <tr><td><strong>REASONING</strong></td><td>Bulk I/O dominates cost and time; binary NumPy is fastest and smallest for this shape. Inputs are random in <code>[0,1]</code> so float32 is sufficient; partials must accumulate in float64 for accuracy. Output is tiny and human-readable, so CSV is best.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Binary is less human-inspectable. We accept this and expose CSV where readability matters (final output).</td></tr>
  <tr><td><strong>NOTES</strong></td><td><code>count</code> is tracked in state/counters, not embedded in every partial file payload.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 2 - <em>Compute distributed mean via <code>(sum, count)</code> monoid in float64</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Compute global mean across many files accurately and distributably.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong><code>(sum_vector, count)</code> partials, divide once at end</strong> / Welford / integer scaling / average-of-averages</td></tr>
  <tr><td><strong>REASONING</strong></td><td><code>(sum,count)</code> is associative (mergeable in any order), numerically safe at project scale, and simple to test. Final divide once avoids weighting bugs from chunk-local averaging.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Float64 partials are larger than float32, but partial count is far smaller than input count.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Kahan/compensated summation remains an optional future precision lever, not the baseline path.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 3 - <em>Single recursive merge operation</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Whether to implement separate map/reduce stages or one unified operation.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>Single <code>merge</code> operation applied recursively</strong> / separate MAP and REDUCE implementations</td></tr>
  <tr><td><strong>REASONING</strong></td><td>All stages perform the same algebra (<code>sum,count</code> combine). One operation reduces code surface, edge cases, and testing complexity.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>More explicit re-queue steps and intermediate artifacts, but cleaner correctness model.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Terminology standardized on <strong>merge</strong>.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 4 - <em>Cap every task at 5 inputs; scale by width</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>How to respect RAM limits while still solving the distributed scheduling challenge.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>Per-task cap <code>&lt;=5</code> inputs</strong> / one-worker streaming over all files / larger unrestricted chunks</td></tr>
  <tr><td><strong>REASONING</strong></td><td>The task evaluates distributed orchestration. Capping each task keeps memory bounded and enforces parallel decomposition; throughput comes from concurrent workers.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>More tasks and levels; accepted because parallel execution offsets orchestration overhead.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Inside a task, inputs may still be streamed one-by-one to keep memory stable.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 5 - <em>Single SQS work queue consumed by Lambda mapping</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Design task flow queueing without introducing always-on pollers or complex priority machinery.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>One standard SQS queue (+ DLQ)</strong> / per-level queues / dual priority queues with custom poller</td></tr>
  <tr><td><strong>REASONING</strong></td><td>Single queue is simplest and serverless-compatible. Multi-queue strict priority needs custom continuous polling, which conflicts with scale-to-zero constraints.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>No strict per-job task priority when jobs overlap; this is mitigated by admission policy (ITD 6).</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Continuation merge tasks are re-enqueued on the same queue.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 6 - <em>Capacity-based admission via dispatcher; never reject submissions</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Prevent queue flooding/starvation while keeping utilization high and preserving acceptance semantics.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>Accept all as <code>PENDING</code>; dispatcher admits by task-capacity target</strong> / strict serialize one-job-at-a-time / fixed active-job count / no admission gate</td></tr>
  <tr><td><strong>REASONING</strong></td><td>Task-based capacity signal adapts to job size; job-count gates are size-blind and inefficient. Every submission is accepted, but start time is capacity-governed.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Adds dispatcher state machine and counters, but gives stable throughput under load.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Dispatcher is triggered on submit, completion, and periodic sweeps.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 7 - <em>Serverless-only compute</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Meet scale-to-zero cost requirement while supporting bursty distributed jobs.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>Lambda + managed pay-per-use stores</strong> / always-on ECS/Fargate/EC2 workers</td></tr>
  <tr><td><strong>REASONING</strong></td><td>Project requires zero-idle-billing posture. Lambda + S3 + SQS + DynamoDB satisfies this directly.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Must design around Lambda runtime constraints and cold starts.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>No custom long-lived poller services.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 8 - <em>Monorepo with 3 deployables + shared contracts</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Organize multi-service code without contract drift across API/UI/worker.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>Monorepo (<code>web</code>, <code>api</code>, <code>worker</code>, shared package)</strong> / polyrepo / single mega-service</td></tr>
  <tr><td><strong>REASONING</strong></td><td>One source of truth for schema/contracts and constants reduces integration drift. Deployables still scale independently.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Needs workspace tooling and cross-language contract generation checks.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>API/infra use TypeScript shared package; worker consumes generated Pydantic contracts.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 9 - <em>Pull-based balancing via queue consumption</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Keep workers utilized despite variable execution time per task.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>Pull next task when free</strong> / central push scheduler with explicit worker assignment</td></tr>
  <tr><td><strong>REASONING</strong></td><td>Pull naturally balances heterogeneous worker speed and avoids central scheduling bottlenecks.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Less explicit placement control, but tasks are stateless and uniform enough that this is acceptable.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Implemented via SQS + Lambda event-source mapping behavior.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 10 - <em>Eager merge with reductions counter; no level barriers</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Detect completion and schedule merges race-free under at-least-once delivery.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>Eager ready-pool claiming + <code>reductionsRemaining</code> counter</strong> / strict level barrier scheduling / S3-list polling model</td></tr>
  <tr><td><strong>REASONING</strong></td><td>Counter-based completion is grouping-independent and race-safe with atomic updates. Workers merge immediately when useful: prefer full chunk of 5; only merge 2-4 at genuine tail when no more inputs can arrive.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Requires additional counters and claim bookkeeping, but avoids idle barriers and polling loops.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Readiness claim is conditional and disjoint, preventing duplicate merges of same partials.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 11 - <em>DynamoDB for control plane; S3 for data plane</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Choose storage split for fast atomic coordination and large vector artifacts.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>DynamoDB state + S3 vectors</strong> / RDBMS for all / store partial vectors in DynamoDB</td></tr>
  <tr><td><strong>REASONING</strong></td><td>DynamoDB excels for conditional counters and status transitions; S3 is the right fit for large immutable numeric blobs.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Two-store operational model, but each store is used for what it is best at.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>DynamoDB stores pointers/metadata/counters; S3 stores inputs, partials, outputs.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 12 - <em><code>PENDING</code> waiting room in DynamoDB</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Where should accepted-but-not-admitted jobs wait while preserving ordering and observability?</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>DynamoDB status + submittedAt index</strong> / second SQS pending queue / delay queue hacks</td></tr>
  <tr><td><strong>REASONING</strong></td><td>Need oldest-first admission, direct cancellation, and queue-position visibility. DynamoDB query/index model supports all three cleanly.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Admission is explicit dispatcher logic, not pure queue auto-flow.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Only admitted tasks enter SQS work queue.</td></tr>
</table>

<table>
  <tr>
    <th colspan="2">ITD 13 - <em>Client polling for live UI state</em></th>
  </tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Expose near-live operational status in the dashboard with low complexity.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED (Decision in bold)</strong></td><td><strong>Interval polling of API endpoints</strong> / WebSocket push / SSE push</td></tr>
  <tr><td><strong>REASONING</strong></td><td>Workload runs in seconds-to-minutes; 1s polling is sufficient and simpler than persistent connection infrastructure.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Polling adds repeated reads; accepted as low cost for this scale and complexity budget.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Progress fields come from existing state counters; no extra event system required.</td></tr>
</table>
