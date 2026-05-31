"""Baseline tests for worker package bootstrap."""

from worker import healthcheck


def test_healthcheck_returns_ok() -> None:
    """Verify worker package imports and returns the expected marker."""
    assert healthcheck() == "ok"
