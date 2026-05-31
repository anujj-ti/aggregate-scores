"""DynamoDB-backed adapters for jobs, tasks, and fleet counters."""

from __future__ import annotations

import time
from collections.abc import Callable
from decimal import Decimal
from typing import Protocol, cast

from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from worker.config import Settings
from worker.models import JobState, ReadyPartial, TaskPayload, TaskTransitionResult


class ReadyPoolConsistencyError(RuntimeError):
    """Raised when a claimed seq range does not resolve the expected ready rows."""


def _to_int(value: object, *, default: int = 0) -> int:
    if value is None:
        return default
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value)
    raise TypeError(f"cannot convert value to int: {value!r}")


def _now_ms() -> int:
    return int(time.time() * 1000)


class DdbJobStore:
    """Job/ready-pool coordination on DynamoDB."""

    def __init__(self, *, dynamodb_resource: DynamoDbResourceProtocol, settings: Settings) -> None:
        table_factory = cast_table_factory(dynamodb_resource.Table)
        self._jobs = table_factory(settings.ddb_table_jobs)
        self._ready = table_factory(settings.ddb_table_ready)

    def reserve_ready_seq(self, *, job_id: str, is_leaf: bool) -> int:
        """Increment ready counters and return next ready sequence."""
        if is_leaf:
            expr = "ADD readyCount :one, leafTasksDone :one SET updatedAt = :now"
        else:
            expr = "ADD readyCount :one SET updatedAt = :now"

        response = self._jobs.update_item(
            Key={"jobId": job_id},
            UpdateExpression=expr,
            ExpressionAttributeValues={":one": 1, ":now": _now_ms()},
            ReturnValues="UPDATED_NEW",
        )
        attrs = cast(dict[str, object], response["Attributes"])
        return _to_int(attrs["readyCount"])

    def put_ready_partial(
        self,
        *,
        job_id: str,
        seq: int,
        partial_key: str,
        count: int,
        level: int,
    ) -> None:
        """Persist one ready row."""
        self._ready.put_item(
            Item={
                "jobId": job_id,
                "seq": seq,
                "partialKey": partial_key,
                "count": count,
                "level": level,
            }
        )

    def apply_reductions(self, *, job_id: str, reductions_delta: int) -> int:
        """Apply merge reduction progress and return remaining value."""
        response = self._jobs.update_item(
            Key={"jobId": job_id},
            UpdateExpression="ADD reductionsRemaining :delta SET updatedAt = :now",
            ExpressionAttributeValues={":delta": reductions_delta, ":now": _now_ms()},
            ReturnValues="UPDATED_NEW",
        )
        attrs = cast(dict[str, object], response["Attributes"])
        return _to_int(attrs["reductionsRemaining"])

    def get_job(self, *, job_id: str) -> JobState:
        """Read current job state."""
        response = self._jobs.get_item(Key={"jobId": job_id})
        item_obj = response.get("Item")
        if not isinstance(item_obj, dict):
            raise KeyError(f"job not found: {job_id}")
        item = cast(dict[str, object], item_obj)
        result_key_obj = item.get("resultKey")
        result_key = result_key_obj if isinstance(result_key_obj, str) else None
        return JobState(
            job_id=job_id,
            f=_to_int(item.get("F")),
            c=_to_int(item.get("C")),
            chunk_size_used=_to_int(item.get("chunkSizeUsed"), default=5),
            reductions_remaining=_to_int(item.get("reductionsRemaining")),
            ready_count=_to_int(item.get("readyCount")),
            claimed_count=_to_int(item.get("claimedCount")),
            leaf_tasks_total=_to_int(item.get("leafTasksTotal")),
            leaf_tasks_done=_to_int(item.get("leafTasksDone")),
            result_key=result_key,
            status=str(item.get("status", "RUNNING")),
        )

    def claim_ready(self, *, job_id: str, count: int) -> list[ReadyPartial]:
        """Claim a disjoint ready range with conditional ADD."""
        current = self.get_job(job_id=job_id)
        if current.claimed_count + count > current.ready_count:
            return []

        try:
            self._jobs.update_item(
                Key={"jobId": job_id},
                UpdateExpression="ADD claimedCount :n",
                ConditionExpression=(
                    "claimedCount = :expected_claimed AND readyCount = :expected_ready"
                ),
                ExpressionAttributeValues={
                    ":n": count,
                    ":expected_claimed": current.claimed_count,
                    ":expected_ready": current.ready_count,
                },
            )
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code == "ConditionalCheckFailedException":
                return []
            raise

        start_seq = current.claimed_count + 1
        end_seq = current.claimed_count + count

        rows_obj = self._ready.query(
            KeyConditionExpression="jobId = :jid AND seq BETWEEN :start AND :end",
            ExpressionAttributeValues={":jid": job_id, ":start": start_seq, ":end": end_seq},
            ScanIndexForward=True,
        ).get("Items", [])
        rows = cast(list[dict[str, object]], rows_obj)

        # Fail-closed integrity guard. The conditional ADD above already reserved a
        # disjoint seq range, so exactly `count` ready rows must exist for that range.
        # A short count means a producer advanced readyCount before its ready row was
        # durable (only possible with concurrent workers). Aborting here forces the job
        # to FAILED instead of aggregating a partial set and reporting a wrong mean.
        if len(rows) != count:
            raise ReadyPoolConsistencyError(
                f"claimed seq range [{start_seq},{end_seq}] for job {job_id} "
                f"resolved {len(rows)} ready rows, expected {count}"
            )

        return [
            ReadyPartial(
                seq=_to_int(row["seq"]),
                partial_key=str(row["partialKey"]),
                count=_to_int(row["count"]),
                level=_to_int(row.get("level"), default=0),
            )
            for row in rows
        ]

    def set_complete(self, *, job_id: str, result_key: str) -> None:
        """Set job as complete with result key."""
        self._jobs.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET #s = :status, resultKey = :result, updatedAt = :now",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":status": "COMPLETE",
                ":result": result_key,
                ":now": _now_ms(),
            },
        )

    def set_failed(self, *, job_id: str, error: str) -> None:
        """Set job status failed with compact error message."""
        self._jobs.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET #s = :status, #e = :error, updatedAt = :now",
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={
                ":status": "FAILED",
                ":error": error[:1000],
                ":now": _now_ms(),
            },
        )


class DdbTaskStore:
    """Tasks table transitions for idempotent processing."""

    def __init__(self, *, dynamodb_resource: DynamoDbResourceProtocol, settings: Settings) -> None:
        table_factory = cast_table_factory(dynamodb_resource.Table)
        self._tasks = table_factory(settings.ddb_table_tasks)

    def mark_queued(self, *, task: TaskPayload) -> None:
        """Ensure task row exists in queued state."""
        self._tasks.update_item(
            Key={"jobId": task.job_id, "taskId": task.task_id},
            UpdateExpression=(
                "SET #k = if_not_exists(#k, :kind), #l = if_not_exists(#l, :level), "
                "#s = if_not_exists(#s, :queued), inputKeys = if_not_exists(inputKeys, :keys), "
                "inputKind = if_not_exists(inputKind, :input_kind), "
                "attempts = if_not_exists(attempts, :zero)"
            ),
            ExpressionAttributeNames={"#k": "kind", "#l": "level", "#s": "status"},
            ExpressionAttributeValues={
                ":kind": "leaf" if task.input_kind.value == "file" else "merge",
                ":level": task.level,
                ":queued": "QUEUED",
                ":keys": task.input_keys,
                ":input_kind": task.input_kind.value,
                ":zero": 0,
            },
        )

    def try_start(self, *, job_id: str, task_id: str) -> TaskTransitionResult:
        """Move task from QUEUED to IN_PROGRESS exactly once."""
        item = self._tasks.get_item(Key={"jobId": job_id, "taskId": task_id}).get("Item")
        item_dict = cast(dict[str, object] | None, item)
        if item_dict is not None and str(item_dict.get("status")) == "DONE":
            return TaskTransitionResult.ALREADY_DONE

        try:
            self._tasks.update_item(
                Key={"jobId": job_id, "taskId": task_id},
                UpdateExpression="SET #s = :in_progress ADD attempts :one",
                ConditionExpression="attribute_not_exists(#s) OR #s = :queued",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":in_progress": "IN_PROGRESS",
                    ":queued": "QUEUED",
                    ":one": 1,
                },
            )
            return TaskTransitionResult.STARTED
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code == "ConditionalCheckFailedException":
                return TaskTransitionResult.ALREADY_DONE
            raise

    def mark_done(self, *, job_id: str, task_id: str, partial_key: str | None) -> None:
        """Mark task done."""
        if partial_key is None:
            self._tasks.update_item(
                Key={"jobId": job_id, "taskId": task_id},
                UpdateExpression="SET #s = :done REMOVE partialKey",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":done": "DONE"},
            )
            return

        self._tasks.update_item(
            Key={"jobId": job_id, "taskId": task_id},
            UpdateExpression="SET #s = :done, partialKey = :partial",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":done": "DONE", ":partial": partial_key},
        )

    def mark_failed(self, *, job_id: str, task_id: str, error: str) -> None:
        """Mark task failed."""
        self._tasks.update_item(
            Key={"jobId": job_id, "taskId": task_id},
            UpdateExpression="SET #s = :failed, #e = :error",
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={":failed": "FAILED", ":error": error[:1000]},
        )


class DdbFleetCounter:
    """Fleet inFlight counter update helper."""

    def __init__(self, *, dynamodb_resource: DynamoDbResourceProtocol, settings: Settings) -> None:
        table_factory = cast_table_factory(dynamodb_resource.Table)
        self._fleet = table_factory(settings.ddb_table_fleet)
        self._fleet_pk = settings.fleet_pk

    def add(self, *, delta: int) -> None:
        """Atomically add delta to inFlight."""
        self._fleet.update_item(
            Key={"pk": self._fleet_pk},
            UpdateExpression="ADD inFlight :delta",
            ExpressionAttributeValues={":delta": delta},
        )


class DynamoDbTableProtocol(Protocol):
    """Subset of table API used by worker adapters."""

    def update_item(self, **kwargs: object) -> dict[str, object]:
        """Update item and return DynamoDB response."""

    def get_item(self, **kwargs: object) -> dict[str, object]:
        """Read item and return response dictionary."""

    def put_item(self, **kwargs: object) -> dict[str, object]:
        """Put one table row."""

    def query(self, **kwargs: object) -> dict[str, object]:
        """Query table rows."""


def cast_table_factory(
    table_method: Callable[[str], DynamoDbTableProtocol],
) -> Callable[[str], DynamoDbTableProtocol]:
    """Keep table method typing explicit for strict mypy."""
    return table_method


class DynamoDbResourceProtocol(Protocol):
    """Subset of DynamoDB resource API needed for table access."""

    def Table(self, name: str) -> DynamoDbTableProtocol:  # noqa: N802
        """Return table resource."""
