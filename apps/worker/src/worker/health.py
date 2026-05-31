"""Minimal health primitives for worker scaffolding."""


def healthcheck() -> str:
    """Return a simple liveness marker for local checks."""
    return "ok"
