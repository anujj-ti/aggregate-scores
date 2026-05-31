# ER Diagram

Consolidated data model for job state, task state, ready-partial registry, and object storage layout.

```mermaid
erDiagram
    JOBS ||--o{ TASKS : has_many
    JOBS ||--o{ READY : has_many
    JOBS ||--|| RESULT : produces
    TASKS ||--|| PARTIAL : writes
    FLEET ||--o{ JOBS : gates_admission_of

    JOBS {
      string jobId PK
      string status
      int submittedAt
      int F
      int C
      bool reuseSampleFile
      int chunkSizeUsed
      int leafTasksTotal
      int leafTasksDone
      int reductionsRemaining
      int readyCount
      int claimedCount
      string resultKey
      string error
    }

    READY {
      string jobId PK
      int seq SK
      string partialKey
      int count
      int level
    }

    TASKS {
      string jobId PK
      string taskId SK
      string kind
      int level
      string status
      string[] inputKeys
      string partialKey
      string error
      int attempts
    }

    FLEET {
      string pk PK
      int inFlight
      int W
    }
```

## Enumerations

- `JOBS.status`: `GENERATING | PENDING | RUNNING | COMPLETE | FAILED | CANCELLED`
  - `GENERATING` is the initial status while input files are being written to S3 in the background; the job becomes `PENDING` (admittable) only once they exist.
  - `CANCELLED` is a terminal status set by an operator cancel (soft cancel; the row is **kept**, never deleted — see [lifecycle.md](../architecture/lifecycle.md)).
- `TASKS.status`: `QUEUED | IN_PROGRESS | DONE | FAILED`.
- `TASKS.kind`: `leaf | merge`; `TASKS.inputKind` (in the queue message): `file | partial`.

## Field notes

- `TASKS.partialKey` — S3 key of the `(sum_vector, count)` partial this task produced (set on `DONE`); consumed by downstream merge tasks and used for debugging which inputs produced which partial.
- `TASKS.error` — compact failure message (set on `FAILED`), surfaced for debugging.
- `JOBS.reuseSampleFile` — input-generation mode flag (test/demo speedup). `true` ⇒ one random vector was copied to all F inputs (byte-identical, so the mean equals that single vector); `false`/absent ⇒ F independent random vectors.
- `FLEET.inFlight` — count of **admitted tasks** (enqueued leaves + enqueued follow-up merges) that have not finished. It is incremented when a task is enqueued (dispatcher for leaves, worker for follow-up merges) and decremented exactly once when a task finishes, so it returns to `0` when a job reaches a terminal state. Reads clamp a negative value back to `0` as a fail-safe.

## S3 object prefixes

```text
jobs/{jobId}/input/{fileIndex}.npy
jobs/{jobId}/partials/{seq_padded_8}.npz
jobs/{jobId}/result.csv
```
