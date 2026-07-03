import { z } from "zod";

export const runStatusSchema = z.enum(["active", "blocked", "done", "failed", "stopped"]);
export const reviewVerdictSchema = z.enum(["pass", "warn", "block"]);
export const scopeMatchSchema = z.enum(["yes", "no"]);
export const repoDirectionMatchSchema = z.enum(["yes", "no", "unclear"]);
export const verificationQualitySchema = z.enum(["strong", "weak", "missing"]);
export const workerStatusSchema = z.enum(["queued", "working", "passed", "warned", "blocked", "failed", "stopped"]);

export const modelPolicySchema = z.object({
  driver: z.string(),
  worker: z.string(),
  reviewer: z.string(),
});

export const reviewGateSchema = z.object({
  verdict: reviewVerdictSchema,
  scopeMatch: scopeMatchSchema,
  repoDirectionMatch: repoDirectionMatchSchema,
  verificationQuality: verificationQualitySchema,
  summary: z.string(),
  blockers: z.array(z.string()),
  requiredFixes: z.array(z.string()),
  requiredNextAction: z.string().optional(),
  evaluatorPacketPath: z.string().optional(),
  model: z.string().optional(),
  createdAt: z.string(),
});

export const workerRecordSchema = z.object({
  id: z.string(),
  agent: z.string(),
  status: workerStatusSchema,
  model: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  artifact: z.string().optional(),
});

export const orchestratedRunSchema = z.object({
  id: z.string(),
  goalId: z.string(),
  objective: z.string(),
  status: runStatusSchema,
  mode: z.literal("guarded-auto"),
  createdAt: z.string(),
  updatedAt: z.string(),
  currentIteration: z.number().int(),
  maxIterations: z.number().int(),
  maxRuntimeMinutes: z.number(),
  doneCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  phase: z.enum(["idle", "planning", "coding", "verifying", "reviewing", "checkpointing"]),
  modelPolicy: modelPolicySchema,
  hookPolicy: z.object({
    reviewAfterEachIteration: z.boolean(),
    blockDoneWhenReviewBlocks: z.boolean(),
    storeWorkerInputs: z.boolean(),
  }),
  workers: z.array(workerRecordSchema),
  review: reviewGateSchema.optional(),
});

export const goalRecordSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum(["active", "paused", "blocked", "done", "failed", "stopped"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  activeRunId: z.string().optional(),
  lastRunStatus: runStatusSchema.optional(),
  lastReviewSummary: z.string().optional(),
});

export type RunStatus = z.infer<typeof runStatusSchema>;
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type ScopeMatch = z.infer<typeof scopeMatchSchema>;
export type RepoDirectionMatch = z.infer<typeof repoDirectionMatchSchema>;
export type VerificationQuality = z.infer<typeof verificationQualitySchema>;
export type WorkerStatus = z.infer<typeof workerStatusSchema>;
export type ModelPolicy = z.infer<typeof modelPolicySchema>;
export type ReviewGate = z.infer<typeof reviewGateSchema>;
export type WorkerRecord = z.infer<typeof workerRecordSchema>;
export type OrchestratedRun = z.infer<typeof orchestratedRunSchema>;
export type GoalRecord = z.infer<typeof goalRecordSchema>;

export function parseGoalRecord(value: unknown): GoalRecord | undefined {
  return goalRecordSchema.safeParse(value).data;
}

export function parseOrchestratedRun(value: unknown): OrchestratedRun | undefined {
  return orchestratedRunSchema.safeParse(value).data;
}

export function parseReviewGate(value: unknown): ReviewGate | undefined {
  return reviewGateSchema.safeParse(value).data;
}
