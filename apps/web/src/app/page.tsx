"use client";

import * as React from "react";
import Link from "next/link";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { LineChart } from "@mui/x-charts/LineChart";

import { FleetSummary } from "@/components/FleetSummary";
import { JobsTable } from "@/components/JobsTable";
import {
  deriveFleetMetrics,
  deriveQueueHealthMetrics,
  deriveTaskRuntimeMetrics,
} from "@/lib/dashboard-metrics";
import { useCancelJob, useFleet, useJobs, useSetWorkers } from "@/lib/hooks";

export default function DashboardPage(): React.JSX.Element {
  const jobsQuery = useJobs();
  const fleetQuery = useFleet();
  const setWorkersMutation = useSetWorkers();
  const cancelJobMutation = useCancelJob();
  const [workersInput, setWorkersInput] = React.useState("5");
  const [taskDoneHistory, setTaskDoneHistory] = React.useState<Array<{ atMs: number; done: number }>>([]);
  const jobs = jobsQuery.data ?? [];
  const queueHealth = deriveQueueHealthMetrics(jobs);
  const taskRuntime = deriveTaskRuntimeMetrics(jobs);
  const effectiveFleet =
    fleetQuery.data !== undefined && queueHealth.runningJobs === 0
      ? { ...fleetQuery.data, inFlight: 0 }
      : fleetQuery.data;
  const fleetMetrics = effectiveFleet !== undefined ? deriveFleetMetrics(effectiveFleet) : undefined;
  const queueDepth = queueHealth.generatingJobs + queueHealth.pendingJobs;
  const lastRefreshedAtMs = Math.max(fleetQuery.dataUpdatedAt, jobsQuery.dataUpdatedAt);
  const lastRefreshedLabel =
    lastRefreshedAtMs > 0 ? new Date(lastRefreshedAtMs).toLocaleTimeString() : "Waiting for data...";

  React.useEffect(() => {
    if (fleetQuery.data !== undefined) {
      setWorkersInput(String(fleetQuery.data.W));
    }
  }, [fleetQuery.data]);

  React.useEffect(() => {
    if (lastRefreshedAtMs <= 0) {
      return;
    }
    setTaskDoneHistory((previous) => {
      const last = previous.at(-1);
      const point = { atMs: lastRefreshedAtMs, done: taskRuntime.workUnitsDone };
      if (last !== undefined && last.atMs === point.atMs) {
        return [...previous.slice(0, -1), point];
      }
      return [...previous, point].slice(-30);
    });
  }, [lastRefreshedAtMs, taskRuntime.workUnitsDone]);

  const submitWorkers = async (): Promise<void> => {
    const value = Number.parseInt(workersInput, 10);
    if (Number.isNaN(value)) {
      return;
    }
    await setWorkersMutation.mutateAsync(value);
  };

  return (
    <Stack spacing={3}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Box>
          <Typography variant="h4">Local Operator Dashboard</Typography>
          <Typography variant="body2" color="text.secondary">
            Last refreshed: {lastRefreshedLabel}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button component={Link} href="/jobs/new" variant="contained">
            Submit Job
          </Button>
        </Stack>
      </Box>

      {fleetQuery.error !== null ? <Alert severity="error">{fleetQuery.error.message}</Alert> : null}
      {effectiveFleet !== undefined ? <FleetSummary fleet={effectiveFleet} /> : null}

      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
        <Paper sx={{ p: 1.5, flex: 1 }}>
          <Tooltip title="Jobs waiting before execution: GENERATING + PENDING.">
            <Typography variant="overline" color="primary.main">
              Queue depth
            </Typography>
          </Tooltip>
          <Typography variant="h5">{queueDepth}</Typography>
          <Typography variant="caption" color="text.secondary">
            waiting jobs total
          </Typography>
        </Paper>
        <Paper sx={{ p: 1.5, flex: 1 }}>
          <Tooltip title="Jobs currently writing input .npy files; not yet eligible for admission.">
            <Typography variant="overline" color="secondary.main">
              Generating inputs
            </Typography>
          </Tooltip>
          <Typography variant="h5">{queueHealth.generatingJobs}</Typography>
          <Typography variant="caption" color="text.secondary">
            input materialization stage
          </Typography>
        </Paper>
        <Paper sx={{ p: 1.5, flex: 1 }}>
          <Tooltip title="Inputs are ready; waiting for dispatcher admission capacity.">
            <Typography variant="overline" color="warning.main">
              Pending jobs
            </Typography>
          </Tooltip>
          <Typography variant="h5">{queueHealth.pendingJobs}</Typography>
          <Typography variant="caption" color="text.secondary">
            queue waiting for admission
          </Typography>
        </Paper>
        <Paper sx={{ p: 1.5, flex: 1 }}>
          <Tooltip title="Jobs currently executing leaf/merge work in the worker pipeline.">
            <Typography variant="overline" color="info.main">
              Running jobs
            </Typography>
          </Tooltip>
          <Typography variant="h5">{queueHealth.runningJobs}</Typography>
          <Typography variant="caption" color="text.secondary">
            active execution
          </Typography>
        </Paper>
        <Paper sx={{ p: 1.5, flex: 1 }}>
          <Tooltip title="Jobs that finished and produced result.csv.">
            <Typography variant="overline" color="success.main">
              Completed jobs
            </Typography>
          </Tooltip>
          <Typography variant="h5">{queueHealth.completedJobs}</Typography>
          <Typography variant="caption" color="text.secondary">
            successful results ready
          </Typography>
        </Paper>
        <Paper sx={{ p: 1.5, flex: 1 }}>
          <Tooltip title="Jobs that terminated due to an error.">
            <Typography variant="overline" color="error.main">
              Failed jobs
            </Typography>
          </Tooltip>
          <Typography variant="h5">{queueHealth.failedJobs}</Typography>
          <Typography variant="caption" color="text.secondary">
            require operator review
          </Typography>
        </Paper>
        <Paper sx={{ p: 1.5, flex: 1 }}>
          <Tooltip title="Jobs explicitly cancelled by operator action.">
            <Typography variant="overline" color="info.main">
              Cancelled jobs
            </Typography>
          </Tooltip>
          <Typography variant="h5">{queueHealth.cancelledJobs}</Typography>
          <Typography variant="caption" color="text.secondary">
            stopped intentionally
          </Typography>
        </Paper>
      </Stack>

      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
        <Paper sx={{ p: 1.5, flex: 1 }}>
          <Tooltip title="Completed steps across ACTIVE jobs (GENERATING/PENDING/RUNNING): files read + task-tree nodes done.">
            <Typography variant="overline" color="success.main">
              Work units done
            </Typography>
          </Tooltip>
          <Typography variant="h5">{taskRuntime.workUnitsDone}</Typography>
          <Typography variant="caption" color="text.secondary">
            active jobs only ({taskRuntime.activeJobs})
          </Typography>
        </Paper>
        <Paper sx={{ p: 1.5, flex: 1 }}>
          <Tooltip title="Planned steps across ACTIVE jobs: F + ceil(F/5) + ceil(F/25) + ... + 1 finalize.">
            <Typography variant="overline" color="text.secondary">
              Total work units
            </Typography>
          </Tooltip>
          <Typography variant="h5">{taskRuntime.workUnitsTotal}</Typography>
          <Typography variant="caption" color="text.secondary">
            files + tree levels + finalize
          </Typography>
        </Paper>
        <Paper sx={{ p: 1.5, flex: 1 }}>
          <Tooltip title="How many reductions are left in currently RUNNING jobs (merge work only).">
            <Typography variant="overline" color="warning.main">
              Remaining reductions
            </Typography>
          </Tooltip>
          <Typography variant="h5">{taskRuntime.reductionsRemaining}</Typography>
          <Typography variant="caption" color="text.secondary">
            merge work still queued/in progress
          </Typography>
        </Paper>
        <Paper sx={{ p: 1.5, flex: 1 }}>
          <Tooltip title="In-flight tasks beyond W (admitted but waiting for a worker slot).">
            <Typography variant="overline" color="warning.main">
              Buffered tasks
            </Typography>
          </Tooltip>
          <Typography variant="h5">{fleetMetrics?.bufferedTasks ?? 0}</Typography>
          <Typography variant="caption" color="text.secondary">
            admission backlog beyond worker slots
          </Typography>
        </Paper>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>
          Task completion trend
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Curve shows cumulative work units (leaf tasks + reductions) done over recent poll intervals.
        </Typography>
        {taskDoneHistory.length >= 2 ? (
          <LineChart
            height={220}
            xAxis={[
              {
                scaleType: "point",
                data: taskDoneHistory.map((point) => new Date(point.atMs).toLocaleTimeString()),
              },
            ]}
            series={[
              {
                data: taskDoneHistory.map((point) => point.done),
                color: "#60a5fa",
                label: "Work units done",
                showMark: true,
              },
            ]}
            margin={{ left: 48, right: 16, top: 16, bottom: 36 }}
          />
        ) : (
          <Alert severity="info">Waiting for a few polling samples to draw the curve.</Alert>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Box
          sx={{
            display: "flex",
            gap: 2,
            flexDirection: { xs: "column", md: "row" },
            alignItems: { md: "center" },
          }}
        >
          <Typography variant="subtitle1" sx={{ minWidth: 200 }}>
            Worker control (W)
          </Typography>
          <TextField
            value={workersInput}
            onChange={(event) => setWorkersInput(event.target.value)}
            type="number"
            slotProps={{ htmlInput: { min: 0 } }}
          />
          <Button
            variant="outlined"
            onClick={() => void submitWorkers()}
            disabled={setWorkersMutation.isPending}
          >
            Apply
          </Button>
        </Box>
      </Paper>

      {jobsQuery.error !== null ? <Alert severity="error">{jobsQuery.error.message}</Alert> : null}
      <Box>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Jobs
        </Typography>
        <JobsTable
          jobs={jobs}
          onCancel={(jobId) => {
            void cancelJobMutation.mutateAsync(jobId);
          }}
          cancelPending={cancelJobMutation.isPending}
        />
      </Box>
    </Stack>
  );
}
