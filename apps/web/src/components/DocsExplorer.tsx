"use client";

import * as React from "react";
import DescriptionIcon from "@mui/icons-material/Description";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ReactMarkdown from "react-markdown";

type DocEntry = {
  readonly label: string;
  readonly path: string;
};

const DOC_ENTRIES: readonly DocEntry[] = [
  { label: "Interview Guide (Q&A)", path: "interview-guide.md" },
  { label: "Architecture / README", path: "architecture/README.md" },
  { label: "Architecture / System Design", path: "architecture/system-design.md" },
  { label: "Architecture / Lifecycle", path: "architecture/lifecycle.md" },
  { label: "Architecture / Database", path: "architecture/database.md" },
  { label: "Architecture / Job Splitting", path: "architecture/job-splitting.md" },
  { label: "Architecture / Infrastructure", path: "architecture/infrastructure.md" },
  { label: "Architecture / Aggregation", path: "architecture/aggregation.md" },
  { label: "Architecture / Quality + CI", path: "architecture/quality-and-ci.md" },
  { label: "API / Contract", path: "api/api-contract.md" },
  { label: "Diagrams / Architecture", path: "diagrams/architecture.md" },
  { label: "Diagrams / Detailed Architecture & Data Flow", path: "diagrams/detailed-architecture.md" },
  { label: "Diagrams / ER", path: "diagrams/er-diagram.md" },
  { label: "ITD / Decisions", path: "ITD/itd-decisions.md" },
  { label: "Algorithms / Numerical Accuracy", path: "algos/numerical-accuracy.md" },
];

export function DocsExplorer(): React.JSX.Element {
  const [selectedPath, setSelectedPath] = React.useState<string>(DOC_ENTRIES[0].path);
  const [content, setContent] = React.useState<string>("");
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/docs/${selectedPath}`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Unable to load /docs/${selectedPath} (${response.status})`);
        }
        const markdown = await response.text();
        if (!active) {
          return;
        }
        setContent(markdown);
      } catch (loadError) {
        if (!active) {
          return;
        }
        const message = loadError instanceof Error ? loadError.message : String(loadError);
        setError(message);
        setContent("");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [selectedPath]);

  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Docs Explorer</Typography>
        <Typography variant="body2" color="text.secondary">
          Browse architecture docs from <code>/docs</code> and render markdown inline.
        </Typography>
        <Divider />
        <Stack direction={{ xs: "column", lg: "row" }} spacing={2} sx={{ alignItems: "stretch" }}>
          <Paper variant="outlined" sx={{ p: 1.5, minWidth: { lg: 340 }, maxHeight: 520, overflowY: "auto" }}>
            <Stack spacing={1}>
              {DOC_ENTRIES.map((entry) => (
                <Button
                  key={entry.path}
                  variant={entry.path === selectedPath ? "contained" : "outlined"}
                  color={entry.path === selectedPath ? "primary" : "inherit"}
                  onClick={() => setSelectedPath(entry.path)}
                  startIcon={<DescriptionIcon fontSize="small" />}
                  sx={{ justifyContent: "flex-start" }}
                >
                  {entry.label}
                </Button>
              ))}
            </Stack>
          </Paper>

          <Paper variant="outlined" sx={{ p: 2, flex: 1, minHeight: 520, overflow: "auto" }}>
            <Typography variant="caption" color="text.secondary">
              Viewing: /docs/{selectedPath}
            </Typography>
            {loading ? (
              <Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: "center" }}>
                <CircularProgress size={18} />
                <Typography variant="body2">Loading markdown...</Typography>
              </Stack>
            ) : error !== null ? (
              <Alert severity="error" sx={{ mt: 2 }}>
                {error}
              </Alert>
            ) : (
              <Box
                sx={{
                  mt: 1.5,
                  "& h1, & h2, & h3": { mt: 2, mb: 1, fontWeight: 700 },
                  "& p, & li": { color: "text.secondary" },
                  "& code": { fontFamily: "monospace", bgcolor: "rgba(148,163,184,0.15)", px: 0.5, borderRadius: 0.5 },
                  "& pre": {
                    bgcolor: "rgba(15,23,42,0.7)",
                    p: 1.5,
                    borderRadius: 1,
                    overflowX: "auto",
                    border: "1px solid",
                    borderColor: "divider",
                  },
                  "& table": { borderCollapse: "collapse", width: "100%" },
                  "& th, & td": { border: "1px solid", borderColor: "divider", p: 0.75, textAlign: "left" },
                }}
              >
                <ReactMarkdown>{content}</ReactMarkdown>
              </Box>
            )}
          </Paper>
        </Stack>
      </Stack>
    </Paper>
  );
}
