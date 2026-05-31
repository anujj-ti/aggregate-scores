"use client";

import { useRouter } from "next/navigation";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { SubmitJobForm } from "@/components/SubmitJobForm";
import { useSubmitJob } from "@/lib/hooks";

export default function NewJobPage(): React.JSX.Element {
  const router = useRouter();
  const submitMutation = useSubmitJob();

  return (
    <Stack spacing={2}>
      <Typography variant="h4">Create new job</Typography>
      <SubmitJobForm
        pending={submitMutation.isPending}
        onSubmit={async (payload, freq) => {
          let lastCreatedJobId = "";
          for (let index = 0; index < freq; index += 1) {
            const created = await submitMutation.mutateAsync(payload);
            lastCreatedJobId = created.jobId;
          }
          if (freq === 1) {
            router.push(`/jobs/${lastCreatedJobId}`);
            return;
          }
          router.push("/");
        }}
      />
    </Stack>
  );
}
