export const MAILBOX_SPAWN_REQUEST_EVENT = "subagent-mailbox:spawn-request";
export const MAILBOX_SPAWN_ACCEPTED_EVENT = "subagent-mailbox:spawn-accepted";
export const MAILBOX_SPAWN_REJECTED_EVENT = "subagent-mailbox:spawn-rejected";
export const MAILBOX_TERMINAL_EVENT = "subagent-mailbox:terminal";
export const MAILBOX_CANCEL_RUN_EVENT = "subagent-mailbox:cancel-run";
export const MAILBOX_EXTERNAL_JOB_EVENT = "subagent-mailbox:external-job";

export type MailboxCorrelation = {
  owner: string;
  runId: string;
  stageId: string;
  attempt: number;
  requestId: string;
};

export type MailboxSpawnRequest = {
  correlation: MailboxCorrelation;
  agent: string;
  task: string;
  cwd: string;
  delivery: "push" | "event";
};

export type MailboxJobSnapshot = {
  id: string;
  kind?: "agent" | "bash";
  agent: string;
  task: string;
  cwd: string;
  status: "launching" | "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  output?: string;
  error?: string;
  stopReason?: string;
  correlation?: MailboxCorrelation;
  delivery?: "push" | "event";
};

export type MailboxSpawnAccepted = {
  correlation: MailboxCorrelation;
  job: MailboxJobSnapshot;
};

export type MailboxSpawnRejected = {
  correlation: MailboxCorrelation;
  error: string;
};

export type MailboxTerminal = {
  correlation?: MailboxCorrelation;
  job: MailboxJobSnapshot;
};

export type MailboxExternalJob = {
  job: MailboxJobSnapshot;
};

export type MailboxCancelRun = {
  owner: string;
  runId: string;
};
