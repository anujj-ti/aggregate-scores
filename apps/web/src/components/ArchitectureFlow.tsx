"use client";

import * as React from "react";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import CloudIcon from "@mui/icons-material/Cloud";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DataObjectIcon from "@mui/icons-material/DataObject";
import DnsIcon from "@mui/icons-material/Dns";
import HubIcon from "@mui/icons-material/Hub";
import LanguageIcon from "@mui/icons-material/Language";
import PolylineIcon from "@mui/icons-material/Polyline";
import SettingsEthernetIcon from "@mui/icons-material/SettingsEthernet";
import StorageIcon from "@mui/icons-material/Storage";
import ViewInArIcon from "@mui/icons-material/ViewInAr";
import WebIcon from "@mui/icons-material/Web";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ReactFlow, {
  Background,
  ConnectionLineType,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  useEdgesState,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";

type ServiceNodeData = {
  readonly title: string;
  readonly subtitle: string;
  readonly color: string;
  readonly icon: React.ReactNode;
};

function ServiceNode({ data }: NodeProps<ServiceNodeData>): React.JSX.Element {
  return (
    <>
      <Handle
        type="target"
        id="left"
        position={Position.Left}
        style={{ width: 8, height: 8, borderRadius: "50%", border: `2px solid ${data.color}`, background: "#0f172a" }}
      />
      <Handle
        type="target"
        id="top"
        position={Position.Top}
        style={{ width: 8, height: 8, borderRadius: "50%", border: `2px solid ${data.color}`, background: "#0f172a" }}
      />
      <Paper
        variant="outlined"
        sx={{
          minWidth: 220,
          borderRadius: 2,
          borderColor: data.color,
          px: 1.25,
          py: 1,
          background:
            "linear-gradient(180deg, rgba(17,24,39,0.96) 0%, rgba(15,23,42,0.88) 70%, rgba(17,24,39,0.96) 100%)",
        }}
      >
        <Stack spacing={0.5}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Box sx={{ color: data.color, display: "inline-flex", alignItems: "center" }}>{data.icon}</Box>
            <Typography variant="subtitle2" sx={{ color: "common.white", fontWeight: 700 }}>
              {data.title}
            </Typography>
          </Stack>
          <Typography variant="caption" sx={{ color: "rgba(226,232,240,0.92)" }}>
            {data.subtitle}
          </Typography>
        </Stack>
      </Paper>
      <Handle
        type="source"
        id="right"
        position={Position.Right}
        style={{ width: 8, height: 8, borderRadius: "50%", border: `2px solid ${data.color}`, background: "#0f172a" }}
      />
      <Handle
        type="source"
        id="bottom"
        position={Position.Bottom}
        style={{ width: 8, height: 8, borderRadius: "50%", border: `2px solid ${data.color}`, background: "#0f172a" }}
      />
    </>
  );
}

const NODE_TYPES = { service: ServiceNode };

const ARCHITECTURE_NODES: Node<ServiceNodeData>[] = [
  {
    id: "ui",
    type: "service",
    position: { x: -343, y: 1 },
    sourcePosition: Position.Right,
    data: {
      title: "Operator UI (Next.js)",
      subtitle: "Dashboard, submit job, inspect status",
      color: "#38bdf8",
      icon: <WebIcon fontSize="small" />,
    },
  },
  {
    id: "apigw",
    type: "service",
    position: { x: -335, y: 163 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      title: "API Gateway",
      subtitle: "Public HTTP entrypoint for the API",
      color: "#22d3ee",
      icon: <LanguageIcon fontSize="small" />,
    },
  },
  {
    id: "api",
    type: "service",
    position: { x: -37, y: 294 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      title: "API Lambda (Express)",
      subtitle: "Creates jobs, starts generation, serves reads",
      color: "#a78bfa",
      icon: <DataObjectIcon fontSize="small" />,
    },
  },
  {
    id: "dispatcher",
    type: "service",
    position: { x: -26, y: 457 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      title: "Dispatcher Lambda",
      subtitle: "Admits pending jobs while inFlight < K*W",
      color: "#fb7185",
      icon: <HubIcon fontSize="small" />,
    },
  },
  {
    id: "queue",
    type: "service",
    position: { x: -40, y: 619 },
    sourcePosition: Position.Left,
    targetPosition: Position.Left,
    data: {
      title: "SQS Work Queue",
      subtitle: "Leaf + merge tasks, retry via Lambda mapping",
      color: "#f59e0b",
      icon: <CloudQueueIcon fontSize="small" />,
    },
  },
  {
    id: "worker",
    type: "service",
    position: { x: 117, y: 795 },
    sourcePosition: Position.Left,
    targetPosition: Position.Left,
    data: {
      title: "Worker Lambda Fleet",
      subtitle: "Merges <=5 inputs, writes partials, re-queues merges",
      color: "#60a5fa",
      icon: <CloudIcon fontSize="small" />,
    },
  },
  {
    id: "ddb",
    type: "service",
    position: { x: 643, y: 498 },
    sourcePosition: Position.Left,
    targetPosition: Position.Left,
    data: {
      title: "DynamoDB",
      subtitle: "Job state, counters, ready pool, fleet inFlight",
      color: "#34d399",
      icon: <DnsIcon fontSize="small" />,
    },
  },
  {
    id: "s3",
    type: "service",
    position: { x: 721, y: 294 },
    sourcePosition: Position.Left,
    targetPosition: Position.Left,
    data: {
      title: "S3",
      subtitle: "Input files, partials, final result.csv",
      color: "#fbbf24",
      icon: <StorageIcon fontSize="small" />,
    },
  },
];

const ARCHITECTURE_EDGES: Edge[] = [
  {
    id: "ui-apigw",
    source: "ui",
    sourceHandle: "bottom",
    target: "apigw",
    targetHandle: "top",
    animated: true,
    type: "smoothstep",
  },
  {
    id: "apigw-api",
    source: "apigw",
    sourceHandle: "bottom",
    target: "api",
    targetHandle: "top",
    animated: true,
    type: "smoothstep",
  },
  {
    id: "api-dispatcher",
    source: "api",
    sourceHandle: "bottom",
    target: "dispatcher",
    targetHandle: "top",
    animated: true,
    type: "smoothstep",
  },
  {
    id: "dispatcher-queue",
    source: "dispatcher",
    sourceHandle: "bottom",
    target: "queue",
    targetHandle: "top",
    animated: true,
    type: "smoothstep",
  },
  {
    id: "queue-worker",
    source: "queue",
    sourceHandle: "bottom",
    target: "worker",
    targetHandle: "top",
    animated: true,
    type: "smoothstep",
  },
  {
    id: "worker-ddb",
    source: "worker",
    sourceHandle: "right",
    target: "ddb",
    targetHandle: "left",
    type: "smoothstep",
    style: { strokeDasharray: "6 4", strokeWidth: 1.5, stroke: "#7dd3fc" },
  },
  {
    id: "api-ddb-side",
    source: "api",
    sourceHandle: "right",
    target: "ddb",
    targetHandle: "left",
    type: "smoothstep",
    style: { strokeDasharray: "6 4", strokeWidth: 1.5, stroke: "#7dd3fc" },
  },
  {
    id: "api-s3-side",
    source: "api",
    sourceHandle: "right",
    target: "s3",
    targetHandle: "left",
    type: "smoothstep",
    style: { strokeDasharray: "6 4", strokeWidth: 1.5, stroke: "#7dd3fc" },
  },
  {
    id: "dispatcher-ddb-side",
    source: "dispatcher",
    sourceHandle: "right",
    target: "ddb",
    targetHandle: "left",
    type: "smoothstep",
    style: { strokeDasharray: "6 4", strokeWidth: 1.5, stroke: "#7dd3fc" },
  },
  {
    id: "worker-s3-side",
    source: "worker",
    sourceHandle: "right",
    target: "s3",
    targetHandle: "left",
    type: "smoothstep",
    style: { strokeDasharray: "6 4", strokeWidth: 1.5, stroke: "#7dd3fc" },
  },
];

export function ArchitectureFlow(): React.JSX.Element {
  const [nodes, , onNodesChange] = useNodesState(ARCHITECTURE_NODES);
  const [edges, , onEdgesChange] = useEdgesState(ARCHITECTURE_EDGES);
  const [editMode, setEditMode] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const copyLayout = async (): Promise<void> => {
    const payload = {
      nodes: nodes.map((node) => ({
        id: node.id,
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: edge.target,
        targetHandle: edge.targetHandle,
      })),
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1} sx={{ justifyContent: "space-between" }}>
          <Box>
            <Typography variant="h5">Architecture Explorer</Typography>
            <Typography variant="body2" color="text.secondary">
              Interactive diagram of the local-first distributed mean pipeline.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
            <Chip icon={<SettingsEthernetIcon />} label="Queue-driven execution" />
            <Chip icon={<ViewInArIcon />} label="Serverless only" color="primary" variant="outlined" />
            <Chip icon={<AccountTreeIcon />} label="Eager merge (no level barrier)" color="secondary" variant="outlined" />
            <Button
              variant={editMode ? "contained" : "outlined"}
              size="small"
              onClick={() => setEditMode((previous) => !previous)}
            >
              {editMode ? "Editing on" : "Edit layout"}
            </Button>
            <Button size="small" variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => void copyLayout()}>
              Copy layout JSON
            </Button>
          </Stack>
        </Stack>
        {editMode ? (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            Drag nodes to your preferred layout, click <strong>Copy layout JSON</strong>, and paste it here. I will
            apply your exact coordinates.
          </Alert>
        ) : null}
        {copied ? (
          <Alert severity="success" sx={{ mt: 1.5 }}>
            Layout JSON copied to clipboard.
          </Alert>
        ) : null}
      </Paper>

      <Paper sx={{ height: 920, p: 1, backgroundColor: "#020617" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          defaultEdgeOptions={{
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20, color: "#93c5fd" },
            style: { stroke: "#93c5fd", strokeWidth: 2.25 },
          }}
          connectionLineType={ConnectionLineType.SmoothStep}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.45}
          maxZoom={1.6}
          nodesDraggable={editMode}
          nodesConnectable={false}
          elementsSelectable={editMode}
          zoomOnPinch
        >
          <Background color="#1e293b" gap={18} />
          <Controls />
        </ReactFlow>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="subtitle2">Connection legend</Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5, color: "text.secondary" }}>
            <li>
              <Typography variant="body2" color="text.secondary">
                Main sequence: UI {"->"} API Gateway {"->"} API {"->"} Dispatcher {"->"} Queue {"->"} Worker.
              </Typography>
            </li>
            <li>
              <Typography variant="body2" color="text.secondary">
                Dashed links are independent store access paths (API/Dispatcher/Worker {"->"} DynamoDB and API/Worker {"->"} S3).
              </Typography>
            </li>
            <li>
              <Typography variant="body2" color="text.secondary">
                DynamoDB and S3 do not feed each other directly; they are separate state vs object stores.
              </Typography>
            </li>
          </Box>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack spacing={1.25}>
          <Typography variant="subtitle1" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <PolylineIcon fontSize="small" /> Runtime sequence (what happens after submit)
          </Typography>
          <Box component="ol" sx={{ m: 0, pl: 2.5, color: "text.secondary" }}>
            <li>
              <Typography variant="body2" color="text.secondary">
                API creates job as <strong>GENERATING</strong> and writes input files to S3.
              </Typography>
            </li>
            <li>
              <Typography variant="body2" color="text.secondary">
                API marks job <strong>PENDING</strong> and triggers dispatcher.
              </Typography>
            </li>
            <li>
              <Typography variant="body2" color="text.secondary">
                Dispatcher admits jobs by capacity and enqueues leaf tasks.
              </Typography>
            </li>
            <li>
              <Typography variant="body2" color="text.secondary">
                Workers merge and re-enqueue until <code>reductionsRemaining</code> reaches zero.
              </Typography>
            </li>
            <li>
              <Typography variant="body2" color="text.secondary">
                Final <code>result.csv</code> is written and job becomes <strong>COMPLETE</strong>.
              </Typography>
            </li>
          </Box>
          <Divider />
          <Typography variant="caption" color="text.secondary">
            Notes: Queue depth = GENERATING + PENDING. Buffered tasks = inFlight - W (never negative).
          </Typography>
        </Stack>
      </Paper>
    </Stack>
  );
}
