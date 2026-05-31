"""Entrypoint for local worker poll loop."""

from __future__ import annotations

from typing import cast

import boto3  # type: ignore[import-untyped]

from worker.adapters.ddb_store import (
    DdbFleetCounter,
    DdbJobStore,
    DdbTaskStore,
    DynamoDbResourceProtocol,
)
from worker.adapters.s3_store import S3BlobStore, S3ClientProtocol
from worker.adapters.sqs_queue import BotoSqsClient, RawSqsClientProtocol, SqsWorkQueue
from worker.config import Settings, load_settings
from worker.handler import WorkerHandler
from worker.loop import PollingWorker, SqsPollClientProtocol


def _boto3_session(settings: Settings) -> boto3.session.Session:
    return boto3.session.Session(
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
        aws_session_token=settings.aws_session_token,
        region_name=settings.aws_region,
    )


def main() -> None:
    """Run local polling worker against configured SQS queue."""
    settings = load_settings()
    session = _boto3_session(settings)
    s3_client = cast(S3ClientProtocol, session.client("s3", endpoint_url=settings.aws_endpoint_url))
    raw_sqs_client = cast(
        RawSqsClientProtocol, session.client("sqs", endpoint_url=settings.aws_endpoint_url)
    )
    sqs_client = BotoSqsClient(raw_client=raw_sqs_client)
    poll_client = cast(SqsPollClientProtocol, raw_sqs_client)
    dynamodb_resource = cast(
        DynamoDbResourceProtocol,
        session.resource("dynamodb", endpoint_url=settings.aws_endpoint_url),
    )

    queue = SqsWorkQueue(sqs_client=sqs_client, settings=settings)
    handler = WorkerHandler(
        blob_store=S3BlobStore(s3_client=s3_client, settings=settings),
        job_store=DdbJobStore(dynamodb_resource=dynamodb_resource, settings=settings),
        task_store=DdbTaskStore(dynamodb_resource=dynamodb_resource, settings=settings),
        work_queue=queue,
        fleet_counter=DdbFleetCounter(dynamodb_resource=dynamodb_resource, settings=settings),
        chunk_size=settings.chunk_size,
    )
    poller = PollingWorker(
        sqs_client=poll_client,
        queue_url=queue.queue_url,
        handler=handler,
        wait_seconds=settings.poll_wait_seconds,
        max_messages=settings.max_messages_per_poll,
    )
    poller.run_forever()


if __name__ == "__main__":
    main()
