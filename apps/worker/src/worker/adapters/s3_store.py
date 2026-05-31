"""S3-backed blob adapter for worker inputs and outputs."""

from __future__ import annotations

from io import BytesIO, StringIO
from typing import Protocol, cast

import numpy as np
import numpy.typing as npt

from worker.config import Settings
from worker.contracts import InputKind
from worker.models import InputVector


class S3BlobStore:
    """Read/write worker vectors from S3."""

    def __init__(self, *, s3_client: S3ClientProtocol, settings: Settings) -> None:
        self._s3_client = s3_client
        self._bucket = settings.s3_bucket_name

    def read_input(self, *, input_kind: InputKind, key: str, task_level: int) -> InputVector:
        """Load a file or partial payload into memory."""
        body = self._read_bytes(key=key)
        if input_kind == InputKind.file:
            vector = np.asarray(np.load(BytesIO(body)), dtype=np.float64)
            return InputVector(key=key, vector=vector, count=1, level=task_level)

        bundle = np.load(BytesIO(body))
        vector = np.asarray(bundle["sum_vector"], dtype=np.float64)
        count = int(bundle["count"])
        level = int(bundle["level"]) if "level" in bundle else task_level
        return InputVector(key=key, vector=vector, count=count, level=level)

    def write_partial(
        self,
        *,
        partial_key: str,
        sum_vector: npt.NDArray[np.float64],
        count: int,
        level: int,
    ) -> None:
        """Persist one partial bundle."""
        payload = BytesIO()
        np.savez(payload, sum_vector=sum_vector, count=np.int64(count), level=np.int64(level))
        self._put_bytes(key=partial_key, payload=payload.getvalue())

    def write_result(self, *, result_key: str, vector: npt.NDArray[np.float64]) -> None:
        """Write final mean vector to CSV in S3."""
        payload = StringIO()
        np.savetxt(payload, vector, delimiter=",")
        self._put_bytes(key=result_key, payload=payload.getvalue().encode("utf-8"))

    def _read_bytes(self, *, key: str) -> bytes:
        response = self._s3_client.get_object(Bucket=self._bucket, Key=key)
        body = response["Body"]
        data = cast(bytes, body.read())  # type: ignore[attr-defined]
        if not isinstance(data, bytes):
            raise TypeError("s3 payload is not bytes")
        return data

    def _put_bytes(self, *, key: str, payload: bytes) -> None:
        self._s3_client.put_object(Bucket=self._bucket, Key=key, Body=payload)


class S3ClientProtocol(Protocol):
    """Subset of S3 client methods used by this adapter."""

    def get_object(
        self,
        *,
        Bucket: str,  # noqa: N803
        Key: str,  # noqa: N803
    ) -> dict[str, object]:
        """Get one object by key."""

    def put_object(
        self,
        *,
        Bucket: str,  # noqa: N803
        Key: str,  # noqa: N803
        Body: bytes,  # noqa: N803
    ) -> dict[str, object]:
        """Write one object by key."""
