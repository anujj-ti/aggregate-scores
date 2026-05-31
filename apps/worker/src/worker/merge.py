"""Pure merge primitives for eager-merge worker tasks."""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np
import numpy.typing as npt

from worker.models import InputVector, MergedPartial


def merge_inputs(inputs: Iterable[InputVector], c: int) -> MergedPartial:
    """Fold input vectors into one float64 sum vector and total count."""
    acc = np.zeros(c, dtype=np.float64)
    total_count = 0
    max_level = 0

    seen = 0
    for item in inputs:
        vector = np.asarray(item.vector, dtype=np.float64)
        if vector.shape != (c,):
            raise ValueError(f"input vector {item.key} shape {vector.shape} does not match C={c}")
        acc += vector
        total_count += item.count
        max_level = max(max_level, item.level)
        seen += 1
        del vector

    if seen == 0:
        raise ValueError("merge task had no inputs")

    out: npt.NDArray[np.float64] = acc
    return MergedPartial(sum_vector=out, count=total_count, max_input_level=max_level)
