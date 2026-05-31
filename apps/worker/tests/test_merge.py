"""Tests for pure merge math behavior."""

from __future__ import annotations

import numpy as np

from worker.merge import merge_inputs
from worker.models import InputVector


def test_merge_spec_example_f2_c3() -> None:
    """F=2,C=3 example should produce [5,7,9] sum and count 2."""
    merged = merge_inputs(
        [
            InputVector(key="a", vector=np.array([1.0, 2.0, 3.0]), count=1, level=0),
            InputVector(key="b", vector=np.array([4.0, 5.0, 6.0]), count=1, level=0),
        ],
        c=3,
    )
    assert merged.count == 2
    np.testing.assert_allclose(merged.sum_vector, np.array([5.0, 7.0, 9.0]))
    np.testing.assert_allclose(merged.sum_vector / merged.count, np.array([2.5, 3.5, 4.5]))


def test_merge_uses_input_counts_not_average_of_means() -> None:
    """Merging must preserve weighted contribution through counts."""
    merged = merge_inputs(
        [
            InputVector(key="left", vector=np.array([10.0, 10.0]), count=5, level=1),
            InputVector(key="tail", vector=np.array([2.0, 2.0]), count=2, level=1),
        ],
        c=2,
    )
    np.testing.assert_allclose(merged.sum_vector, np.array([12.0, 12.0]))
    assert merged.count == 7
    np.testing.assert_allclose(merged.sum_vector / merged.count, np.array([12.0 / 7.0, 12.0 / 7.0]))
