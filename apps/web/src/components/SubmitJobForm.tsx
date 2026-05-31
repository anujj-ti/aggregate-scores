"use client";

import * as React from "react";
import { createJobRequestSchema, type CreateJobRequest } from "@aggregate/shared";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

type SubmitJobFormProps = {
  readonly pending: boolean;
  readonly onSubmit: (payload: CreateJobRequest, freq: number) => Promise<void>;
};

export function SubmitJobForm({ pending, onSubmit }: SubmitJobFormProps): React.JSX.Element {
  const [f, setF] = React.useState("12");
  const [c, setC] = React.useState("3");
  const [freq, setFreq] = React.useState("1");
  const [reuseSampleFile, setReuseSampleFile] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    const parsed = createJobRequestSchema.safeParse({
      F: Number.parseInt(f, 10),
      C: Number.parseInt(c, 10),
      reuseSampleFile,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    const parsedFreq = Number.parseInt(freq, 10);
    if (Number.isNaN(parsedFreq) || parsedFreq < 1) {
      setError("freq must be an integer >= 1");
      return;
    }
    await onSubmit(parsed.data, parsedFreq);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    void submit(event);
  };

  return (
    <Paper sx={{ p: 3 }}>
      <form onSubmit={handleSubmit}>
        <Stack spacing={2}>
          <Typography variant="h6">Submit Job</Typography>
          {error !== null ? <Alert severity="error">{error}</Alert> : null}
          <TextField
            label="F (number of files)"
            type="number"
            value={f}
            onChange={(event) => setF(event.target.value)}
            slotProps={{ htmlInput: { min: 1 } }}
            required
          />
          <TextField
            label="C (vector length)"
            type="number"
            value={c}
            onChange={(event) => setC(event.target.value)}
            slotProps={{ htmlInput: { min: 1 } }}
            required
          />
          <TextField
            label="freq (submit count)"
            type="number"
            value={freq}
            onChange={(event) => setFreq(event.target.value)}
            slotProps={{ htmlInput: { min: 1 } }}
            required
          />
          <Typography variant="caption" color="text.secondary">
            Sends the same job request this many times from the frontend. Example: freq=5 creates 5
            jobs with the same F/C/reuse settings.
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={reuseSampleFile}
                onChange={(event) => setReuseSampleFile(event.target.checked)}
              />
            }
            label="Reuse one sample file for all inputs (faster, test mode)"
          />
          <Typography variant="caption" color="text.secondary">
            {reuseSampleFile
              ? "Generates one random vector and copies it to all F inputs. The mean equals that vector, so results stay easy to verify."
              : "Generates F independent random vectors in parallel."}
          </Typography>
          <Button type="submit" variant="contained" disabled={pending}>
            {pending ? "Submitting..." : "Submit"}
          </Button>
        </Stack>
      </form>
    </Paper>
  );
}
