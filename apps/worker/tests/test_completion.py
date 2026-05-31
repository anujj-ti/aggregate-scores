"""End-to-end eager-merge state machine tests with in-memory fakes."""

from __future__ import annotations

from collections import deque

import numpy as np

from fakes import make_handler_stack, seeded_job
from worker.contracts import InputKind
from worker.models import TaskPayload


def _leaf_tasks(*, job_id: str, f: int, c: int, chunk_size: int) -> list[TaskPayload]:
    tasks: list[TaskPayload] = []
    for task_index, start in enumerate(range(0, f, chunk_size)):
        end = min(start + chunk_size, f)
        tasks.append(
            TaskPayload(
                job_id=job_id,
                task_id=f"{job_id}#leaf#{task_index}",
                input_kind=InputKind.file,
                level=0,
                input_keys=[f"jobs/{job_id}/input/{idx}.npy" for idx in range(start, end)],
                c=c,
            )
        )
    return tasks


def _run_job(*, f: int, c: int) -> tuple[np.ndarray, int]:
    job_id = f"job_{f}_{c}"
    chunk = 5
    leaf_total = (f + chunk - 1) // chunk
    reductions = leaf_total - 1
    job = seeded_job(
        job_id=job_id,
        f=f,
        c=c,
        chunk_size_used=chunk,
        reductions_remaining=reductions,
        leaf_tasks_total=leaf_total,
    )
    handler, blob, jobs, _tasks, queue, _fleet = make_handler_stack(job=job)

    all_vectors: list[np.ndarray] = []
    for file_idx in range(f):
        vector = np.array([(file_idx + 1.0) * (axis + 1.0) for axis in range(c)], dtype=np.float64)
        all_vectors.append(vector)
        blob.put_input_file(key=f"jobs/{job_id}/input/{file_idx}.npy", vector=vector)

    pending = deque(_leaf_tasks(job_id=job_id, f=f, c=c, chunk_size=chunk))
    seen = 0
    while pending:
        task = pending.popleft()
        handler.process_task(task)
        while seen < len(queue.tasks):
            pending.append(queue.tasks[seen])
            seen += 1

    result = blob.result_vectors[f"jobs/{job_id}/result.csv"]
    return result, jobs.complete_events[job_id]


def test_full_eager_merge_for_f12_tail_path() -> None:
    """F=12 should converge through leaf [5,5,2] then one tail merge."""
    result, complete_events = _run_job(f=12, c=3)
    expected = np.mean(
        np.array(
            [[(idx + 1.0) * 1.0, (idx + 1.0) * 2.0, (idx + 1.0) * 3.0] for idx in range(12)],
            dtype=np.float64,
        ),
        axis=0,
    )
    np.testing.assert_allclose(result, expected)
    assert complete_events == 1


def test_full_eager_merge_for_f30() -> None:
    """F=30 should complete with exactly one finalize event."""
    result, complete_events = _run_job(f=30, c=2)
    expected = np.mean(
        np.array([[(idx + 1.0) * 1.0, (idx + 1.0) * 2.0] for idx in range(30)], dtype=np.float64),
        axis=0,
    )
    np.testing.assert_allclose(result, expected)
    assert complete_events == 1


def _merge_sizes_for(*, f: int, c: int) -> tuple[list[int], int]:
    """Run a job and return the input sizes of every enqueued merge task."""
    job_id = f"job_sizes_{f}_{c}"
    chunk = 5
    leaf_total = (f + chunk - 1) // chunk
    job = seeded_job(
        job_id=job_id,
        f=f,
        c=c,
        chunk_size_used=chunk,
        reductions_remaining=leaf_total - 1,
        leaf_tasks_total=leaf_total,
    )
    handler, blob, jobs, _tasks, queue, _fleet = make_handler_stack(job=job)
    for file_idx in range(f):
        vector = np.array([(file_idx + 1.0) * (axis + 1.0) for axis in range(c)], dtype=np.float64)
        blob.put_input_file(key=f"jobs/{job_id}/input/{file_idx}.npy", vector=vector)

    pending = deque(_leaf_tasks(job_id=job_id, f=f, c=c, chunk_size=chunk))
    seen = 0
    while pending:
        handler.process_task(pending.popleft())
        while seen < len(queue.tasks):
            pending.append(queue.tasks[seen])
            seen += 1

    merge_sizes = [len(task.input_keys) for task in queue.tasks]
    return merge_sizes, jobs.complete_events[job_id]


def test_prefers_full_chunks_and_only_shrinks_at_tail() -> None:
    """Merges should batch chunk_size (5); a smaller merge only happens at the genuine tail."""
    merge_sizes, complete_events = _merge_sizes_for(f=40, c=2)
    # 8 leaf partials -> merge 5 (full chunk), then 4 remain as the genuine tail.
    assert merge_sizes == [5, 4]
    assert complete_events == 1
    # Every merge except the last must be a full chunk of 5.
    assert all(size == 5 for size in merge_sizes[:-1])


def test_f_le_5_finalizes_directly_on_leaf() -> None:
    """Single leaf partial should finalize directly when reductions start at zero."""
    result, complete_events = _run_job(f=4, c=2)
    expected = np.mean(
        np.array([[(idx + 1.0) * 1.0, (idx + 1.0) * 2.0] for idx in range(4)], dtype=np.float64),
        axis=0,
    )
    np.testing.assert_allclose(result, expected)
    assert complete_events == 1
