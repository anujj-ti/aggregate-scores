# Detailed Architecture & Data Flow

A visual, end-to-end picture of the system: every component, the exact data that moves between them,
the **formats** on the wire and in storage, the input **generation** path (including the
`reuseSampleFile` flag), the **streaming** reads inside a worker, and the **eager-merge** reduction
tree. Status semantics live in [lifecycle.md](../architecture/lifecycle.md); storage details in
[database.md](../architecture/database.md); this doc is the "how the bytes flow" view.

---

## 1. System architecture (what flows, in what format)

```mermaid
flowchart TB
    subgraph client["Operator UI (Next.js)"]
        UI["Dashboard · Submit form · Job detail · Architecture"]
    end

    subgraph api["API + Dispatcher (Node / Express / TypeScript)"]
        API["API handlers<br/>POST /jobs · GET /jobs/:id · /fleet · /workers"]
        GEN["Generator<br/>(background input materialization)"]
        DISP["Dispatcher<br/>capacity-based admission"]
    end

    QUEUE[["SQS work queue<br/>message = MergeTask JSON (keys, not bytes)"]]
    DLQ[["Dead-letter queue<br/>poison / crashed messages"]]

    subgraph workers["Worker fleet (Python · Lambda / local process)"]
        WK["Worker<br/>stream inputs → float64 accumulate → write partial"]
    end

    subgraph ddb["DynamoDB — coordination state (no vectors)"]
        JOBS["Jobs: status, F, C, reuseSampleFile,<br/>chunkSizeUsed, counters, resultKey"]
        READY["Ready: seq → partialKey, count, level"]
        TASKS["Tasks: status, inputKeys, partialKey (observability)"]
        FLEET["Fleet: inFlight, W"]
    end

    subgraph s3["S3 — bulk numeric data"]
        IN["input/*.npy — float32, C values in 0..1"]
        PART["partials/*.npz — float64 sum_vector + int count"]
        RES["result.csv — float64 means"]
    end

    UI -->|"HTTPS JSON"| API
    API -->|"create job status=GENERATING"| JOBS
    API -.->|"kick off (background)"| GEN
    GEN -->|"write F files"| IN
    GEN -->|"mark status=PENDING"| JOBS
    GEN -.->|"nudge"| DISP

    DISP -->|"admit oldest PENDING while inFlight < k*W"| JOBS
    DISP -->|"enqueue ceil(F/5) leaf tasks"| QUEUE
    DISP -->|"ADD inFlight + leafTasksTotal"| FLEET

    QUEUE -->|"deliver (event-source mapping)"| WK
    QUEUE -. "maxReceiveCount exceeded" .-> DLQ
    WK -->|"stream reads"| IN
    WK -->|"read claimed partials"| PART
    WK -->|"write new partial"| PART
    WK -->|"write result (finalize)"| RES
    WK -->|"readyCount+1 · reductions · claim CAS · DONE"| JOBS
    WK -->|"register partial seq"| READY
    WK -->|"task status"| TASKS
    WK -->|"ADD inFlight -1 · enqueue follow-up merge"| FLEET
    WK -->|"enqueue merge of claimed partials"| QUEUE

    API -->|"read status / progress"| JOBS
    API -->|"presign / stream"| RES
    API -->|"download one input / zip"| IN
```

> **Key idea:** DynamoDB never holds numeric vectors — only *state and pointers*. All bulk float data
> lives in S3. SQS messages carry **S3 keys, not bytes** (≤256 KB cap), so a task referencing 5 large
> files is still a tiny message.

---

## 2. Input generation (with the `reuseSampleFile` flag)

Generation is our local stand-in for a user upload. It runs **in the background** after `POST /jobs`
returns `202`, off the dispatcher's critical path, so the worker fleet never idles waiting on file
creation and small jobs don't queue behind a big job's generation.

```mermaid
flowchart TD
    A["POST /jobs {F, C, reuseSampleFile?}"] --> B["Persist Jobs row<br/>status = GENERATING"]
    B --> C["Return 202 {jobId}"]
    B --> D{"reuseSampleFile?"}

    D -- "true (test/demo)" --> E["Generate ONE random<br/>float32 vector (length C)"]
    E --> F["Copy identical bytes to<br/>all F keys input/0.npy … input/F-1.npy"]

    D -- "false (default)" --> G["Generate F INDEPENDENT<br/>float32 vectors in parallel<br/>(bounded concurrency)"]
    G --> H["Write F distinct files<br/>input/0.npy … input/F-1.npy"]

    F --> I{"all F written?"}
    H --> I
    I -- "yes" --> J["Conditional SET status = PENDING<br/>(no-op if already CANCELLED)"]
    I -- "error" --> K["SET status = FAILED, error"]
    J --> L["Nudge dispatcher → admission"]
```

| `reuseSampleFile` | What is written | Why | Result property |
|-------------------|-----------------|-----|-----------------|
| `true` | One random vector, byte-copied to all `F` inputs | Near-instant generation; fast demo / verification | Mean equals that single vector (trivially checkable) |
| `false` / absent | `F` independent random vectors, written in parallel | Realistic distinct-input workload | Mean is the true element-wise average |

> **`freq` is frontend-only:** the Submit form can POST the same body N times to create N independent
> jobs. There is no `freq` field in the API — each submission is a separate `POST /jobs`.

---

## 3. Inside one worker step (stream → accumulate → write)

Every task — leaf or merge — is the **same operation**: fold ≤5 inputs into one `(sum_vector, count)`
partial. Inputs are **streamed one at a time** into a single float64 accumulator, so peak memory is
~2 vectors regardless of how many values each file holds.

```mermaid
flowchart TD
    S["Receive MergeTask<br/>(inputKind, ≤5 inputKeys, C, level)"] --> T["mark_queued → try_start<br/>QUEUED → IN_PROGRESS"]
    T --> AD{"already DONE?"}
    AD -- "yes (redelivery)" --> Z0["return — no side effects (idempotent)"]
    AD -- "no" --> CK{"job CANCELLED?"}
    CK -- "yes" --> Z1["mark done(empty) · release in-flight · stop"]
    CK -- "no" --> ACC["acc = zeros(C, float64); count = 0"]

    ACC --> LOOP["for each inputKey (streamed):"]
    LOOP --> R{"inputKind"}
    R -- "file (leaf)" --> RF["read input/*.npy (float32)<br/>→ cast to float64"]
    R -- "partial (merge)" --> RP["read partials/*.npz<br/>(float64 sum_vector + count)"]
    RF --> ADDV["acc += vector · count += 1"]
    RP --> ADDV2["acc += sum_vector · count += partial.count"]
    ADDV --> LOOP
    ADDV2 --> LOOP

    LOOP --> SEQ["reserve_ready_seq → ADD readyCount +1<br/>(leaf also ADD leafTasksDone +1)"]
    SEQ --> WP["write partials/{seq:08d}.npz<br/>{ sum_vector: float64[C], count }"]
    WP --> RR["apply reductions:<br/>merge ADD reductionsRemaining -(c-1); leaf delta 0"]
    RR --> FIN{"reductionsRemaining == 0?"}
    FIN -- "yes" --> AVG["FINALIZE: assert count == F<br/>result = sum_vector / count<br/>write result.csv · status = COMPLETE"]
    FIN -- "no" --> EM["maybe enqueue follow-up merge<br/>(see eager merge below)"]
    AVG --> DONE["mark task DONE · ADD inFlight -1"]
    EM --> DONE
```

- **Leaf step** reads raw `.npy` files (`float32`), casts to `float64`, sums → a partial of `count = #files`.
- **Merge step** reads claimed `.npz` partials (`float64`), adds their `sum_vector`s and `count`s.
- **Finalize** is just the last merge that drives `reductionsRemaining` to `0`: divide `sum_vector` by
  `count`, assert `count == F`, write `result.csv`. **No separate aggregator service.**

---

## 4. Eager merge — the reduction tree (no level barrier)

Each produced partial joins a per-job **ready pool**. The instant ≥5 unclaimed partials exist (or, once
all leaves are done, ≥2 remain as a tail), a worker atomically **claims up to `min(available, 5)`** and
enqueues one merge over them. Workers never wait for a whole tree "level" to drain.

```mermaid
flowchart TD
    subgraph leaves["Leaf tasks — read files (level 0)"]
        L0["leaf#0<br/>files 0-4"]
        L1["leaf#1<br/>files 5-9"]
        L2["leaf#2<br/>files 10-14"]
        L3["leaf#3<br/>files 15-19"]
        L4["leaf#4<br/>files 20-24"]
        L5["leaf#5<br/>files 25-29"]
    end

    POOL(["Ready pool<br/>readyCount / claimedCount"])
    L0 --> POOL
    L1 --> POOL
    L2 --> POOL
    L3 --> POOL
    L4 --> POOL
    L5 --> POOL

    POOL -->|"claim 5 partials (CAS)"| M0["merge#a (level 1)<br/>partials of leaf 0-4"]
    POOL -->|"tail: claim 2 (leaf#5 + merge#a out)"| M1["merge#b (level 2) — FINALIZE"]
    M0 --> POOL
    M1 --> RES["result.csv = sum_vector / count<br/>(count == F = 30 ✓)"]
```

**Completion is one counter, not per-level bookkeeping.** Reducing `N` leaf partials to one always
takes `N − 1` reductions regardless of grouping, so `reductionsRemaining` starts at
`ceil(F / chunkSizeUsed) − 1` and each `c`-input merge subtracts `c − 1`. When it hits `0`, one partial
remains and that worker finalizes.

```mermaid
flowchart LR
    INIT["reductionsRemaining<br/>= ceil(F/5) - 1 = 5"] -->|"merge of 5: -4"| S1["1"]
    S1 -->|"merge of 2: -1"| S2["0 → finalize"]
```

---

## 5. Data formats & S3 layout

```text
s3://aggregate-scores-{env}/
└── jobs/{jobId}/
    ├── input/
    │   ├── 0.npy        # float32, C values in [0,1]   (bulk — read by leaf tasks)
    │   ├── 1.npy
    │   └── ... (F files)
    ├── partials/
    │   ├── 00000000.npz # { sum_vector: float64[C], count: int } — named by ready seq
    │   ├── 00000001.npz # leaf + merge outputs share one flat namespace
    │   └── ...
    └── result.csv       # float64 per-index means (one row)
```

| Data | Format | dtype | Read/written by | Why this format |
|------|--------|-------|-----------------|-----------------|
| Input files | `.npy` | **float32** | Generator writes · leaf tasks stream-read | Values in `[0,1]` need ~7 sig digits; float32 halves S3 cost/transfer |
| Partials | `.npz` | **float64** | Worker writes · merge tasks read | Bundles `sum_vector` + `count` so finalize can assert `Σcount == F`; few partials ⇒ cost negligible |
| Result | `.csv` | **float64** | Worker writes (finalize) · API presigns/streams | Human-readable final means; downloaded by the operator |
| Queue message | JSON (`MergeTask`) | — | Dispatcher / worker enqueue · worker reads | Carries **keys not bytes** (≤256 KB SQS cap) |

> **dtype rule:** float64 only where it buys precision (accumulate / partials / result); float32 where
> it buys cost/speed (bulk inputs). With inputs in `[0,1]`, the max sum is ~`10⁵` — no overflow risk.

---

## 6. Entity-relationship model (DynamoDB + S3)

DynamoDB holds the coordination entities (`Jobs`, `Ready`, `Tasks`, `Fleet`); S3 holds the bulk objects
(`RESULT`, `PARTIAL`, and per-file inputs). Relationships are by `jobId` (and `seq`/`taskId`), not
foreign keys — DynamoDB is keyed access. See [database.md](../architecture/database.md) for the full
attribute notes and access patterns.

```mermaid
erDiagram
    JOBS ||--o{ TASKS : "has many (leaf + merge)"
    JOBS ||--o{ READY : "tracks ready-partial pool"
    JOBS ||--|| RESULT : "produces one (S3)"
    JOBS ||--o{ INPUT : "owns F input files (S3)"
    TASKS ||--|| PARTIAL : "writes one (S3)"
    READY ||--|| PARTIAL : "points at one (S3)"
    FLEET ||--o{ JOBS : "gates admission of"

    JOBS {
      string jobId PK "job_{uuid}"
      string status "GENERATING|PENDING|RUNNING|COMPLETE|FAILED|CANCELLED"
      int submittedAt "epoch ms; GSI sort (admit oldest first)"
      int F "file count"
      int C "values per file"
      bool reuseSampleFile "true = one vector copied to all F inputs"
      int chunkSizeUsed "immutable per-job snapshot (default CHUNK_SIZE=5)"
      int leafTasksTotal "ceil(F/chunkSizeUsed); set at admission"
      int leafTasksDone "ADD +1 per completed leaf"
      int reductionsRemaining "init leafTasksTotal-1; merge ADD -(c-1); 0 => finalize"
      int readyCount "partials produced (assigns seq)"
      int claimedCount "partials pulled into merges (claim CAS)"
      string resultKey "S3 key of result.csv (on finalize)"
      string error "set on FAILED"
    }

    READY {
      string jobId PK
      int seq SK "value of readyCount when registered"
      string partialKey "S3 key of the (sum_vector,count) partial"
      int count "files represented by this partial"
      int level "tree depth; observability"
    }

    TASKS {
      string jobId PK
      string taskId SK "#{kind}#{idx}, e.g. job_x#leaf#0"
      string kind "leaf | merge"
      string inputKind "file | partial"
      int level "leaf=0, merge=max(input levels)+1; observability"
      string status "QUEUED|IN_PROGRESS|DONE|FAILED"
      list inputKeys "<=5 S3 keys"
      string partialKey "S3 key produced (on DONE)"
      string error "compact failure msg (on FAILED)"
      int attempts "DLQ correlation"
    }

    FLEET {
      string pk PK "singleton: FLEET"
      int inFlight "admitted tasks not yet finished; clamped >= 0 on read"
      int W "reserved worker concurrency (admission target k*W)"
    }

    INPUT {
      string key PK "jobs/{jobId}/input/{i}.npy"
      string dtype "float32, C values in 0..1"
    }

    PARTIAL {
      string key PK "jobs/{jobId}/partials/{seq:08d}.npz"
      string sum_vector "float64[C]"
      int count "files summed"
      int level "tree depth"
    }

    RESULT {
      string key PK "jobs/{jobId}/result.csv"
      string means "float64[C] = sum_vector / count"
    }
```

**How to read it:**

- A `JOBS` row fans out to many `TASKS` (one per ≤5-input leaf/merge) and many `READY` rows (one per
  produced partial); it owns its `F` `INPUT` objects and produces exactly one `RESULT`.
- Each `TASKS` row and each `READY` row points at exactly one `PARTIAL` object in S3 — `READY.seq`
  is the link the claimer uses to fetch the right partials (`seq → partialKey`).
- `FLEET` is a single global row (not per-job); it gates which `JOBS` get admitted via the `k·W`
  in-flight target.
- **Solid stores** (`JOBS`/`READY`/`TASKS`/`FLEET`) live in DynamoDB; **object entities**
  (`INPUT`/`PARTIAL`/`RESULT`) live in S3. DynamoDB never stores the numeric vectors — only the keys.

---

## 7. Failure & idempotency at a glance

```mermaid
flowchart TD
    DEL["SQS delivers task (at-least-once)"] --> TS["try_start (conditional)"]
    TS -->|"already DONE/FAILED"| SKIP["return early → message deleted<br/>(no double count)"]
    TS -->|"fresh"| RUN["process"]
    RUN -->|"success"| OK["DONE · message auto-deleted"]
    RUN -->|"exception"| F1["task FAILED · job FAILED · re-raise<br/>(message redelivered, then skipped)"]
    RUN -. "crash / timeout before set_failed" .-> RETRY["redelivered up to maxReceiveCount"]
    RETRY --> DLQ["dead-letter queue (inspection)"]
```

- **Redelivery is safe:** the task-row state machine (`try_start`) short-circuits anything already
  `DONE`/`FAILED`, so `reductionsRemaining` is never decremented twice and partial keys (deterministic
  given a reserved `seq`) overwrite identically.
- **Disjoint claims:** the claim is a compare-and-swap on `claimedCount`, so two merges never consume
  the same partials.
- **Fail-closed:** if a future multi-worker setup reads a `seq` whose `Ready` row isn't durable yet,
  `claim_ready` raises `ReadyPoolConsistencyError` and the job fails loudly rather than averaging a
  short input set.

---

See also: [system-design.md](../architecture/system-design.md) ·
[job-splitting.md](../architecture/job-splitting.md) ·
[aggregation.md](../architecture/aggregation.md) ·
[lifecycle.md](../architecture/lifecycle.md) ·
[database.md](../architecture/database.md) ·
[interview-guide.md](../interview-guide.md)
