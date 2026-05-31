# System Design

## Components

There are **3 deployables** (`web`, `api`, `worker`). There is **one merge operation**, not a
separate map/reduce — the "aggregator" is just the worker running the final merge (ITD 3).

| Component | Tech | Deployable | Role |
|-----------|------|------------|------|
| **Frontend** | Next.js + TypeScript | `web` | Submit jobs (F, C), live dashboard, configure W (bonus) |
| **API** | Node + Express + TS | `api` | Create job, generate input files, store job as `PENDING`, expose status |
| **Dispatcher** | Lambda (Node/TS) | `api` | Capacity-based admission: release PENDING jobs into the queue while in-flight tasks `< k·W` (ITD 6) |
| **Worker** | Python (Lambda, ≤W concurrent) | `worker` | SQS-triggered; merge ≤5 inputs → one `(sum_vector, count)` partial; when ≥5 partials are ready, claim and enqueue a merge; finalize when one remains |
| **Work queue** | SQS (standard) + DLQ | infra | Holds task messages; merge tasks re-queue onto it; consumed by the worker via event-source mapping (ITD 5) |
| **State store** | DynamoDB | infra | Jobs (incl. PENDING waiting room), reductions + ready-pool counters, in-flight counter |
| **Object store** | S3 | infra | Input files, partial `(sum, count)` vectors, final result |

All compute is **Lambda** — nothing always-on (ITD 7).

## High-level diagram

```mermaid
flowchart LR
    UI[Next.js UI] -->|POST /jobs F,C| API[Express API]
    API -->|generate F files| S3[(S3)]
    API -->|write job status=PENDING| DDB[(DynamoDB)]
    API -->|202 Accepted| UI

    DISP[Dispatcher Lambda] -->|oldest PENDING while inFlight < k*W| DDB
    DISP -->|enqueue leaf tasks| Q[[SQS work queue]]

    subgraph Fleet[Worker Lambda - up to W concurrent]
        W1[Worker]
        W2[Worker]
    end

    Q -->|event-source mapping| Fleet
    Fleet -->|stream <=5 inputs (one at a time)| S3
    Fleet -->|write partial sum_vector,count| S3
    Fleet -->|reductionsRemaining -(c-1); readyCount +1| DDB
    Fleet -->|>=5 partials ready: claim + enqueue merge| Q
    Fleet -.->|reductionsRemaining == 0: finalize - divide by F| S3

    UI -->|GET /jobs/:id| API
    API --> DDB
```

## End-to-end sequence

```mermaid
sequenceDiagram
    participant U as User (UI)
    participant A as API
    participant S as S3
    participant D as DynamoDB
    participant P as Dispatcher
    participant Q as SQS
    participant W as Worker

    U->>A: POST /jobs { F, C }
    A->>S: generate + store F input files
    A->>D: create Job(status=PENDING, submittedAt)
    A-->>U: 202 Accepted { jobId }

    P->>D: oldest PENDING while inFlight < k*W
    P->>Q: enqueue leaf tasks (chunks of <=5 files); job -> RUNNING

    loop until one partial remains (AWS scales workers 0..W)
        Q->>W: event source invokes worker with a task
        W->>S: stream <=5 inputs one at a time (files or partials)
        W->>W: fold each into acc (NumPy float64), release it; count += each count  (peak ~2*C)
        W->>S: write partial (sum_vector, count)
        W->>D: ADD reductionsRemaining -(c-1); ADD readyCount +1 (atomic, idempotent)
        alt reductionsRemaining > 0
            W->>Q: if >=5 ready (or tail): claim <=5, enqueue one merge task
        else reductionsRemaining == 0 (one partial left)
            W->>S: result.csv = sum_vector / total_count  (assert == F)
            W->>D: Job.status = COMPLETE; decrement inFlight
            W->>P: trigger dispatcher (capacity freed)
        end
    end

    U->>A: GET /jobs/:id (poll)
    A->>D: read status
    A-->>U: { status, resultUrl }
```

## Why this shape

- **Never reject + admission.** Submissions are accepted instantly as `PENDING` (202) and held in
  DynamoDB; the dispatcher releases them by capacity, so a started job runs fast instead of
  crawling behind newcomers, and the fleet is filled regardless of job size (ITD 6).
- **One queue, pull model.** Lambda's SQS event-source mapping polls for us and hands tasks to
  available concurrency (0..W); faster invocations naturally process more — emergent load
  balancing with no scheduler and no always-on poller (ITD 5).
- **Stateless workers.** All durable state lives in DynamoDB/S3, so concurrency `W` can change
  freely (the configurable-W bonus) and retries are safe.

## Multi-job concurrency

Every task carries its `jobId`. Counters are per-job in DynamoDB; partial vectors are
namespaced per-job in S3 (`s3://bucket/jobs/{jobId}/partials/...`). Nothing is global, so
concurrent jobs are independent. Admission (ITD 6) decides how many run at once: one big job fills
the fleet by itself (so it runs alone and finishes fast), while many tiny jobs are admitted
together to keep the fleet busy.
