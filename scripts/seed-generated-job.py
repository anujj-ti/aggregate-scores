#!/usr/bin/env python3
"""Generate random input files and seed one RUNNING job in LocalStack.

This script models the future generation/admission service. It is intentionally
outside the worker package and does not run on the worker fleet.
"""

from __future__ import annotations

import argparse
import json
import time
import uuid
from dataclasses import dataclass

import boto3
import numpy as np


@dataclass(frozen=True)
class SeedConfig:
    """Runtime configuration for seeding a generated job."""

    aws_region: str
    aws_endpoint_url: str
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: str
    s3_bucket_name: str
    queue_work: str
    ddb_table_jobs: str
    ddb_table_tasks: str
    chunk_size: int


def _env_or_default(name: str, default: str) -> str:
    import os

    return os.environ.get(name, default)


def load_config(*, chunk_size: int) -> SeedConfig:
    """Load script config from environment variables."""
    return SeedConfig(
        aws_region=_env_or_default("AWS_REGION", "us-east-1"),
        aws_endpoint_url=_env_or_default("AWS_ENDPOINT_URL", "http://localhost:4566"),
        aws_access_key_id=_env_or_default("AWS_ACCESS_KEY_ID", "test"),
        aws_secret_access_key=_env_or_default("AWS_SECRET_ACCESS_KEY", "test"),
        aws_session_token=_env_or_default("AWS_SESSION_TOKEN", "test"),
        s3_bucket_name=_env_or_default("S3_BUCKET_NAME", "aggregate-scores-bucket"),
        queue_work=_env_or_default("QUEUE_WORK", "aggregate-work-queue"),
        ddb_table_jobs=_env_or_default("DDB_TABLE_JOBS", "AggregateJobs"),
        ddb_table_tasks=_env_or_default("DDB_TABLE_TASKS", "AggregateTasks"),
        chunk_size=chunk_size,
    )


def _make_session(config: SeedConfig) -> boto3.session.Session:
    return boto3.session.Session(
        aws_access_key_id=config.aws_access_key_id,
        aws_secret_access_key=config.aws_secret_access_key,
        aws_session_token=config.aws_session_token,
        region_name=config.aws_region,
    )


def _leaf_task_id(job_id: str, task_index: int) -> str:
    return f"{job_id}#leaf#{task_index}"


def seed_job(*, f: int, c: int, seed: int, job_id: str | None, chunk_size: int) -> str:
    """Generate files, write job row, and enqueue leaf tasks."""
    cfg = load_config(chunk_size=chunk_size)
    session = _make_session(cfg)
    s3_client = session.client("s3", endpoint_url=cfg.aws_endpoint_url)
    sqs_client = session.client("sqs", endpoint_url=cfg.aws_endpoint_url)
    dynamodb_resource = session.resource("dynamodb", endpoint_url=cfg.aws_endpoint_url)

    jobs_table = dynamodb_resource.Table(cfg.ddb_table_jobs)
    tasks_table = dynamodb_resource.Table(cfg.ddb_table_tasks)
    queue_url = sqs_client.get_queue_url(QueueName=cfg.queue_work)["QueueUrl"]

    resolved_job_id = job_id if job_id is not None else f"job_{uuid.uuid4().hex[:12]}"
    rng = np.random.default_rng(seed)
    now_ms = int(time.time() * 1000)

    for file_index in range(f):
        vector = rng.random(c, dtype=np.float32)
        key = f"jobs/{resolved_job_id}/input/{file_index}.npy"
        payload = vector.tobytes(order="C")
        npy_bytes = _to_npy_bytes(payload=payload, c=c)
        s3_client.put_object(Bucket=cfg.s3_bucket_name, Key=key, Body=npy_bytes)

    leaf_total = (f + cfg.chunk_size - 1) // cfg.chunk_size
    jobs_table.put_item(
        Item={
            "jobId": resolved_job_id,
            "status": "RUNNING",
            "submittedAt": now_ms,
            "createdAt": now_ms,
            "updatedAt": now_ms,
            "F": f,
            "C": c,
            "chunkSizeUsed": cfg.chunk_size,
            "leafTasksTotal": leaf_total,
            "leafTasksDone": 0,
            "reductionsRemaining": leaf_total - 1,
            "readyCount": 0,
            "claimedCount": 0,
        }
    )

    task_index = 0
    for start in range(0, f, cfg.chunk_size):
        end = min(start + cfg.chunk_size, f)
        input_keys = [
            f"jobs/{resolved_job_id}/input/{idx}.npy" for idx in range(start, end)
        ]
        task_id = _leaf_task_id(resolved_job_id, task_index)
        payload = {
            "jobId": resolved_job_id,
            "taskId": task_id,
            "inputKind": "file",
            "level": 0,
            "inputKeys": input_keys,
            "C": c,
        }
        tasks_table.put_item(
            Item={
                "jobId": resolved_job_id,
                "taskId": task_id,
                "kind": "leaf",
                "level": 0,
                "status": "QUEUED",
                "inputKeys": input_keys,
                "inputKind": "file",
                "attempts": 0,
            }
        )
        sqs_client.send_message(QueueUrl=queue_url, MessageBody=json.dumps(payload))
        task_index += 1

    return resolved_job_id


def _to_npy_bytes(*, payload: bytes, c: int) -> bytes:
    """Wrap raw float32 bytes into an npy payload."""
    arr = np.frombuffer(payload, dtype=np.float32, count=c)
    from io import BytesIO

    buffer = BytesIO()
    np.save(buffer, arr)
    return buffer.getvalue()


def main() -> None:
    """CLI entrypoint for local generated-job seeding."""
    parser = argparse.ArgumentParser(
        description="Generate local input files and enqueue leaf tasks"
    )
    parser.add_argument("--f", type=int, required=True, help="File count")
    parser.add_argument("--c", type=int, required=True, help="Values per file")
    parser.add_argument(
        "--seed", type=int, default=42, help="RNG seed for reproducibility"
    )
    parser.add_argument(
        "--job-id", type=str, default=None, help="Optional explicit job id"
    )
    parser.add_argument("--chunk-size", type=int, default=5, help="Files per leaf task")
    args = parser.parse_args()

    if args.f < 1 or args.c < 1:
        raise ValueError("both --f and --c must be >= 1")
    if args.chunk_size < 1 or args.chunk_size > 5:
        raise ValueError("--chunk-size must be between 1 and 5")

    created_job_id = seed_job(
        f=args.f,
        c=args.c,
        seed=args.seed,
        job_id=args.job_id,
        chunk_size=args.chunk_size,
    )
    print(created_job_id)


if __name__ == "__main__":
    main()
