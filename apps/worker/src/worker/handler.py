"""Worker task orchestration for eager-merge state machine."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from worker.contracts import InputKind, MergeTask
from worker.keys import merge_task_id, partial_key, result_key
from worker.merge import merge_inputs
from worker.models import JobState, TaskPayload, TaskTransitionResult
from worker.ports import BlobStore, FleetCounter, JobStore, TaskStore, WorkQueue


class JobIntegrityError(RuntimeError):
    """Raised when final aggregated count does not match job F."""


@dataclass
class WorkerHandler:
    """Coordinates task processing across storage and queue ports."""

    blob_store: BlobStore
    job_store: JobStore
    task_store: TaskStore
    work_queue: WorkQueue
    fleet_counter: FleetCounter
    chunk_size: int = 5

    def process_contract(self, payload: MergeTask) -> None:
        """Validate contract model to domain payload and process it."""
        self.process_task(TaskPayload.from_contract(payload))

    def process_task(self, task: TaskPayload) -> None:
        """Process one merge task with idempotency and atomic counter updates."""
        self.task_store.mark_queued(task=task)
        transition = self.task_store.try_start(job_id=task.job_id, task_id=task.task_id)
        if transition == TaskTransitionResult.ALREADY_DONE:
            return

        produced_partial_key = ""
        try:
            state_before = self.job_store.get_job(job_id=task.job_id)
            if state_before.status == "CANCELLED":
                self.task_store.mark_done(
                    job_id=task.job_id, task_id=task.task_id, partial_key=None
                )
                return

            merged = merge_inputs(
                (
                    self.blob_store.read_input(
                        input_kind=task.input_kind,
                        key=input_key,
                        task_level=task.level,
                    )
                    for input_key in task.input_keys
                ),
                c=task.c,
            )

            seq = self.job_store.reserve_ready_seq(
                job_id=task.job_id,
                is_leaf=task.input_kind == InputKind.file,
            )
            produced_partial_key = partial_key(task.job_id, seq)
            produced_level = merged.max_input_level + (
                0 if task.input_kind == InputKind.file else 1
            )

            self.blob_store.write_partial(
                partial_key=produced_partial_key,
                sum_vector=merged.sum_vector,
                count=merged.count,
                level=produced_level,
            )
            self.job_store.put_ready_partial(
                job_id=task.job_id,
                seq=seq,
                partial_key=produced_partial_key,
                count=merged.count,
                level=produced_level,
            )

            reductions_delta = self._reductions_delta(task=task)
            remaining = self.job_store.apply_reductions(
                job_id=task.job_id,
                reductions_delta=reductions_delta,
            )
            state = self.job_store.get_job(job_id=task.job_id)
            if state.status == "CANCELLED":
                self.task_store.mark_done(
                    job_id=task.job_id,
                    task_id=task.task_id,
                    partial_key=produced_partial_key,
                )
                return

            if remaining == 0:
                self._finalize_if_valid(
                    job_id=task.job_id,
                    merged_count=merged.count,
                    produced_sum_vector=merged.sum_vector,
                )
            else:
                self._maybe_enqueue_follow_up(job=state, c=task.c)

            self.task_store.mark_done(
                job_id=task.job_id,
                task_id=task.task_id,
                partial_key=produced_partial_key,
            )
        except Exception as exc:
            self.task_store.mark_failed(job_id=task.job_id, task_id=task.task_id, error=str(exc))
            self.job_store.set_failed(job_id=task.job_id, error=str(exc))
            raise
        finally:
            self.fleet_counter.add(delta=-1)

    def _reductions_delta(self, *, task: TaskPayload) -> int:
        if task.input_kind == InputKind.partial:
            return -(len(task.input_keys) - 1)
        return 0

    def _finalize_if_valid(
        self,
        *,
        job_id: str,
        merged_count: int,
        produced_sum_vector: npt.NDArray[np.float64],
    ) -> None:
        state = self.job_store.get_job(job_id=job_id)
        if state.status == "CANCELLED":
            return
        if merged_count != state.f:
            raise JobIntegrityError(f"expected {state.f} files, aggregated {merged_count}")
        final = produced_sum_vector / merged_count
        out_key = result_key(job_id)
        self.blob_store.write_result(result_key=out_key, vector=final)
        self.job_store.set_complete(job_id=job_id, result_key=out_key)

    def _maybe_enqueue_follow_up(self, *, job: JobState, c: int) -> None:
        available = job.ready_count - job.claimed_count
        # Prefer full chunks of `chunk_size`: only merge a smaller batch at the genuine
        # tail. `reductions_remaining + 1` is the number of partials still live in the
        # whole job (ready + in-flight + leaves not yet produced). When that equals the
        # ready pool, nothing else can arrive to complete a full chunk, so we must drain
        # what we have; otherwise we wait for more partials to reach `chunk_size`.
        # (Waiting in the tail case would deadlock; draining early would needlessly emit
        # small merges, which is the behavior we are avoiding here.)
        have_full_chunk = available >= self.chunk_size
        at_genuine_tail = available >= 2 and available == job.reductions_remaining + 1
        if not (have_full_chunk or at_genuine_tail):
            return

        claim_size = min(available, self.chunk_size)
        claimed = self.job_store.claim_ready(job_id=job.job_id, count=claim_size)
        if not claimed:
            return

        next_level = max(item.level for item in claimed) + 1
        follow_up = TaskPayload(
            job_id=job.job_id,
            task_id=merge_task_id(job.job_id, claimed[-1].seq),
            input_kind=InputKind.partial,
            level=next_level,
            input_keys=[item.partial_key for item in claimed],
            c=c,
        )
        self.task_store.mark_queued(task=follow_up)
        self.work_queue.enqueue(task=follow_up)
        self.fleet_counter.add(delta=1)
