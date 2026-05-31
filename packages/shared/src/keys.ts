const pad = (value: number): string => value.toString().padStart(8, '0');

export const inputKey = (jobId: string, fileIndex: number): string => {
  return `jobs/${jobId}/input/${fileIndex}.npy`;
};

export const partialKey = (jobId: string, seq: number): string => {
  return `jobs/${jobId}/partials/${pad(seq)}.npz`;
};

export const resultKey = (jobId: string): string => {
  return `jobs/${jobId}/result.csv`;
};

export type TaskKind = 'leaf' | 'merge';

export const taskId = (jobId: string, kind: TaskKind, index: number): string => {
  return `${jobId}#${kind}#${index}`;
};

export const readySk = (seq: number): string => {
  return `READY#${pad(seq)}`;
};
