# Aggregate Scores Demo Script (Read Verbatim)

[OPENING]
Hi, I am Anu, and I will demo this distributed mean-computation system.  
This video focuses on what the system actually does at runtime: how jobs are accepted, how files are read by workers, how scheduling happens, and how final results are produced.  
The full architecture diagrams and detailed docs are in the repository, and I will share those separately.

[CONTEXT]
The problem is simple: user gives `F` and `C`.  
`F` means how many files. `C` means how many numbers in each file.  
The system computes one final mean vector across all files.

Architecture in one line:  
API and scheduler logic in Node/Express, state in DynamoDB, file data in S3, one SQS work queue, and workers in Python.

[DASHBOARD EXPLANATION]
On this dashboard, I track three things together:  
capacity, job lifecycle, and execution pressure.

`W` is global worker capacity control.  
One user job is not one queue message. One job is split into many task units.

State meanings in simple words:  
`GENERATING`: API is creating input files.  
`PENDING`: files are ready, job is waiting to be picked by scheduler.  
`RUNNING`: job was picked, tasks are flowing through queue and workers.

Important: waiting is not one single queue metric.  
`PENDING` is waiting at job level.  
`bufferedTasks` is waiting at task level after admission.

`inFlight` means how many task units are already admitted into execution pipeline.

[ARCHITECTURE FLOW - WHAT HAPPENS INTERNALLY]
Step 1: User submits a job with `F` and `C`.  
Step 2: API creates a job row in DynamoDB.  
Step 3: API generates input files and writes them to S3.  
Step 4: once file generation finishes, status becomes `PENDING`.

Now scheduler logic starts.  
Scheduler checks oldest pending jobs in DynamoDB order.  
It uses a capacity rule: admit while current load is below `k * W`.

What is `k * W` in simple words?  
`W` is worker capacity, `k` is buffer factor.  
So `k * W` is a soft threshold to decide if we should pick another pending job now.

Once a job is picked, scheduler creates leaf tasks and pushes them to SQS.  
Each leaf task points to file keys in S3, not raw file bytes.

Worker behavior:  
worker gets one SQS task, reads referenced files from S3, computes partial sum and count, writes partial back to S3, updates counters in DynamoDB, and may enqueue merge tasks.

Streaming behavior:  
worker does not load whole job into memory.  
it reads input files one by one from storage and folds them into accumulator state.  
This is how memory stays bounded.

Merge behavior:  
partials are merged eagerly as soon as enough are ready.  
This keeps workers busy and avoids waiting for strict level barriers.

Completion behavior:  
job completes when merge-side completion counter reaches terminal condition and final output is written.

[SMALL RUN]
Now I submit a small run: `F=12`, `C=3`, `reuseSampleFile=true`, `freq=1`.  
Watch lifecycle move: `GENERATING -> PENDING -> RUNNING -> COMPLETE`.

While it runs, I show:
task summary, level-wise breakdown, and downloadable artifacts.

[W CONTROL DEMO]
Now I change `W` from 5 to 3, then back to 5.  
This demonstrates runtime capacity control.

If a job started with `W=5` and I change to `W=10` mid-run, running work is not rebuilt.  
Started task units continue.  
New admissions can increase because threshold `k * W` increased.  
So this changes throughput and queue drain speed, not job math definition.

[BURST RUN]
Now I run a heavier burst: `F=100`, `C=64`, `reuseSampleFile=false`, `freq=5`.  
This is where scheduling behavior is visible.  
You will see growth in `GENERATING` and `PENDING`, then jobs get picked and move to `RUNNING` as capacity opens.

[PROGRESS NOTE]
Progress is shown as work-step model.  
Remaining reductions is the merge-side unresolved counter.

A job can still be `RUNNING` while progress is high, because final merge/finalize may still be in flight.

[DOC WALKTHROUGH]
Now I open architecture and API docs from the repo.  
I point to system design, lifecycle, database, API contract, and detailed diagrams.  
These docs match the runtime behavior shown here: file generation, queue admission, worker reads from S3, partial writes, and final aggregation.

[CLOSING]
This demo showed the actual runtime architecture:  
jobs are accepted, files are generated, scheduler picks pending jobs based on capacity, workers read files from S3 and write partials, merges happen eagerly, and final result is produced with tracked counters.  
The UI reflects this architecture directly, so operator metrics and backend behavior stay aligned.

