"""Domain models for worker orchestration."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

import numpy as np
import numpy.typing as npt

from worker.contracts import InputKind, MergeTask


class TaskTransitionResult(StrEnum):
    """Result of trying to move a task into IN_PROGRESS."""

    STARTED = "STARTED"
    ALREADY_DONE = "ALREADY_DONE"


@dataclass(frozen=True)
class TaskPayload:
    """Normalized queue payload used inside the worker."""

    job_id: str
    task_id: str
    input_kind: InputKind
    level: int
    input_keys: list[str]
    c: int

    @classmethod
    def from_contract(cls, payload: MergeTask) -> TaskPayload:
        """Normalize generated contract model to domain primitives."""
        keys = [entry.root for entry in payload.inputKeys]
        return cls(
            job_id=payload.jobId,
            task_id=payload.taskId,
            input_kind=payload.inputKind,
            level=payload.level,
            input_keys=keys,
            c=payload.C,
        )


@dataclass(frozen=True)
class InputVector:
    """One merge input materialized from storage."""

    key: str
    vector: npt.NDArray[np.float64]
    count: int
    level: int


@dataclass(frozen=True)
class MergedPartial:
    """Output of combining a task's input vectors."""

    sum_vector: npt.NDArray[np.float64]
    count: int
    max_input_level: int


@dataclass(frozen=True)
class ReadyPartial:
    """One claimable ready partial from the per-job pool."""

    seq: int
    partial_key: str
    count: int
    level: int


@dataclass
class JobState:
    """Fields required by claim/finalize decisions."""

    job_id: str
    f: int
    c: int
    chunk_size_used: int
    reductions_remaining: int
    ready_count: int
    claimed_count: int
    leaf_tasks_total: int
    leaf_tasks_done: int
    result_key: str | None = None
    status: str = "RUNNING"
