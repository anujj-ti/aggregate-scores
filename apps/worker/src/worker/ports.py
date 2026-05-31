"""Ports for worker orchestration (hexagonal architecture)."""

from __future__ import annotations

from typing import Protocol

import numpy as np
import numpy.typing as npt

from worker.contracts import InputKind
from worker.models import InputVector, JobState, ReadyPartial, TaskPayload, TaskTransitionResult


class BlobStore(Protocol):
    """Blob storage operations for inputs, partials, and final output."""

    def read_input(self, *, input_kind: InputKind, key: str, task_level: int) -> InputVector:
        """Load one input vector and metadata from blob storage."""

    def write_partial(
        self,
        *,
        partial_key: str,
        sum_vector: npt.NDArray[np.float64],
        count: int,
        level: int,
    ) -> None:
        """Write one partial bundle to storage."""

    def write_result(self, *, result_key: str, vector: npt.NDArray[np.float64]) -> None:
        """Write final result vector as CSV."""


class JobStore(Protocol):
    """Job coordination state operations in DynamoDB."""

    def reserve_ready_seq(self, *, job_id: str, is_leaf: bool) -> int:
        """Atomically increment ready counters and return assigned sequence."""

    def put_ready_partial(
        self,
        *,
        job_id: str,
        seq: int,
        partial_key: str,
        count: int,
        level: int,
    ) -> None:
        """Persist ready pool row for a produced partial."""

    def apply_reductions(self, *, job_id: str, reductions_delta: int) -> int:
        """Atomically add reductions delta and return new remaining count."""

    def get_job(self, *, job_id: str) -> JobState:
        """Load current job counters needed for claim/finalize decisions."""

    def claim_ready(self, *, job_id: str, count: int) -> list[ReadyPartial]:
        """Conditionally claim a disjoint ready range and return claimed rows."""

    def set_complete(self, *, job_id: str, result_key: str) -> None:
        """Set job status COMPLETE and persist result pointer."""

    def set_failed(self, *, job_id: str, error: str) -> None:
        """Set job status FAILED and persist a compact error message."""


class TaskStore(Protocol):
    """Task state transitions used for idempotency and observability."""

    def mark_queued(self, *, task: TaskPayload) -> None:
        """Ensure task row exists in QUEUED state."""

    def try_start(self, *, job_id: str, task_id: str) -> TaskTransitionResult:
        """Move task to IN_PROGRESS once; repeated deliveries return ALREADY_DONE."""

    def mark_done(self, *, job_id: str, task_id: str, partial_key: str) -> None:
        """Move task to DONE and record output partial key."""

    def mark_failed(self, *, job_id: str, task_id: str, error: str) -> None:
        """Move task to FAILED for diagnostics."""


class WorkQueue(Protocol):
    """Queue operations for scheduling follow-up merge tasks."""

    def enqueue(self, *, task: TaskPayload) -> None:
        """Publish one merge task."""


class FleetCounter(Protocol):
    """In-flight counter updates for observability/admission signals."""

    def add(self, *, delta: int) -> None:
        """Atomically add delta to inFlight counter."""
