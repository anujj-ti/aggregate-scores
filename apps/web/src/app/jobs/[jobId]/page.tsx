"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TablePagination from "@mui/material/TablePagination";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { ADMISSION_FACTOR_K } from "@aggregate/shared";

import { JobProgress } from "@/components/JobProgress";
import { StatusChip } from "@/components/StatusChip";
import { useCancelJob, useFleet, useJob } from "@/lib/hooks";

export default function JobDetailPage(): React.JSX.Element {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId ?? "";
  const jobQuery = useJob(jobId);
  const fleetQuery = useFleet();
  const cancelJobMutation = useCancelJob();
  const [manifestPage, setManifestPage] = React.useState(0);
  const [manifestRowsPerPage, setManifestRowsPerPage] = React.useState(5);
  const [levelPage, setLevelPage] = React.useState(0);
  const [levelRowsPerPage, setLevelRowsPerPage] = React.useState(25);

  // Hooks must run on every render, so derive the CSV before any early return.
  const manifestPreview = jobQuery.data?.inputManifestPreview;
  const inputManifestCsv = React.useMemo(() => {
    if (manifestPreview === undefined || manifestPreview.length === 0) {
      return "";
    }
    const header = "fileIndex,inputKey,plannedLeafTaskId,plannedLeafLevel";
    const body = manifestPreview
      .map((row) => `${row.fileIndex},"${row.inputKey}","${row.plannedLeafTaskId}",${row.plannedLeafLevel}`)
      .join("\n");
    return `${header}\n${body}`;
  }, [manifestPreview]);

  React.useEffect(() => {
    setManifestPage(0);
  }, [jobQuery.data?.inputManifestPreview?.length]);
  React.useEffect(() => {
    setLevelPage(0);
  }, [jobQuery.data?.taskSummary?.byLevel.length]);

  if (jobQuery.isLoading) {
    return <Typography>Loading job...</Typography>;
  }

  if (jobQuery.error !== null) {
    return <Alert severity="error">{jobQuery.error.message}</Alert>;
  }

  if (jobQuery.data === undefined) {
    return <Alert severity="warning">Job not found.</Alert>;
  }

  const job = jobQuery.data;
  const fleet = fleetQuery.data;
  const inFlightTarget = fleet === undefined ? undefined : fleet.W * ADMISSION_FACTOR_K;
  const admissionBlocked =
    job.status === "PENDING" &&
    inFlightTarget !== undefined &&
    fleet !== undefined &&
    fleet.inFlight >= inFlightTarget;
  const liveTaskSummary = job.taskSummary;
  const manifestRows = job.inputManifestPreview ?? [];
  const manifestPageRows = manifestRows.slice(
    manifestPage * manifestRowsPerPage,
    manifestPage * manifestRowsPerPage + manifestRowsPerPage
  );
  const byLevelRows = liveTaskSummary?.byLevel ?? [];
  const byLevelPageRows = byLevelRows.slice(
    levelPage * levelRowsPerPage,
    levelPage * levelRowsPerPage + levelRowsPerPage
  );
  const totalTasks = liveTaskSummary?.total ?? 0;
  const inputManifestCsvHref =
    inputManifestCsv.length > 0 ? `data:text/csv;charset=utf-8,${encodeURIComponent(inputManifestCsv)}` : "";

  return (
    <Stack spacing={2}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Typography variant="h4">Job {job.jobId}</Typography>
        <Button component={Link} href="/">
          Back to dashboard
        </Button>
      </Box>

      <Paper sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Box>
            <StatusChip status={job.status} />
          </Box>
          <JobProgress percent={job.percent} />
          <Typography variant="body2">F: {job.F}</Typography>
          <Typography variant="body2">C: {job.C}</Typography>
          <Typography variant="body2">Chunk size used: {job.chunkSizeUsed ?? "Not started yet"}</Typography>
          <Typography variant="body2">
            Submitted: {new Date(job.submittedAt).toLocaleString()}
          </Typography>
          <Typography variant="body2">Reductions remaining: {job.reductionsRemaining}</Typography>
          {job.queuePosition !== undefined ? (
            <Typography variant="body2">Queue position: {job.queuePosition}</Typography>
          ) : null}
          {job.leafTasksTotal !== undefined ? (
            <Typography variant="body2">
              Leaf tasks done: {job.leafTasksDone ?? 0}/{job.leafTasksTotal}
            </Typography>
          ) : null}
          {job.readyCount !== undefined ? (
            <Typography variant="body2">
              Ready partials: {job.readyCount} (claimed: {job.claimedCount ?? 0})
            </Typography>
          ) : null}
          {job.status === "GENERATING" ? (
            <Alert severity="info">
              Generating {job.F} input file(s) in the background. The job will move to the queue once
              its inputs are ready — the worker fleet never waits on this phase.
            </Alert>
          ) : null}

          {job.status === "PENDING" ? (
            <Alert severity={admissionBlocked ? "warning" : "info"}>
              {admissionBlocked && fleet !== undefined && inFlightTarget !== undefined
                ? `Inputs ready. Waiting for admission capacity: in-flight tasks ${fleet.inFlight}/${inFlightTarget} (W=${fleet.W}, K=${ADMISSION_FACTOR_K}).`
                : "Inputs ready. Queued and waiting to be admitted by the dispatcher."}
            </Alert>
          ) : null}

          <Divider />
          <Stack direction={{ xs: "column", md: "row" }} spacing={1} sx={{ alignItems: { md: "center" } }}>
            <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
              Quick downloads
            </Typography>
            {job.status !== "GENERATING" ? (
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                <Button
                  variant="outlined"
                  size="small"
                  component="a"
                  href={`/api/jobs/${job.jobId}/inputs/0`}
                >
                  {job.reuseSampleFile === true
                    ? "Download one input (.npy, all same)"
                    : "Download one input (.npy)"}
                </Button>
                <Button
                  variant="contained"
                  size="small"
                  component="a"
                  href={`/api/jobs/${job.jobId}/archive`}
                >
                  Download all files (.zip)
                </Button>
                {job.status === "COMPLETE" && job.resultUrl !== undefined ? (
                  <Button href={job.resultUrl} target="_blank" rel="noreferrer" variant="contained" size="small">
                    Download result.csv
                  </Button>
                ) : null}
              </Stack>
            ) : (
              <Chip color="info" label="Downloads unlock after GENERATING completes" />
            )}
          </Stack>

          <Typography variant="subtitle2">Input file mapping (for output verification)</Typography>
          <Typography variant="body2" color="text.secondary">
            Total input files: {job.F}. Planned chunk size: {job.chunkSizeUsed ?? "unknown"}.
          </Typography>
          <Alert severity={job.reuseSampleFile === true ? "warning" : "info"}>
            {job.reuseSampleFile === true
              ? `Generation mode: reused sample file — one random vector was copied to all ${job.F} inputs (test speedup). Every input .npy is byte-identical, so downloading one input is enough for verification.`
              : `Generation mode: distinct files — each of the ${job.F} inputs is an independent random vector.`}
          </Alert>
          {inputManifestCsvHref.length > 0 ? (
            <Button
              variant="outlined"
              size="small"
              component="a"
              href={inputManifestCsvHref}
              download={`${job.jobId}-input-manifest-preview.csv`}
            >
              Download input manifest preview (CSV)
            </Button>
          ) : null}
          {manifestRows.length > 0 ? (
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle2">Input manifest preview ({manifestRows.length} rows)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>File #</TableCell>
                        <TableCell>Input key</TableCell>
                        <TableCell>Planned leaf task</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {manifestPageRows.map((row) => (
                        <TableRow key={`${row.fileIndex}-${row.plannedLeafTaskId}`}>
                          <TableCell>{row.fileIndex}</TableCell>
                          <TableCell>{row.inputKey}</TableCell>
                          <TableCell>{row.plannedLeafTaskId}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={manifestRows.length}
                  page={manifestPage}
                  onPageChange={(_, page) => setManifestPage(page)}
                  rowsPerPage={manifestRowsPerPage}
                  onRowsPerPageChange={(event) => {
                    setManifestRowsPerPage(Number.parseInt(event.target.value, 10));
                    setManifestPage(0);
                  }}
                  rowsPerPageOptions={[5, 10, 25]}
                />
              </AccordionDetails>
            </Accordion>
          ) : null}

          {liveTaskSummary !== undefined ? (
            <Stack direction={{ xs: "column", md: "row" }} spacing={1}>
              <Paper variant="outlined" sx={{ p: 1.25, flex: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  QUEUED TASKS
                </Typography>
                <Typography variant="h6">{liveTaskSummary.queued}</Typography>
              </Paper>
              <Paper variant="outlined" sx={{ p: 1.25, flex: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  IN PROGRESS
                </Typography>
                <Typography variant="h6">{liveTaskSummary.inProgress}</Typography>
              </Paper>
              <Paper variant="outlined" sx={{ p: 1.25, flex: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  DONE
                </Typography>
                <Typography variant="h6">{liveTaskSummary.done}</Typography>
              </Paper>
              <Paper variant="outlined" sx={{ p: 1.25, flex: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  FAILED
                </Typography>
                <Typography variant="h6">{liveTaskSummary.failed}</Typography>
              </Paper>
            </Stack>
          ) : null}

          {liveTaskSummary !== undefined && byLevelRows.length > 0 ? (
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle2">
                  Task breakdown by level — full job ({byLevelRows.length} levels, {totalTasks} tasks)
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  Complete counts across all {totalTasks} tasks. Level 0 = leaf reads of input files;
                  each higher level is a merge whose level is max(input levels) + 1.
                </Typography>
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Level</TableCell>
                        <TableCell>Queued</TableCell>
                        <TableCell>In progress</TableCell>
                        <TableCell>Done</TableCell>
                        <TableCell>Failed</TableCell>
                        <TableCell>Total</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {byLevelPageRows.map((row) => (
                        <TableRow key={row.level}>
                          <TableCell>{row.level}</TableCell>
                          <TableCell>{row.queued}</TableCell>
                          <TableCell>{row.inProgress}</TableCell>
                          <TableCell>{row.done}</TableCell>
                          <TableCell>{row.failed}</TableCell>
                          <TableCell>{row.total}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={byLevelRows.length}
                  page={levelPage}
                  onPageChange={(_, page) => setLevelPage(page)}
                  rowsPerPage={levelRowsPerPage}
                  onRowsPerPageChange={(event) => {
                    setLevelRowsPerPage(Number.parseInt(event.target.value, 10));
                    setLevelPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50]}
                />
              </AccordionDetails>
            </Accordion>
          ) : null}

          {job.status === "PENDING" || job.status === "RUNNING" ? (
            <Button
              color="error"
              variant="outlined"
              disabled={cancelJobMutation.isPending}
              onClick={() => {
                void cancelJobMutation.mutateAsync(job.jobId);
              }}
            >
              Cancel job
            </Button>
          ) : null}

          {job.status === "CANCELLED" ? (
            <Alert severity="info">Job was cancelled by operator request.</Alert>
          ) : null}

          {job.status === "FAILED" && job.error !== undefined ? (
            <Alert severity="error">{job.error}</Alert>
          ) : null}
        </Stack>
      </Paper>
    </Stack>
  );
}
