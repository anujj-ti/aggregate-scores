"""Ready-pool claiming behavior tests."""

from __future__ import annotations

from threading import Thread

from fakes import FakeJobStore, seeded_job


def test_claims_are_disjoint_when_called_concurrently() -> None:
    """Concurrent claimers should never receive overlapping ready rows."""
    store = FakeJobStore()
    job = seeded_job(
        job_id="job_claim",
        f=30,
        c=2,
        reductions_remaining=5,
        leaf_tasks_total=6,
        leaf_tasks_done=6,
        ready_count=8,
        claimed_count=0,
    )
    store.seed_job(state=job)
    for seq in range(1, 9):
        store.put_ready_partial(
            job_id="job_claim",
            seq=seq,
            partial_key=f"jobs/job_claim/partials/{seq:08d}.npz",
            count=1,
            level=0,
        )

    claims: list[list[int]] = []

    def runner(count: int) -> None:
        rows = store.claim_ready(job_id="job_claim", count=count)
        claims.append([row.seq for row in rows])

    t1 = Thread(target=runner, args=(5,))
    t2 = Thread(target=runner, args=(3,))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    flattened = [seq for entry in claims for seq in entry]
    assert sorted(flattened) == [1, 2, 3, 4, 5, 6, 7, 8]
    assert len(flattened) == len(set(flattened))


def test_over_claim_is_rejected() -> None:
    """Claim should fail when requested count exceeds available rows."""
    store = FakeJobStore()
    job = seeded_job(
        job_id="job_small",
        f=10,
        c=2,
        reductions_remaining=1,
        leaf_tasks_total=2,
        leaf_tasks_done=2,
        ready_count=2,
        claimed_count=0,
    )
    store.seed_job(state=job)
    for seq in range(1, 3):
        store.put_ready_partial(
            job_id="job_small",
            seq=seq,
            partial_key=f"jobs/job_small/partials/{seq:08d}.npz",
            count=1,
            level=0,
        )

    assert store.claim_ready(job_id="job_small", count=3) == []
