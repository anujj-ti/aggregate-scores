"""Leaf-task processing behavior tests."""

from __future__ import annotations

import numpy as np

from fakes import make_handler_stack, seeded_job
from worker.contracts import InputKind
from worker.models import TaskPayload


def test_leaf_writes_partial_and_updates_leaf_done() -> None:
    """Leaf task should produce one partial and bump leaf completion counter."""
    job = seeded_job(
        job_id="job_leaf",
        f=10,
        c=3,
        reductions_remaining=1,
        leaf_tasks_total=2,
        leaf_tasks_done=0,
    )
    handler, blob, jobs, tasks, queue, fleet = make_handler_stack(job=job)

    payload = TaskPayload(
        job_id="job_leaf",
        task_id="job_leaf#leaf#0",
        input_kind=InputKind.file,
        level=0,
        input_keys=[f"jobs/job_leaf/input/{idx}.npy" for idx in range(5)],
        c=3,
    )
    for idx, key in enumerate(payload.input_keys):
        blob.put_input_file(key=key, vector=np.array([idx + 1.0, idx + 2.0, idx + 3.0]))

    handler.process_task(payload)

    state = jobs.get_job(job_id="job_leaf")
    assert state.leaf_tasks_done == 1
    assert state.ready_count == 1
    assert state.reductions_remaining == 1
    assert queue.tasks == []
    assert fleet.total == 0
    assert tasks.status[(payload.job_id, payload.task_id)] == "DONE"
