# API Contract

REST contract for the backend surface. DTO names and field constraints come from
`packages/shared/src/contracts/api.ts` and `packages/shared/src/contracts/messages.ts`.

## Rules that apply to all endpoints

- The API validates all external input with zod schemas from `@aggregate/shared`.
- Submissions are never rejected for load; `POST /jobs` always returns `202` once input is valid.
  Backpressure is represented by `PENDING` queueing in DynamoDB.
- `resultUrl` is a presigned S3 URL and is present only when a job is `COMPLETE`.
- Progress uses `reductionsRemaining`:  
  `percent = 1 - reductionsRemaining / (ceil(F / CHUNK_SIZE) - 1)` for `F > CHUNK_SIZE`.
- Job math uses an immutable per-job config snapshot (`chunkSizeUsed`): global config changes apply
  only to new jobs, not in-flight jobs.

## Endpoint summary

| Method | Path | Request | Success | Errors |
|--------|------|---------|---------|--------|
| `POST` | `/jobs` | `CreateJobRequest` | `202 CreateJobResponse` | `400` invalid payload |
| `GET` | `/jobs/:id` | — | `200 JobView` | `404` job not found |
| `GET` | `/jobs` | `status?`, `limit?` | `200 JobView[]` | `400` invalid query |
| `DELETE` | `/jobs/:id` | — | `200 { cancelled: true }` | `404` job not found; `409` job not cancellable |
| `GET` | `/fleet` | — | `200 FleetView` | — |
| `POST` | `/workers` | `SetWorkersRequest` | `200 FleetView` | `400` invalid count |

## POST /jobs

Create and enqueue a new mean-computation job.

### Request body (`CreateJobRequest`)

```json
{
  "F": 20000,
  "C": 10000
}
```

- `F`: integer, `>= 1` (file count)
- `C`: integer, `>= 1` (values per file)

### Response (`202 CreateJobResponse`)

```json
{
  "jobId": "job_2f761ba4"
}
```

### Side effects

- Generate `F` input files under `jobs/{jobId}/input/`.
- Persist `Jobs` item with `status=PENDING`, `submittedAt`, and merge counters.
- Trigger dispatcher admission check.

## GET /jobs/:id

Read one job view.

### Response (`200 JobView`)

```json
{
  "jobId": "job_2f761ba4",
  "status": "RUNNING",
  "F": 20000,
  "C": 10000,
  "submittedAt": 1769589702123,
  "percent": 0.61,
  "reductionsRemaining": 7799,
  "queuePosition": 2,
  "resultUrl": "https://...",
  "error": "..."
}
```

Notes:

- `queuePosition` appears only while `status=PENDING`.
- `resultUrl` appears only while `status=COMPLETE`.
- `error` appears only while `status=FAILED`.

## GET /jobs

List jobs, optionally filtered by status.

### Query params

- `status` (optional): one of `PENDING|RUNNING|COMPLETE|FAILED`
- `limit` (optional): integer > 0, server-capped

### Response (`200 JobView[]`)

Returns jobs ordered by newest `submittedAt` unless otherwise documented by implementation.

## DELETE /jobs/:id

Cancel a job before it is admitted.

### Response (`200`)

```json
{
  "cancelled": true
}
```

### Conflict (`409`)

Returned when the job is already `RUNNING`, `COMPLETE`, or `FAILED`.

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
