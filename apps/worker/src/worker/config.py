"""Environment-backed settings for worker runtime."""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for worker execution."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    aws_region: str = Field(default="us-east-1", alias="AWS_REGION")
    aws_endpoint_url: str = Field(default="http://localhost:4566", alias="AWS_ENDPOINT_URL")
    aws_access_key_id: str = Field(default="test", alias="AWS_ACCESS_KEY_ID")
    aws_secret_access_key: str = Field(default="test", alias="AWS_SECRET_ACCESS_KEY")
    aws_session_token: str = Field(default="test", alias="AWS_SESSION_TOKEN")

    s3_bucket_name: str = Field(default="aggregate-scores-bucket", alias="S3_BUCKET_NAME")
    queue_work: str = Field(default="aggregate-work-queue", alias="QUEUE_WORK")

    ddb_table_jobs: str = Field(default="AggregateJobs", alias="DDB_TABLE_JOBS")
    ddb_table_ready: str = Field(default="AggregateReady", alias="DDB_TABLE_READY")
    ddb_table_tasks: str = Field(default="AggregateTasks", alias="DDB_TABLE_TASKS")
    ddb_table_fleet: str = Field(default="AggregateFleet", alias="DDB_TABLE_FLEET")
    fleet_pk: str = Field(default="FLEET", alias="FLEET_PK")

    chunk_size: int = Field(default=5, alias="CHUNK_SIZE")
    poll_wait_seconds: int = Field(default=10, alias="WORKER_POLL_WAIT_SECONDS")
    max_messages_per_poll: int = Field(default=1, alias="WORKER_MAX_MESSAGES_PER_POLL")


def load_settings() -> Settings:
    """Load and validate worker settings from environment."""
    return Settings()
