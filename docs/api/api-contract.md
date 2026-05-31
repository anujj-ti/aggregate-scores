# API Contract

REST contract for the backend surface. DTO names and field constraints come from
`packages/shared/src/contracts/api.ts` and `packages/shared/src/contracts/messages.ts`.

## Rules that apply to all endpoints

- The API validates all external input with zod schemas from `@aggregate/shared`.
- Submissions are never rejected for load; `POST /jobs` always returns `202` once input is valid.
  The job starts in `GENERATING` while inputs are written to S3 in the background, then becomes
  `PENDING`. Backpressure (admission) is represented by `PENDING` queueing in DynamoDB.
- `resultUrl` is a presigned S3 URL and is present only when a job is `COMPLETE`.
- Progress (`percent`) reports leaf-task progress: `percent = leafTasksDone / leafTasksTotal`
  (forced to `1` when `COMPLETE`). The merge phase is tracked separately by `reductionsRemaining`,
  which counts down from `ceil(F / chunkSizeUsed) - 1` to `0`.
- Job math uses an immutable per-job config snapshot (`chunkSizeUsed`): global config changes apply
  only to new jobs, not in-flight jobs.

## Endpoint summary

| Method | Path | Request | Success | Errors |
|--------|------|---------|---------|--------|
| `POST` | `/jobs` | `CreateJobRequest` | `202 CreateJobResponse` | `400` invalid payload |
| `GET` | `/jobs/:id` | — | `200 JobView` | `404` job not found |
| `GET` | `/jobs` | `status?`, `limit?` | `200 JobView[]` | `400` invalid query |
| `GET` | `/jobs/:id/inputs/:fileIndex` | — | `200` (`.npy` bytes) | `400` bad index; `404` not available; `409` still `GENERATING` |
| `GET` | `/jobs/:id/archive` | — | `200` (`.zip` stream) | `404` job not found; `409` still `GENERATING` |
| `DELETE` | `/jobs/:id` | — | `200 { cancelled: true }` | `404` job not found; `409` job already terminal |
| `GET` | `/fleet` | — | `200 FleetView` | — |
| `POST` | `/workers` | `SetWorkersRequest` | `200 FleetView` | `400` invalid count |

## POST /jobs

Create and enqueue a new mean-computation job.

### Request body (`CreateJobRequest`)

```json
{
  "F": 20000,
  "C": 10000,
  "reuseSampleFile": false
}
```

- `F`: integer, `>= 1` (file count)
- `C`: integer, `>= 1` (values per file)
- `reuseSampleFile`: boolean, optional (default `false`). When `true`, one random vector is generated
  and copied to all `F` input keys (test/demo speedup — generation is near-instant and the mean equals
  that single vector, so results stay trivially verifiable). When `false`, `F` independent random
  vectors are generated in parallel.

> **Multiple submissions (`freq`)** are a frontend convenience only: the Submit form can POST the same
> body N times to create N independent jobs. There is no `freq` field in the API contract — each job
> is a separate `POST /jobs`.

### Response (`202 CreateJobResponse`)

```json
{
  "jobId": "job_2f761ba4"
}
```

### Side effects

- Persist `Jobs` item with `status=GENERATING`, `submittedAt`, `reuseSampleFile`, and zeroed counters; return `202` immediately.
- In the background (off the request/dispatcher path): generate `F` input files under
  `jobs/{jobId}/input/`, then conditionally transition the job `GENERATING → PENDING`.
- Once `PENDING`, trigger the dispatcher admission check. If generation fails, the job goes `FAILED`.

## GET /jobs/:id

Read one job view.

### Response (`200 JobView`)

```json
{
  "jobId": "job_2f761ba4",
  "status": "RUNNING",
  "F": 20000,
  "C": 10000,
  "reuseSampleFile": false,
  "submittedAt": 1769589702123,
  "percent": 0.61,
  "reductionsRemaining": 7799,
  "queuePosition": 2,
  "chunkSizeUsed": 5,
  "leafTasksTotal": 4000,
  "leafTasksDone": 4000,
  "readyCount": 4200,
  "claimedCount": 4180,
  "taskSummary": {
    "queued": 12,
    "inProgress": 5,
    "done": 8180,
    "failed": 0,
    "total": 8197,
    "byLevel": [
      { "level": 0, "queued": 0, "inProgress": 0, "done": 4000, "failed": 0, "total": 4000 },
      { "level": 1, "queued": 12, "inProgress": 5, "done": 4180, "failed": 0, "total": 4197 }
    ]
  },
  "taskDetails": [
    {
      "taskId": "job_2f761ba4#leaf#0",
      "kind": "leaf",
      "level": 0,
      "status": "DONE",
      "inputKind": "file",
      "inputKeys": ["jobs/job_2f761ba4/input/0.npy", "..."],
      "attempts": 1,
      "partialKey": "jobs/job_2f761ba4/partials/00000001.npz"
    }
  ],
  "taskDetailsTruncated": false,
  "taskDetailsLimit": 300,
  "inputManifestPreview": [
    {
      "fileIndex": 0,
      "inputKey": "jobs/job_2f761ba4/input/0.npy",
      "plannedLeafTaskId": "job_2f761ba4#leaf#0",
      "plannedLeafLevel": 0
    }
  ],
  "resultUrl": "https://...",
  "error": "..."
}
```

Notes:

- `queuePosition` appears only while `status=PENDING`.
- `resultUrl` appears only while `status=COMPLETE`.
- `error` appears only while `status=FAILED`.
- `percent` is `leafTasksDone / leafTasksTotal` (leaf progress); it can read `1.0` while a final
  merge is still in flight — `reductionsRemaining == 0` is the true completion signal.
- Diagnostics fields (`chunkSizeUsed`, `leafTasksTotal`, `leafTasksDone`, `readyCount`,
  `claimedCount`, `taskSummary`, `taskDetails`, `inputManifestPreview`) are populated on the
  single-job endpoint to drive the job-detail page. `GET /jobs` (list) omits `taskSummary`/
  `taskDetails` for cost.
- `taskSummary.byLevel` gives per-level QUEUED/IN_PROGRESS/DONE/FAILED counts; `taskDetails` is the
  per-task lineage (which inputs produced which partial), bounded by `taskDetailsLimit` with
  `taskDetailsTruncated` set when the cap is hit.
- `inputManifestPreview` is **derived** (not stored): a bounded `fileIndex → inputKey →
  plannedLeafTaskId` mapping the operator can download as CSV to verify inputs against the result.

## GET /jobs

List jobs, optionally filtered by status.

### Query params

- `status` (optional): one of `GENERATING|PENDING|RUNNING|COMPLETE|FAILED|CANCELLED`
- `limit` (optional): integer > 0, server-capped

### Response (`200 JobView[]`)

Returns jobs ordered by newest `submittedAt` unless otherwise documented by implementation.

## GET /jobs/:id/inputs/:fileIndex

Download a single input file as raw `.npy` bytes (`Content-Type: application/octet-stream`).
Useful for verification — especially with `reuseSampleFile=true`, where one input represents all of
them. Returns `409` while the job is still `GENERATING`, `400` if `fileIndex` is out of range
(`>= F`), and `404` if the object is not available.

## GET /jobs/:id/archive

Stream a `.zip` (`Content-Type: application/zip`) bundling the job's input `.npy` files plus
`result.csv` (when `COMPLETE`) and a `MANIFEST.txt`. The input list is capped (first 500) to keep the
archive bounded; missing/not-yet-written objects are skipped and noted in the manifest. Returns `409`
while the job is still `GENERATING`.

## DELETE /jobs/:id

Cancel a job. This is a **soft cancel**: the job row is kept and its status becomes `CANCELLED`
(it is never deleted), so history and diagnostics remain visible. Allowed while the job is
`GENERATING`, `PENDING`, or `RUNNING`. A `RUNNING` job is stopped best-effort — workers re-read status and skip
finalizing / enqueuing follow-up merges for a cancelled job (an already-executing task may finish),
and each in-flight task still releases its capacity slot.

### Response (`200`)

```json
{
  "cancelled": true
}
```

### Conflict (`409`)

Returned when the job is already terminal (`COMPLETE`, `FAILED`, or `CANCELLED`).

## GET /fleet

Read worker-capacity view.

### Response (`200 FleetView`)

```json
{
  "W": 5,
  "inFlight": 4,
  "free": 1
}
```

- `inFlight` is the count of **admitted tasks**, not busy workers. Because admission targets `k·W`,
  `inFlight` can exceed `W`, so raw `free = W - inFlight` can be **negative**. The dashboard does not
  display the raw value; it derives operator-facing numbers: `busyWorkers = min(W, inFlight)`,
  `idleWorkers = max(0, W - busyWorkers)`, `bufferedTasks = max(0, inFlight - W)`.

## POST /workers

Update reserved worker concurrency (`W`).

This endpoint changes capacity only (how many workers can run concurrently). It does **not** rewrite
in-flight job partition math (`chunkSizeUsed`, `leafTasksTotal`, `reductionsRemaining`).

### Request body (`SetWorkersRequest`)

```json
{
  "count": 8
}
```

### Response (`200 FleetView`)

```json
{
  "W": 8,
  "inFlight": 3,
  "free": 5
}
```

`count` must satisfy API policy bounds (`0 <= count <= MAX_W`).
