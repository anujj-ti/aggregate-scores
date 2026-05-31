# Distributed Mean - ITD Decisions

This document records implementation tradeoff decisions (ITDs) for interview discussion and design review.
Architecture deep dives live in `../architecture/`.

## Decision Index

| ITD | Decision |
| :-- | :-- |
| ITD 1 | Binary `.npy` for inputs/partials; CSV for final result |
| ITD 2 | `(sum_vector, count)` in float64; divide once at finalize |
| ITD 3 | Single recursive `merge` operation (no separate map/reduce stage) |
| ITD 4 | Hard task input cap `<= 5`; scale throughput by fleet width |
| ITD 5 | One SQS work queue for admitted tasks |
| ITD 6 | Capacity-based admission (`PENDING` waiting room + dispatcher) |
| ITD 7 | Serverless-only compute path (scale-to-zero) |
| ITD 8 | Monorepo with `web`, `api`, `worker` + shared contracts |
| ITD 9 | Pull-based scheduling (workers consume queue) |
| ITD 10 | Eager merge + `reductionsRemaining` completion (no level barrier) |
| ITD 11 | DynamoDB control plane; S3 data plane |
| ITD 12 | `PENDING` waiting room in DynamoDB (not a second queue) |
| ITD 13 | UI progress via API polling (not WebSocket/SSE) |

---

<table>
  <tr><th colspan="2">ITD 1 - <em>Binary <code>.npy</code> for bulk vectors; CSV for final output</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Choose storage formats for high-volume numeric artifacts vs operator-facing output.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> float32 <code>.npy</code> inputs, float64 <code>.npy</code> partials, CSV result</li><li>CSV for everything</li><li>Parquet/columnar formats</li><li>JSON payloads</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>NumPy binary is the fastest and smallest path for dense vectors. Final output is one tiny operator artifact, so CSV maximizes readability where it matters.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Binary artifacts are not human-readable. We accept that for throughput and expose a human-readable final result.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Vector blobs store numeric arrays; counts are tracked in coordination metadata/counters and task context, not as a human-facing output format.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 2 - <em>Distributed mean via <code>(sum_vector, count)</code> in float64</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Compute a global mean across many files with merge-order independence and stable precision.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> carry <code>(sum_vector, count)</code>; divide once at finalize</li><li>Average-of-averages</li><li>Welford-style online variance path</li><li>Scaled integer arithmetic</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>The pair is associative, so merges are valid in any grouping. Float64 accumulation keeps numeric drift low while preserving a simple correctness proof.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Float64 partials are larger than float32, but partial volume is far lower than raw input volume.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Finalize includes integrity check <code>count == F</code> before writing <code>result.csv</code>.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 3 - <em>Single recursive <code>merge</code> operation</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Decide whether to split logic into separate map/reduce stages or unify execution.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> one <code>merge</code> operation for leaf and merge tasks</li><li>Separate MAP and REDUCE implementations/states</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>Both stages apply the same algebra over <code>(sum,count)</code>. One operation reduces branching, status complexity, and test surface.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Requires explicit task metadata to distinguish leaf vs merge inputs, but keeps correctness model uniform.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>No separate job status like <code>REDUCING</code>; job stays <code>RUNNING</code> until final merge completes.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 4 - <em>Cap each task at <code>&lt;= 5</code> inputs; scale by width</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Bound per-task memory and runtime while preserving distributed scheduling behavior.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> hard chunk cap of 5 inputs per task</li><li>Larger/unbounded chunks</li><li>Single worker streaming all files</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>Small fixed chunks bound resource usage and force decomposition. Throughput scales by parallel workers, not oversized tasks.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>More task orchestration overhead and deeper reduction trees at high <code>F</code>.</td></tr>
  <tr><td><strong>NOTES</strong></td><td><code>chunkSizeUsed</code> is snapshotted at admission and remains immutable for that job.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 5 - <em>Single SQS work queue for admitted tasks</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Queue tasks simply without adding always-on custom schedulers.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> one standard SQS work queue (+ DLQ)</li><li>Per-level queues</li><li>Dual-priority queues with custom poller</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>A single queue aligns with Lambda event-source mapping and serverless operations. Priority behavior is handled at admission, not by queue complexity.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>No strict message-level priority across jobs in the queue.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Only admitted tasks are enqueued; non-admitted jobs remain in <code>PENDING</code> in DynamoDB.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 6 - <em>Capacity-based admission via dispatcher; accept-all submissions</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Prevent overload/starvation without rejecting user submissions.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> accept to <code>GENERATING/PENDING</code>, then admit by capacity</li><li>Reject when busy (hard backpressure)</li><li>Fixed active-job cap</li><li>No admission gate</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>Dispatcher admits oldest <code>PENDING</code> jobs while <code>inFlight &lt; k·W</code>. This preserves acceptance semantics, controls load, and adapts to job size better than job-count limits.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Adds dispatcher and in-flight accounting complexity.</td></tr>
  <tr><td><strong>NOTES</strong></td><td><code>PENDING</code> is a DynamoDB waiting room with queue-position visibility; jobs are never rejected for transient capacity.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 7 - <em>Serverless-only compute (scale-to-zero)</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Meet cost model requirements for bursty workloads with no idle baseline.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> Lambda + managed stores (SQS/S3/DynamoDB)</li><li>Always-on ECS/Fargate/EC2 scheduler-worker fleet</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>Scale-to-zero constraints favor event-driven compute and managed services. This avoids running a permanent scheduler/poller process.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Must handle Lambda constraints (cold starts, timeout envelopes, at-least-once delivery).</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Architecture intentionally avoids any continuously running control-plane service.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 8 - <em>Monorepo with 3 deployables + shared contracts</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Keep API/UI/worker contracts synchronized across languages and deployments.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> monorepo: <code>apps/web</code>, <code>apps/api</code>, <code>apps/worker</code>, shared schema package</li><li>Polyrepo split</li><li>Single service codebase</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>Shared schema source-of-truth minimizes drift and makes lifecycle/counter semantics consistent across stack boundaries.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Requires disciplined workspace tooling and contract generation checks.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>TypeScript APIs and Python worker both consume generated/shared contract definitions.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 9 - <em>Pull-based scheduling from queue consumption</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Balance variable-duration tasks without central per-worker assignment logic.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> workers pull next available task from SQS</li><li>Central push scheduler assigning specific workers</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>Pull naturally load-balances heterogeneous execution times and reduces scheduler bottlenecks.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Less direct placement control and harder deterministic ordering.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Implemented via Lambda event-source mapping over the single work queue.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 10 - <em>Eager merge + <code>reductionsRemaining</code>; no level barriers</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Advance reductions quickly and detect completion correctly under concurrent, at-least-once execution.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> eager merge from ready pool + atomic <code>reductionsRemaining</code></li><li>Strict level-by-level barriers</li><li>S3 listing/polling as reduction source-of-truth</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>At admission: <code>reductionsRemaining = leafTasksTotal - 1</code>. Each merge of <code>c</code> inputs atomically applies <code>-(c-1)</code>. Workers merge eagerly at 5-ready, and also at tail when <code>available &gt;= 2</code> and <code>available == reductionsRemaining + 1</code>, so no barrier idle time.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Requires extra counters and conditional claim bookkeeping.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>Race safety depends on disjoint conditional claims (<code>claimedCount</code>) and idempotent task transitions so reductions are decremented exactly once per task completion.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 11 - <em>DynamoDB for coordination; S3 for vector artifacts</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Choose storage roles for atomic control state vs large immutable numeric blobs.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> DynamoDB control plane + S3 data plane</li><li>Single RDBMS for state and blobs</li><li>Store partial vectors directly in DynamoDB</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>DynamoDB supports conditional writes and counters needed for admission/completion. S3 is the right fit for large object throughput and cost.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Two-store operational model and cross-store observability correlation.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>DynamoDB stores statuses/counters/pointers; S3 stores inputs, partial arrays, and final <code>result.csv</code>.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 12 - <em><code>PENDING</code> waiting room in DynamoDB (not a second queue)</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Hold accepted-but-not-admitted jobs with ordering, visibility, and cancellation support.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> DynamoDB <code>status=PENDING</code> + <code>submittedAt</code> index</li><li>Second SQS queue for pending jobs</li><li>Delay/retry queue hacks</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>Admission needs oldest-first scanning, queue position in UI, and clean pre-admission cancellation. DynamoDB supports these directly.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Admission becomes explicit dispatcher logic instead of queue-native flow.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>State path is <code>GENERATING -&gt; PENDING -&gt; RUNNING</code>; only <code>RUNNING</code> jobs contribute tasks to SQS.</td></tr>
</table>

<table>
  <tr><th colspan="2">ITD 13 - <em>Client polling for live UI status</em></th></tr>
  <tr><td><strong>THE PROBLEM</strong></td><td>Expose near-live progress with low operational complexity.</td></tr>
  <tr><td><strong>OPTIONS CONSIDERED</strong></td><td><ul><li><strong>Chosen:</strong> interval polling of job endpoints</li><li>WebSocket push</li><li>SSE push</li></ul></td></tr>
  <tr><td><strong>REASONING</strong></td><td>Jobs run in seconds-to-minutes; polling gives adequate freshness from existing state fields (<code>status</code>, <code>percent</code>, <code>reductionsRemaining</code>, queue position) without persistent connection infrastructure.</td></tr>
  <tr><td><strong>TRADEOFFS</strong></td><td>Repeated reads increase API/DynamoDB traffic compared to push.</td></tr>
  <tr><td><strong>NOTES</strong></td><td>No additional event bus is required; UI derives progress from existing API views and counters.</td></tr>
</table>
