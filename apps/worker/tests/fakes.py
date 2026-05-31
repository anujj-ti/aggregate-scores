"""In-memory test doubles for worker ports."""

from __future__ import annotations

from dataclasses import replace
from threading import Lock

import numpy as np
import numpy.typing as npt

from worker.contracts import InputKind
from worker.handler import WorkerHandler
from worker.models import InputVector, JobState, ReadyPartial, TaskPayload, TaskTransitionResult


class FakeBlobStore:
    """In-memory vectors keyed like S3 objects."""

    def __init__(self) -> None:
        self.file_vectors: dict[str, npt.NDArray[np.float64]] = {}
        self.partials: dict[str, tuple[npt.NDArray[np.float64], int, int]] = {}
        self.result_vectors: dict[str, npt.NDArray[np.float64]] = {}

    def put_input_file(self, *, key: str, vector: npt.NDArray[np.float64]) -> None:
        self.file_vectors[key] = np.asarray(vector, dtype=np.float64)

    def read_input(self, *, input_kind: InputKind, key: str, task_level: int) -> InputVector:
        if input_kind == InputKind.file:
            vector = self.file_vectors[key]
            return InputVector(key=key, vector=vector.copy(), count=1, level=task_level)
        vector, count, level = self.partials[key]
        return InputVector(key=key, vector=vector.copy(), count=count, level=level)

    def write_partial(
        self,
        *,
        partial_key: str,
        sum_vector: npt.NDArray[np.float64],
        count: int,
        level: int,
    ) -> None:
        self.partials[partial_key] = (np.asarray(sum_vector, dtype=np.float64).copy(), count, level)

    def write_result(self, *, result_key: str, vector: npt.NDArray[np.float64]) -> None:
        self.result_vectors[result_key] = np.asarray(vector, dtype=np.float64).copy()


class FakeJobStore:
    """Thread-safe in-memory job/ready counters."""

    def __init__(self) -> None:
        self._lock = Lock()
        self.jobs: dict[str, JobState] = {}
        self.ready_rows: dict[str, dict[int, ReadyPartial]] = {}
        self.complete_events: dict[str, int] = {}

    def seed_job(self, *, state: JobState) -> None:
        self.jobs[state.job_id] = state
        self.ready_rows[state.job_id] = {}
        self.complete_events[state.job_id] = 0

    def reserve_ready_seq(self, *, job_id: str, is_leaf: bool) -> int:
        with self._lock:
            state = self.jobs[job_id]
            state.ready_count += 1
            if is_leaf:
                state.leaf_tasks_done += 1
            return state.ready_count

    def put_ready_partial(
        self,
        *,
        job_id: str,
        seq: int,
        partial_key: str,
        count: int,
        level: int,
    ) -> None:
        self.ready_rows[job_id][seq] = ReadyPartial(
            seq=seq,
            partial_key=partial_key,
            count=count,
            level=level,
        )

    def apply_reductions(self, *, job_id: str, reductions_delta: int) -> int:
        with self._lock:
            state = self.jobs[job_id]
            state.reductions_remaining += reductions_delta
            return state.reductions_remaining

    def get_job(self, *, job_id: str) -> JobState:
        return replace(self.jobs[job_id])

    def claim_ready(self, *, job_id: str, count: int) -> list[ReadyPartial]:
        with self._lock:
            state = self.jobs[job_id]
            if state.claimed_count + count > state.ready_count:
                return []
            start = state.claimed_count + 1
            end = state.claimed_count + count
            state.claimed_count += count
            rows = self.ready_rows[job_id]
            return [rows[seq] for seq in range(start, end + 1)]

    def set_complete(self, *, job_id: str, result_key: str) -> None:
        state = self.jobs[job_id]
        state.status = "COMPLETE"
        state.result_key = result_key
        self.complete_events[job_id] += 1

    def set_failed(self, *, job_id: str, error: str) -> None:
        state = self.jobs[job_id]
        state.status = "FAILED"
        state.result_key = error


class FakeTaskStore:
    """In-memory task transitions."""

    def __init__(self) -> None:
        self._lock = Lock()
        self.status: dict[tuple[str, str], str] = {}
        self.partial_keys: dict[tuple[str, str], str] = {}
        self.failures: dict[tuple[str, str], str] = {}

    def mark_queued(self, *, task: TaskPayload) -> None:
        key = (task.job_id, task.task_id)
        with self._lock:
            self.status.setdefault(key, "QUEUED")

    def try_start(self, *, job_id: str, task_id: str) -> TaskTransitionResult:
        key = (job_id, task_id)
        with self._lock:
            current = self.status.get(key)
            if current == "DONE":
                return TaskTransitionResult.ALREADY_DONE
            if current in {"IN_PROGRESS", "FAILED"}:
                return TaskTransitionResult.ALREADY_DONE
            self.status[key] = "IN_PROGRESS"
            return TaskTransitionResult.STARTED

    def mark_done(self, *, job_id: str, task_id: str, partial_key: str | None) -> None:
        key = (job_id, task_id)
        with self._lock:
            self.status[key] = "DONE"
            if partial_key is None:
                self.partial_keys.pop(key, None)
            else:
                self.partial_keys[key] = partial_key

    def mark_failed(self, *, job_id: str, task_id: str, error: str) -> None:
        key = (job_id, task_id)
        with self._lock:
            self.status[key] = "FAILED"
            self.failures[key] = error


class FakeWorkQueue:
    """Captures enqueued follow-up tasks for assertions."""

    def __init__(self) -> None:
        self.tasks: list[TaskPayload] = []

    def enqueue(self, *, task: TaskPayload) -> None:
        self.tasks.append(task)


class FakeFleetCounter:
    """Simple counter for in-flight task updates."""

    def __init__(self) -> None:
        self.total = 0

    def add(self, *, delta: int) -> None:
        self.total += delta


def seeded_job(
    *,
    job_id: str,
    f: int,
    c: int,
    chunk_size_used: int = 5,
    reductions_remaining: int = 0,
    leaf_tasks_total: int = 1,
    leaf_tasks_done: int = 0,
    ready_count: int = 0,
    claimed_count: int = 0,
) -> JobState:
    """Create a mutable job state fixture."""
    return JobState(
        job_id=job_id,
        f=f,
        c=c,
        chunk_size_used=chunk_size_used,
        reductions_remaining=reductions_remaining,
        ready_count=ready_count,
        claimed_count=claimed_count,
        leaf_tasks_total=leaf_tasks_total,
        leaf_tasks_done=leaf_tasks_done,
    )


def make_handler_stack(
    *,
    job: JobState,
) -> tuple[
    WorkerHandler,
    FakeBlobStore,
    FakeJobStore,
    FakeTaskStore,
    FakeWorkQueue,
    FakeFleetCounter,
]:
    """Build a WorkerHandler with all fake dependencies."""

    blob = FakeBlobStore()
    jobs = FakeJobStore()
    jobs.seed_job(state=job)
    tasks = FakeTaskStore()
    queue = FakeWorkQueue()
    fleet = FakeFleetCounter()
    handler = WorkerHandler(
        blob_store=blob,
        job_store=jobs,
        task_store=tasks,
        work_queue=queue,
        fleet_counter=fleet,
        chunk_size=job.chunk_size_used,
    )
    return handler, blob, jobs, tasks, queue, fleet
