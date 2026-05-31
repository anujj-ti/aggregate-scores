# Numerical Accuracy & Summation

Why our `(sum, count)` mean is accurate enough in plain `float64`, why we rely on NumPy's
**pairwise summation**, and why **Kahan (compensated) summation** is left off by default.
This is the supporting detail behind [ITD 2](../ITD/itd-decisions.md).

## The problem: floating-point addition loses bits

A `float64` carries ~15–16 significant decimal digits (52-bit mantissa, machine epsilon
`ε ≈ 2.2 × 10⁻¹⁶`). When two numbers of very different magnitude are added, the smaller one's
low-order bits fall off the end of the mantissa and are silently dropped:

```text
100000.0 + 0.00000001  →  100000.00000001  (rounded back to ~100000.0)
```

Do that across many additions and the dropped crumbs accumulate into a real error. How fast the
error grows depends on the summation strategy.

## Three summation strategies

| Strategy | Error bound | Cost per element | Vectorizable |
| :---- | :---- | :---- | :---- |
| Naive sequential (`for x: s += x`) | ~O(ε · n) | 1 add | yes |
| **Pairwise** (what `np.sum` uses) | ~O(ε · log n) | 1 add | yes (SIMD) |
| Kahan / compensated | ~O(ε) | ~4 ops + state | no (sequential) |

### Naive

`s += x` in a loop. Error grows **linearly** with `n` because every add rounds against an
ever-larger running total.

### Pairwise (our default, via NumPy)

`np.sum` does not add left-to-right. It recursively splits the array and sums halves, so each
addition combines partials of **similar magnitude**. Error grows ~`log n` instead of `n`, at the
same single-pass, SIMD-vectorized speed as naive. We get this for free by calling `np.sum` /
`+=` on arrays.

### Kahan (compensated)

Keeps a second variable `c` holding the bits dropped on the previous add, and folds them back in:

```python
s = 0.0
c = 0.0                 # running compensation — the "lost crumbs"
for x in values:
    y = x - c           # add back what we lost last time
    t = s + y           # the lossy add
    c = (t - s) - y     # recover exactly what got dropped
    s = t
```

`c = (t - s) - y` recomputes the rounding error of `t = s + y` (zero in exact math, nonzero in
float) so the next iteration corrects for it. Error stays **constant** (~O(ε)) regardless of `n`.

## Why pairwise is already enough for this workload

Our data is deliberately benign for summation:

- **Same magnitude.** All values are in `[0, 1]`, so there is no `100000 + 0.00000001`
  mismatch — the worst case for bit loss never arises.
- **Few terms.** At most ~10⁵ values per index, so the sum is ≤ ~10⁵ (float64 ceiling ≈ 10³⁰⁸ —
  overflow is impossible).
- **Tree merge on top.** Partials are combined up a ≤5-ary tree, which is itself a pairwise-style
  reduction, so error compounds as ~`log` of the tree, not linearly.

Concrete bound with pairwise summation:

```text
relative error ≈ ε · log₂(n) ≈ 2.2e-16 · log₂(1e5) ≈ 2.2e-16 · 17 ≈ 4e-15
absolute error on a sum of 1e5 ≈ ~1e-10
```

That is roughly five orders of magnitude tighter than `float32`'s own representational limit on
the inputs, and utterly negligible for a mean of `[0, 1]` values. There is no accuracy gap left
for Kahan to close.

## Why Kahan is off by default — the cost

Kahan trades **compute for precision we already have**:

1. **~4× the arithmetic per element** — four operations and an extra running variable instead of
   a single add.
2. **It defeats vectorization (the dominant cost).** The compensation is inherently sequential:
   each step depends on the previous `s` and `c`, so it cannot be expressed as one vectorized
   `np.sum`. In pure Python a per-element loop over ~10⁴ values per file across up to 200k files
   (~2 × 10⁹ numbers) is orders of magnitude slower than the C/SIMD `np.sum` path. Even a blocked
   vectorized Kahan does several array passes and loses the single-pass advantage.

So enabling Kahan would convert the fastest, accurate-enough path into a slower one for an
improvement we cannot observe at this scale.

## Decision

- **Default:** accumulate in `float64`, sum with NumPy (pairwise), merge partials up the tree.
- **Lever:** Kahan is a documented, off-by-default switch for the summation step — turn it on only
  if a future workload needs bit-exact sums (e.g. wildly different magnitudes or far larger `n`).
  It is an *orthogonal refinement* of how we add, not an alternative to the `(sum, count)` monoid.

See [ITD 2](../ITD/itd-decisions.md) for the decision record.
