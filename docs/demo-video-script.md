# Aggregate Scores Demo Video Script (Narrative)

This is a spoken script for a 10-15 minute video. Read it like a story from top to bottom.

I start by saying: this system computes per-index means across many files. A user submits one job with two numbers, `F` and `C`. `F` is how many files we process, and `C` is how many values each file has. Internally, the stack is Node/Express API, DynamoDB for coordination state, S3 for file data, one SQS work queue, and Python workers.

When the dashboard opens, I tell the audience that they are looking at three different views at once: system capacity, job lifecycle, and execution pressure. I explain that `W` is a global system capacity control, not a per-job setting. I explain that one user job is not one worker task; one job is split into many task units.

Then I explain the most confusing terms clearly. I say: do not read these numbers as one queue. We have different waiting layers. `GENERATING` means job exists but inputs are still being written. `PENDING` means inputs are ready, but the job is still waiting for admission. `RUNNING` means admitted and actively flowing through leaf and merge execution. I explain that `inFlight` is the count of admitted task units already inside the pipeline. It is not the number of jobs, and it is not exactly the number of OS threads currently burning CPU. I explain that `bufferedTasks` is just overflow beyond immediate worker slots, computed as `max(0, inFlight - W)`.

Now I submit a small run with `F=12`, `C=3`, `reuseSampleFile=true`, `freq=1`. I say this is the shortest full walk from start to finish. While it runs, I narrate the state transitions in order: `GENERATING`, then `PENDING`, then `RUNNING`, then `COMPLETE`. I explain that generation is asynchronous, so workers are not blocked waiting for file creation. Once complete, I open the job details page and show task summary, per-level lineage, and downloads.

After this, I do the `W` demo, because this is part of the task bonus. I set `W=3`, wait a few refresh cycles, then set `W=5` again. I explain that changing `W` changes global admission pressure immediately, because admission target uses `k * W`. I say very clearly: this does not rewrite job definition. It does not change that job's `F` or `C`. It does not rebuild tasks already started.

At this point I answer the common interviewer question directly: if a job started with `W=5` and I change to `W=10` in the middle, what happens? I say: already-running task units continue as they are. The system can admit more new work afterward because `k * W` increased. So the effect is mainly throughput and latency, not computation intent.

Then I run a heavier workload burst with `F=100`, `C=64`, `reuseSampleFile=false`, `freq=5`. I explain that this is where the queueing and admission behavior becomes visible. I narrate what we should expect: temporary growth in `GENERATING` and `PENDING`, then conversion into `RUNNING` as capacity opens. I point out that pressure metrics can rise and fall independently, because job-level waiting and task-level buffering are different layers.

While that is running, I explain progress metrics in one sentence: work-units progress is an operator-facing model for total execution steps, while remaining reductions is a merge-specific counter for unresolved merge-side work.

Next I move to architecture docs and connect runtime behavior to design docs. I open `docs/architecture/system-design.md`, then lifecycle, database, API contract, sequence flow, ER diagram, detailed architecture, and finally interview guide. I say that these docs are not aspirational; they match the implemented behavior visible in the dashboard.

Before closing, I give reliability and correctness lines. I say that coordination state is typed and counter-based, task handling is idempotency-aware, and cancellation plus fleet accounting paths are hardened. I add one numerical note: changing `W` does not change target computation, but in parallel floating-point reduction, least-significant-digit variation can happen due to operation ordering.

I close with this summary: this demo showed a distributed mean pipeline with explicit lifecycle states, admission-driven scheduling, configurable global worker capacity, and runtime metrics that map to concrete semantics. Jobs and tasks are intentionally separated in the design, which is why the dashboard exposes both job-state and task-pressure views.

