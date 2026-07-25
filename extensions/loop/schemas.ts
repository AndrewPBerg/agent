import { z } from "zod";

export const stageResultStatusSchema = z.enum(["clean", "fixed", "passed", "blocked", "failed"]);

export const stageResultSchema = z.object({
  status: stageResultStatusSchema,
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).default([]),
  changedFiles: z.array(z.string().trim().min(1)).optional(),
  url: z.string().url().optional(),
});

const stageBaseSchema = z.object({
  id: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
});

export const promptStageSchema = stageBaseSchema.extend({
  type: z.literal("prompt"),
  prompt: z.string().trim().min(1),
});

export const commandStageSchema = stageBaseSchema.extend({
  type: z.literal("command"),
  command: z.string().trim().min(1),
  gated: z.boolean().default(false),
});

export const qaStageSchema = stageBaseSchema.extend({
  type: z.literal("qa"),
  focus: z.string().trim().optional(),
  maxAttempts: z.number().int().min(1).max(25).default(3),
});

export const stressStageSchema = stageBaseSchema.extend({
  type: z.literal("stress"),
  profile: z.string().trim().min(1).default("auto"),
});

export const agentStageSchema = stageBaseSchema.extend({
  type: z.literal("agent"),
  agent: z.string().trim().min(1),
  task: z.string().trim().min(1),
  maxAttempts: z.number().int().min(1).max(25).default(1),
});

export const prModeSchema = z.enum(["prepare", "draft", "ready", "off"]);

export const prStageSchema = stageBaseSchema.extend({
  type: z.literal("pr"),
  mode: prModeSchema.default("draft"),
  when: z.literal("passed").default("passed"),
});

export const workflowStageSchema = z.discriminatedUnion("type", [
  promptStageSchema,
  commandStageSchema,
  qaStageSchema,
  stressStageSchema,
  agentStageSchema,
  prStageSchema,
]);

export const workflowSchema = z.object({
  description: z.string().trim().optional(),
  stages: z.array(workflowStageSchema).min(1).max(100),
});

export const stressProfileSchema = z.object({
  description: z.string().trim().optional(),
  match: z
    .object({
      cwdBasename: z.string().trim().min(1).optional(),
      fileExtensions: z.array(z.string().trim().min(1)).default([]),
    })
    .default({ fileExtensions: [] }),
  agent: z.string().trim().min(1),
  task: z.string().trim().min(1),
});

export const loopConfigSchema = z.object({
  version: z.literal(1).default(1),
  defaults: z
    .object({
      prMode: prModeSchema.default("draft"),
    })
    .default({ prMode: "draft" }),
  workflows: z.record(z.string().trim().min(1), workflowSchema).default({}),
  stressProfiles: z.record(z.string().trim().min(1), stressProfileSchema).default({}),
});

export const runStatusSchema = z.enum(["running", "waiting", "blocked", "completed", "stopped", "interrupted"]);

export const stageEvidenceSchema = z.object({
  stageId: z.string(),
  attempt: z.number().int().positive(),
  result: stageResultSchema,
  fingerprint: z.string().optional(),
  completedAt: z.number(),
});

export const loopRunSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  workflowId: z.string().optional(),
  description: z.string().optional(),
  stages: z.array(workflowStageSchema),
  stressProfiles: z.record(z.string(), stressProfileSchema).default({}),
  status: runStatusSchema,
  currentStage: z.number().int().min(0),
  attempt: z.number().int().positive(),
  startedAt: z.number(),
  updatedAt: z.number(),
  stageStartedFingerprint: z.string().optional(),
  gateFingerprint: z.string().optional(),
  pendingRequestIds: z.array(z.string()).default([]),
  pendingJobIds: z.array(z.string()).default([]),
  evidence: z.array(stageEvidenceSchema).default([]),
  blocker: z.string().optional(),
  prUrl: z.string().url().optional(),
});

export type StageResult = z.infer<typeof stageResultSchema>;
export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type StressProfile = z.infer<typeof stressProfileSchema>;
export type LoopConfig = z.infer<typeof loopConfigSchema>;
export type LoopRun = z.infer<typeof loopRunSchema>;
export type PrMode = z.infer<typeof prModeSchema>;
