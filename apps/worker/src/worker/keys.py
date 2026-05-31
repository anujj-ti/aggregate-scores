"""Deterministic key and id helpers for worker runtime."""

from __future__ import annotations


def partial_key(job_id: str, seq: int) -> str:
    """Build deterministic S3 partial key from ready sequence."""
    return f"jobs/{job_id}/partials/{seq:08d}.npz"


def result_key(job_id: str) -> str:
    """Build final result key."""
    return f"jobs/{job_id}/result.csv"


def merge_task_id(job_id: str, claim_upper_seq: int) -> str:
    """Create deterministic merge task id for a claimed range."""
    return f"{job_id}#merge#{claim_upper_seq}"
