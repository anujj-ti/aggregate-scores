"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { FleetView } from "@aggregate/shared";
import CircleIcon from "@mui/icons-material/Circle";
import { BarChart } from "@mui/x-charts/BarChart";

import { deriveFleetMetrics } from "@/lib/dashboard-metrics";

type FleetSummaryProps = {
  readonly fleet: FleetView;
};

export function FleetSummary({ fleet }: FleetSummaryProps): React.JSX.Element {
  const metrics = deriveFleetMetrics(fleet);
  const workers = Array.from({ length: metrics.configuredWorkers }, (_, index) => ({
    id: index + 1,
    isBusy: index < metrics.busyWorkers,
  }));

  return (
    <Paper sx={{ p: 2.5 }}>
      <Stack spacing={2.5}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1.5}
          sx={{ justifyContent: "space-between", alignItems: { md: "center" } }}
        >
          <Typography variant="h6">Fleet Overview</Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
            <Chip size="small" label={`W = ${metrics.configuredWorkers}`} color="primary" />
            <Chip
              size="small"
              label={`In-flight tasks = ${metrics.inFlightTasks}`}
              color="info"
              variant="outlined"
            />
            <Chip
              size="small"
              label={`Buffered tasks = ${metrics.bufferedTasks}`}
              color="warning"
              variant="outlined"
            />
          </Stack>
        </Stack>

        <Box>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            sx={{ justifyContent: "space-between", mb: 0.75 }}
          >
            <Typography variant="body2" color="text.secondary">
              Worker utilization
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {metrics.workerUtilizationPercent}% ({metrics.busyWorkers}/{metrics.configuredWorkers})
            </Typography>
          </Stack>
          <LinearProgress
            variant="determinate"
            value={metrics.workerUtilizationRatio * 100}
            sx={{ height: 10, borderRadius: 5 }}
          />
        </Box>

        <Divider />

        <Stack direction={{ xs: "column", lg: "row" }} spacing={2} sx={{ alignItems: "stretch" }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Worker states (estimated from W and in-flight tasks)
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
              <Chip size="small" label={`Busy: ${metrics.busyWorkers}`} color="warning" />
              <Chip size="small" label={`Available: ${metrics.idleWorkers}`} color="success" />
            </Stack>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: {
                  xs: "repeat(2, minmax(0, 1fr))",
                  sm: "repeat(3, minmax(0, 1fr))",
                  md: "repeat(4, minmax(0, 1fr))",
                },
                gap: 1,
              }}
            >
              {workers.map((worker) => (
                <Paper key={worker.id} variant="outlined" sx={{ p: 1 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <CircleIcon
                      fontSize="small"
                      sx={{ color: worker.isBusy ? "warning.main" : "success.main" }}
                    />
                    <Typography variant="body2">Worker-{worker.id}</Typography>
                  </Stack>
                </Paper>
              ))}
            </Box>
          </Box>

          <Box sx={{ flex: 1, minHeight: 190 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Task pressure view
            </Typography>
            <BarChart
              height={170}
              xAxis={[{ data: ["Tasks"], scaleType: "band" }]}
              series={[
                {
                  label: "Tasks executable now (<= W)",
                  data: [metrics.busyWorkers],
                  stack: "tasks",
                  color: "#22c55e",
                },
                {
                  label: "Buffered beyond W",
                  data: [metrics.bufferedTasks],
                  stack: "tasks",
                  color: "#f59e0b",
                },
              ]}
              margin={{ left: 44, right: 16, top: 12, bottom: 28 }}
            />
          </Box>
        </Stack>
      </Stack>
    </Paper>
  );
}
