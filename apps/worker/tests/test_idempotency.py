"""Idempotency behavior tests for task redelivery."""

from __future__ import annotations

import numpy as np

from fakes import make_handler_stack, seeded_job
from worker.contracts import InputKind
from worker.models import TaskPayload


def test_redelivered_task_does_not_double_apply() -> None:
    """Processing the same task twice should not double-decrement counters."""
    job = seeded_job(
        job_id="job_retry",
        f=5,
        c=2,
        reductions_remaining=0,
        leaf_tasks_total=1,
        leaf_tasks_done=0,
    )
    handler, blob, jobs, tasks, _queue, fleet = make_handler_stack(job=job)
    fleet.total = 1

    payload = TaskPayload(
        job_id="job_retry",
        task_id="job_retry#leaf#0",
        input_kind=InputKind.file,
        level=0,
        input_keys=[f"jobs/job_retry/input/{idx}.npy" for idx in range(5)],
        c=2,
    )
    for idx, key in enumerate(payload.input_keys):
        blob.put_input_file(key=key, vector=np.array([float(idx + 1), float((idx + 1) * 2)]))

    handler.process_task(payload)
    handler.process_task(payload)

    state = jobs.get_job(job_id="job_retry")
    assert state.ready_count == 1
    assert state.reductions_remaining == 0
    assert jobs.complete_events["job_retry"] == 1
    assert tasks.status[(payload.job_id, payload.task_id)] == "DONE"
    assert fleet.total == 0
