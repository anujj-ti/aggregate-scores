"""Local SQS polling loop for worker task processing."""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Protocol, cast

from pydantic import ValidationError

from worker.contracts import MergeTask
from worker.handler import WorkerHandler

LOGGER = logging.getLogger(__name__)


@dataclass
class PollingWorker:
    """SQS poller that dispatches queue messages to handler."""

    sqs_client: SqsPollClientProtocol
    queue_url: str
    handler: WorkerHandler
    wait_seconds: int = 10
    max_messages: int = 1

    def run_once(self) -> int:
        """Poll once and process up to max messages; returns processed count."""
        response = self.sqs_client.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=self.max_messages,
            WaitTimeSeconds=self.wait_seconds,
            VisibilityTimeout=120,
        )
        messages_obj = response.get("Messages", [])
        messages = cast(list[dict[str, object]], messages_obj)
        if not messages:
            return 0

        processed = 0
        for message in messages:
            body = str(message["Body"])
            receipt_handle = str(message["ReceiptHandle"])
            payload = self._parse_task(body)
            self.handler.process_contract(payload)
            self.sqs_client.delete_message(QueueUrl=self.queue_url, ReceiptHandle=receipt_handle)
            processed += 1
        return processed

    def run_forever(self, *, sleep_seconds: float = 0.0, max_iterations: int | None = None) -> None:
        """Run endless poll loop (or bounded iterations for local testing)."""
        iterations = 0
        while True:
            try:
                self.run_once()
            except Exception:  # pragma: no cover - defensive local runtime guard
                LOGGER.exception("poll loop iteration failed")
            iterations += 1
            if max_iterations is not None and iterations >= max_iterations:
                return
            if sleep_seconds > 0:
                time.sleep(sleep_seconds)

    def _parse_task(self, body: str) -> MergeTask:
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid queue json: {exc}") from exc

        try:
            return MergeTask.model_validate(parsed)
        except ValidationError as exc:
            raise ValueError(f"invalid MergeTask payload: {exc}") from exc


class SqsPollClientProtocol(Protocol):
    """Subset of SQS methods required for polling loop."""

    def receive_message(
        self,
        *,
        QueueUrl: str,  # noqa: N803
        MaxNumberOfMessages: int,  # noqa: N803
        WaitTimeSeconds: int,  # noqa: N803
        VisibilityTimeout: int,  # noqa: N803
    ) -> dict[str, object]:
        """Poll messages."""

    def delete_message(
        self,
        *,
        QueueUrl: str,  # noqa: N803
        ReceiptHandle: str,  # noqa: N803
    ) -> dict[str, object]:
        """Delete processed message."""
