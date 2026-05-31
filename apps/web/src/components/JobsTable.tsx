"use client";

import Link from "next/link";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { JobView } from "@aggregate/shared";

import { JobProgress } from "@/components/JobProgress";
import { StatusChip } from "@/components/StatusChip";

type JobsTableProps = {
  readonly jobs: JobView[];
  readonly onCancel: (jobId: string) => void;
  readonly cancelPending: boolean;
};

function formatSubmittedAt(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatEndedAt(ms: number | undefined): string {
  return ms === undefined ? "-" : new Date(ms).toLocaleString();
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return "-";
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function compactJobId(jobId: string): string {
  if (jobId.length <= 18) {
    return jobId;
  }
  return `${jobId.slice(0, 10)}...${jobId.slice(-6)}`;
}

export function JobsTable({ jobs, onCancel, cancelPending }: JobsTableProps): React.JSX.Element {
  if (jobs.length === 0) {
    return (
      <Paper sx={{ p: 3 }}>
        <Typography color="text.secondary">No jobs yet. Submit one to begin.</Typography>
      </Paper>
    );
  }

  return (
    <TableContainer component={Paper}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Job</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>F</TableCell>
            <TableCell>C</TableCell>
            <TableCell>Progress</TableCell>
            <TableCell>Submitted</TableCell>
            <TableCell>Ended</TableCell>
            <TableCell>Total time</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {jobs.map((job) => (
            <TableRow hover key={job.jobId}>
              <TableCell>
                <Typography variant="body2" sx={{ fontFamily: "monospace" }} title={job.jobId}>
                  {compactJobId(job.jobId)}
                </Typography>
              </TableCell>
              <TableCell>
                <StatusChip status={job.status} />
              </TableCell>
              <TableCell>{job.F}</TableCell>
              <TableCell>{job.C}</TableCell>
              <TableCell>
                <JobProgress percent={job.percent} />
              </TableCell>
              <TableCell>{formatSubmittedAt(job.submittedAt)}</TableCell>
              <TableCell>{formatEndedAt(job.endedAt)}</TableCell>
              <TableCell>{formatDuration(job.durationMs)}</TableCell>
              <TableCell align="right">
                <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
                  <Button size="small" component={Link} href={`/jobs/${job.jobId}`} variant="outlined">
                    Open ↗
                  </Button>
                  {job.status === "GENERATING" || job.status === "PENDING" || job.status === "RUNNING" ? (
                    <Button
                      size="small"
                      color="error"
                      disabled={cancelPending}
                      onClick={() => onCancel(job.jobId)}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </Stack>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
