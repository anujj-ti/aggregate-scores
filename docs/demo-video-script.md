# Aggregate Scores Demo Script (Read Verbatim)

[OPENING]
Hi, I am Anu, and I will demo this distributed mean-computation system.  
This video focuses on runtime behavior: submitting jobs, lifecycle transitions, worker capacity control, queue pressure, and progress.  
The full architecture diagrams and detailed docs are in the repository, and I will share those separately.

[CONTEXT]
This system computes per-index means across `F` files with `C` values per file.  
The stack is Node/Express API, DynamoDB for coordination state, S3 for file data, one SQS work queue, and Python workers.

[DASHBOARD EXPLANATION]
On this dashboard, I track three views together: capacity, lifecycle state, and execution pressure.  
`W` is global worker-capacity control, not a per-job setting.  
One user job is split into many task units.

Do not treat all waiting as one queue.  
`GENERATING` means the job exists and inputs are being written.  
`PENDING` means inputs are ready but not admitted yet.  
`RUNNING` means admitted and actively flowing through leaf/merge execution.  
`inFlight` is the count of admitted task units in the pipeline.  
`bufferedTasks` is overflow beyond immediate capacity: `max(0, inFlight - W)`.

[SMALL RUN]
Now I submit a small run: `F=12`, `C=3`, `reuseSampleFile=true`, `freq=1`.  
Watch the lifecycle move: `GENERATING -> PENDING -> RUNNING -> COMPLETE`.  
Generation is asynchronous, so workers do not block on file creation.

Now I open job details and show task summary, level-wise execution, and downloadable artifacts.

[W CONTROL DEMO]
Now I change `W` from 5 to 3, wait for refresh, then set it back to 5.  
This demonstrates configurable worker capacity from the task bonus.

If a job started with `W=5` and I change to `W=10` mid-run, the running job is not rebuilt.  
Started task units continue.  
New admissions can increase because `k * W` increased.  
So the effect is throughput and latency, not a change in computation intent.

[BURST RUN]
Now I run a heavier burst: `F=100`, `C=64`, `reuseSampleFile=false`, `freq=5`.  
This shows queueing and admission behavior clearly.  
You will see temporary growth in `GENERATING` and `PENDING`, then conversion to `RUNNING` as capacity opens.

[PROGRESS NOTE]
Work-units progress is an operator-facing step model.  
Remaining reductions is the merge-specific unresolved-work counter.

[DOC WALKTHROUGH]
Now I open architecture and API docs from the repo.  
These docs match the runtime behavior shown in the dashboard: lifecycle, counters, cancellation semantics, and queue/admission flow.

[CLOSING]
This demo showed distributed mean computation with explicit lifecycle control, admission-driven scheduling, configurable global worker capacity, and metrics with concrete semantics.  
Jobs and tasks are intentionally separate in the model, which is why the UI shows both job-state and task-pressure views.

