"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { CreateJobRequest, CreateJobResponse, FleetView, JobView } from "@aggregate/shared";

import { cancelJob, createJob, getFleet, getJob, listJobs, setWorkers } from "@/lib/api-client";

const JOBS_QUERY_KEY = ["jobs"] as const;
const FLEET_QUERY_KEY = ["fleet"] as const;
const LIVE_POLL_MS = 1_000;

export function useJobs(): UseQueryResult<JobView[], Error> {
  return useQuery({
    queryKey: JOBS_QUERY_KEY,
    queryFn: listJobs,
    refetchInterval: LIVE_POLL_MS,
    refetchIntervalInBackground: true,
  });
}

export function useJob(jobId: string): UseQueryResult<JobView, Error> {
  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => getJob(jobId),
    refetchInterval: LIVE_POLL_MS,
    refetchIntervalInBackground: true,
    enabled: jobId.length > 0,
  });
}

export function useFleet(): UseQueryResult<FleetView, Error> {
  return useQuery({
    queryKey: FLEET_QUERY_KEY,
    queryFn: getFleet,
    refetchInterval: LIVE_POLL_MS,
    refetchIntervalInBackground: true,
  });
}

export function useSubmitJob(): UseMutationResult<CreateJobResponse, Error, CreateJobRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createJob,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY });
    },
  });
}

export function useCancelJob(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: cancelJob,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: FLEET_QUERY_KEY }),
      ]);
    },
  });
}

export function useSetWorkers(): UseMutationResult<FleetView, Error, number> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setWorkers,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: FLEET_QUERY_KEY });
    },
  });
}
