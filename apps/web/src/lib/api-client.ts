import {
  createJobResponseSchema,
  fleetViewSchema,
  jobViewSchema,
  setWorkersRequestSchema,
  type CreateJobRequest,
  type CreateJobResponse,
  type FleetView,
  type JobView,
} from "@aggregate/shared";
import { z } from "zod";

const jobsArraySchema = z.array(jobViewSchema);

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${message}`);
  }
  return response.json();
}

export async function listJobs(): Promise<JobView[]> {
  const data = await fetchJson("/api/jobs");
  return jobsArraySchema.parse(data);
}

export async function getJob(jobId: string): Promise<JobView> {
  const data = await fetchJson(`/api/jobs/${jobId}`);
  return jobViewSchema.parse(data);
}

export async function createJob(payload: CreateJobRequest): Promise<CreateJobResponse> {
  const data = await fetchJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return createJobResponseSchema.parse(data);
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetchJson(`/api/jobs/${jobId}`, { method: "DELETE" });
}

export async function getFleet(): Promise<FleetView> {
  const data = await fetchJson("/api/fleet");
  return fleetViewSchema.parse(data);
}

export async function setWorkers(count: number): Promise<FleetView> {
  const body = setWorkersRequestSchema.parse({ count });
  const data = await fetchJson("/api/workers", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return fleetViewSchema.parse(data);
}
