import type { FleetView, JobView } from "@aggregate/shared";
import { CHUNK_SIZE } from "@aggregate/shared";

export type FleetDerivedMetrics = {
  readonly configuredWorkers: number;
  readonly inFlightTasks: number;
  readonly busyWorkers: number;
  readonly idleWorkers: number;
  readonly bufferedTasks: number;
  readonly workerUtilizationRatio: number;
  readonly workerUtilizationPercent: number;
};

export type QueueHealthMetrics = {
  readonly generatingJobs: number;
  readonly pendingJobs: number;
  readonly runningJobs: number;
  readonly completedJobs: number;
  readonly failedJobs: number;
  readonly cancelledJobs: number;
  readonly totalJobs: number;
};

// "Work units" follow an operator-friendly step model:
//   F (file-read steps) + ceil(F/5) + ceil(F/25) + ... + 1 (finalize divide/write)
// This mirrors the visible execution tree better than a pure reductions-only denominator.
export type TaskRuntimeMetrics = {
  readonly workUnitsDone: number;
  readonly workUnitsTotal: number;
  readonly reductionsRemaining: number;
  readonly activeJobs: number;
};

export function deriveFleetMetrics(fleet: FleetView): FleetDerivedMetrics {
  const configuredWorkers = Math.max(0, fleet.W);
  const inFlightTasks = Math.max(0, fleet.inFlight);
  const busyWorkers = Math.min(configuredWorkers, inFlightTasks);
  const idleWorkers = Math.max(0, configuredWorkers - busyWorkers);
  const bufferedTasks = Math.max(0, inFlightTasks - configuredWorkers);
  const workerUtilizationRatio = configuredWorkers === 0 ? 0 : busyWorkers / configuredWorkers;
  const workerUtilizationPercent = Math.round(workerUtilizationRatio * 100);

  return {
    configuredWorkers,
    inFlightTasks,
    busyWorkers,
    idleWorkers,
    bufferedTasks,
    workerUtilizationRatio,
    workerUtilizationPercent,
  };
}

export function deriveQueueHealthMetrics(jobs: JobView[]): QueueHealthMetrics {
  let generatingJobs = 0;
  let pendingJobs = 0;
  let runningJobs = 0;
  let completedJobs = 0;
  let failedJobs = 0;
  let cancelledJobs = 0;

  for (const job of jobs) {
    if (job.status === "GENERATING") {
      generatingJobs += 1;
    } else if (job.status === "PENDING") {
      pendingJobs += 1;
    } else if (job.status === "RUNNING") {
      runningJobs += 1;
    } else if (job.status === "COMPLETE") {
      completedJobs += 1;
    } else if (job.status === "FAILED") {
      failedJobs += 1;
    } else if (job.status === "CANCELLED") {
      cancelledJobs += 1;
    }
  }

  return {
    generatingJobs,
    pendingJobs,
    runningJobs,
    completedJobs,
    failedJobs,
    cancelledJobs,
    totalJobs: jobs.length,
  };
}

function leafTasksTotalForJob(job: JobView): number {
  // Exact once the job is RUNNING (counter is stored); before that it is the deterministic
  // ceil(F / CHUNK_SIZE), which is what admission will compute.
  if (job.leafTasksTotal !== undefined) {
    return Math.max(0, job.leafTasksTotal);
  }
  return Math.ceil(job.F / CHUNK_SIZE);
}

function planLevelTaskCounts(f: number, chunkSizeUsed: number): number[] {
  const chunk = Math.max(1, chunkSizeUsed);
  const levels: number[] = [];
  let remaining = Math.max(1, f);
  while (true) {
    const tasksAtLevel = Math.max(1, Math.ceil(remaining / chunk));
    levels.push(tasksAtLevel);
    if (tasksAtLevel <= 1) {
      return levels;
    }
    remaining = tasksAtLevel;
  }
}

function plannedWorkUnitsForJob(job: JobView): number {
  const chunkSizeUsed = job.chunkSizeUsed ?? CHUNK_SIZE;
  const levelTaskCounts = planLevelTaskCounts(job.F, chunkSizeUsed);
  const taskSteps = levelTaskCounts.reduce((sum, count) => sum + count, 0);
  // +1 for the final divide/write result step.
  return Math.max(0, job.F + taskSteps + 1);
}

function estimateFileStepsDone(job: JobView, leafDone: number): number {
  const chunkSizeUsed = Math.max(1, job.chunkSizeUsed ?? CHUNK_SIZE);
  return Math.min(job.F, Math.max(0, leafDone) * chunkSizeUsed);
}

function computeWorkUnitsForJob(job: JobView): { done: number; total: number } {
  const totalUnits = plannedWorkUnitsForJob(job);
  if (totalUnits === 0) {
    return { done: 0, total: 0 };
  }

  if (job.status === "COMPLETE") {
    return { done: totalUnits, total: totalUnits };
  }
  if (job.status === "PENDING" || job.status === "GENERATING") {
    return { done: 0, total: totalUnits };
  }
  if (job.status === "FAILED" || job.status === "CANCELLED") {
    // Terminal but unfinished jobs are excluded from active runtime by caller;
    // keep this safe fallback for direct function use.
    return { done: 0, total: totalUnits };
  }

  // RUNNING: estimate progress from persisted counters.
  const leafTasksTotal = leafTasksTotalForJob(job);
  const leafDone = Math.max(0, job.leafTasksDone ?? 0);
  const fileStepsDone = estimateFileStepsDone(job, leafDone);
  const chunkSizeUsed = Math.max(1, job.chunkSizeUsed ?? CHUNK_SIZE);
  const levelTaskCounts = planLevelTaskCounts(job.F, chunkSizeUsed);
  const mergeTasksTotal = Math.max(
    0,
    levelTaskCounts.reduce((sum, count) => sum + count, 0) - levelTaskCounts[0]
  );

  const reductionsTotal = Math.max(0, leafTasksTotal - 1);
  const reductionsCompleted = Math.max(0, reductionsTotal - job.reductionsRemaining);
  const mergeTasksDoneEstimate =
    reductionsTotal === 0
      ? 0
      : Math.min(
          mergeTasksTotal,
          Math.round((reductionsCompleted / reductionsTotal) * mergeTasksTotal)
        );

  const done = Math.min(
    totalUnits,
    fileStepsDone + leafDone + mergeTasksDoneEstimate
  );
  return { done, total: totalUnits };
}

export function deriveTaskRuntimeMetrics(jobs: JobView[]): TaskRuntimeMetrics {
  let workUnitsDone = 0;
  let workUnitsTotal = 0;
  let reductionsRemaining = 0;
  let activeJobs = 0;

  for (const job of jobs) {
    const isActive =
      job.status === "GENERATING" || job.status === "PENDING" || job.status === "RUNNING";
    if (!isActive) {
      continue;
    }
    activeJobs += 1;
    const progress = computeWorkUnitsForJob(job);
    workUnitsDone += progress.done;
    workUnitsTotal += progress.total;
    if (job.status === "RUNNING") {
      reductionsRemaining += job.reductionsRemaining;
    }
  }

  return {
    workUnitsDone,
    workUnitsTotal,
    reductionsRemaining,
    activeJobs,
  };
}
