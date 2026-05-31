"use client";

import * as React from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { ArchitectureFlow } from "@/components/ArchitectureFlow";
import { DocsExplorer } from "@/components/DocsExplorer";

export default function ArchitecturePage(): React.JSX.Element {
  return (
    <Stack spacing={2}>
      <Typography variant="h4" sx={{ mb: 2 }}>
        System Architecture
      </Typography>
      <ArchitectureFlow />
      <DocsExplorer />
    </Stack>
  );
}
