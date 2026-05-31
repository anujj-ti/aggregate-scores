"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";

type JobProgressProps = {
  readonly percent: number;
};

export function JobProgress({ percent }: JobProgressProps): React.JSX.Element {
  const value = Math.round(Math.min(Math.max(percent, 0), 1) * 100);
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 140 }}>
      <Box sx={{ width: "100%" }}>
        <LinearProgress variant="determinate" value={value} />
      </Box>
      <Typography variant="caption" color="text.secondary">
        {value}%
      </Typography>
    </Box>
  );
}
