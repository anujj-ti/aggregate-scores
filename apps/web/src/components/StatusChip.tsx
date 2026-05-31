"use client";

import Chip from "@mui/material/Chip";
import type { JobStatus } from "@aggregate/shared";

type StatusChipProps = {
  readonly status: JobStatus;
};

const CHIP_COLOR: Record<
  JobStatus,
  "default" | "primary" | "secondary" | "warning" | "success" | "error" | "info"
> = {
  GENERATING: "secondary",
  PENDING: "default",
  RUNNING: "warning",
  COMPLETE: "success",
  FAILED: "error",
  CANCELLED: "info",
};

export function StatusChip({ status }: StatusChipProps): React.JSX.Element {
  return <Chip label={status} color={CHIP_COLOR[status]} size="small" />;
}
