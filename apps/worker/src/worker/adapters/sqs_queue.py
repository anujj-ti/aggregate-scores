"""SQS-backed queue adapter for merge tasks."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field

from worker.config import Settings
from worker.models import TaskPayload


class QueueUrlLookupRequest(BaseModel):
    """Typed request to resolve queue URL by name."""

    model_config = ConfigDict(extra="forbid")

    queue_name: str = Field(min_length=1)


class QueueUrlLookupResponse(BaseModel):
    """Typed queue URL lookup response."""

    model_config = ConfigDict(extra="forbid")

    queue_url: str = Field(min_length=1)


class SendMessageRequest(BaseModel):
    """Typed queue message send request."""

    model_config = ConfigDict(extra="forbid")

    queue_url: str = Field(min_length=1)
    message_body: str = Field(min_length=1)


class SendMessageResponse(BaseModel):
    """Typed queue message send response metadata."""

    model_config = ConfigDict(extra="forbid")

    message_id: str | None = None


class MergeTaskMessage(BaseModel):
    """Serialized merge-task queue payload."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    job_id: str = Field(alias="jobId", min_length=1)
    task_id: str = Field(alias="taskId", min_length=1)
    input_kind: str = Field(alias="inputKind", min_length=1)
    level: int = Field(ge=0)
    input_keys: list[str] = Field(alias="inputKeys", min_length=1, max_length=5)
    c: int = Field(alias="C", ge=1)


class SqsWorkQueue:
    """Publishes merge tasks to the work queue."""

    def __init__(self, *, sqs_client: SqsClientProtocol, settings: Settings) -> None:
        self._sqs_client = sqs_client
        lookup = QueueUrlLookupRequest(queue_name=settings.queue_work)
        self._queue_url = sqs_client.get_queue_url(request=lookup).queue_url

    @property
    def queue_url(self) -> str:
        """Expose resolved queue URL for poll loop reuse."""
        return self._queue_url

    def enqueue(self, *, task: TaskPayload) -> None:
        """Send one merge task as JSON payload."""
        message = MergeTaskMessage(
            jobId=task.job_id,
            taskId=task.task_id,
            inputKind=task.input_kind.value,
            level=task.level,
            inputKeys=task.input_keys,
            C=task.c,
        )
        send_request = SendMessageRequest(
            queue_url=self._queue_url,
            message_body=message.model_dump_json(by_alias=True),
        )
        self._sqs_client.send_message(request=send_request)


class SqsClientProtocol(Protocol):
    """Typed SQS operations used by queue adapter."""

    def get_queue_url(self, *, request: QueueUrlLookupRequest) -> QueueUrlLookupResponse:
        """Resolve queue URL by name."""

    def send_message(self, *, request: SendMessageRequest) -> SendMessageResponse:
        """Send one message to queue."""


class RawSqsClientProtocol(Protocol):
    """Raw boto SQS method subset used by the typed client wrapper."""

    def get_queue_url(self, **kwargs: str) -> Mapping[str, str]:
        """Resolve queue URL using boto3 response shape."""

    def send_message(self, **kwargs: str) -> Mapping[str, str]:
        """Send one message using boto3 response shape."""


class BotoSqsClient:
    """Typed wrapper around raw boto3 SQS client."""

    def __init__(self, *, raw_client: RawSqsClientProtocol) -> None:
        self._raw_client = raw_client

    def get_queue_url(self, *, request: QueueUrlLookupRequest) -> QueueUrlLookupResponse:
        """Resolve queue URL by queue name."""
        raw = self._raw_client.get_queue_url(QueueName=request.queue_name)
        return QueueUrlLookupResponse(queue_url=raw["QueueUrl"])

    def send_message(self, *, request: SendMessageRequest) -> SendMessageResponse:
        """Send one JSON message to queue."""
        raw = self._raw_client.send_message(
            QueueUrl=request.queue_url,
            MessageBody=request.message_body,
        )
        return SendMessageResponse(message_id=raw.get("MessageId"))
