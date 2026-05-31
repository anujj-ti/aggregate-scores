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
      int attempts
    }

    FLEET {
      string pk PK
      int inFlight
      int W
    }
```

## S3 object prefixes

```text
jobs/{jobId}/input/{fileIndex}.npy
jobs/{jobId}/partials/{seq_padded_8}.npz
jobs/{jobId}/result.csv
```
