import { z } from "zod";

export const loopModeSchema = z.enum(["plan-act-verify", "test-fix", "research-summarize", "custom"]);
export const loopAutonomySchema = z.enum(["ask-before-edits", "ask-before-commands", "full-auto"]);
export const loopDecisionSchema = z.enum(["continue", "done", "blocked"]);
export const verificationStatusSchema = z.enum(["passed", "failed", "not-run"]);
export const reviewStatusSchema = z.enum(["passed", "warned", "blocked", "not-run"]);

export const defaultConfig = {
  objective: "",
  mode: "plan-act-verify",
  maxIterations: 3,
  stopCondition: "the objective is complete or the verification passes",
  verificationCommand: "",
  autonomy: "ask-before-edits",
  autoContinue: true,
};

export function clampIteration(value: number): number {
  if (!Number.isFinite(value)) return defaultConfig.maxIterations;
  return Math.max(1, Math.min(25, Math.floor(value)));
}

export const loopConfigSchema = z.object({
  objective: z.string(),
  mode: loopModeSchema,
  maxIterations: z.coerce.number().transform(clampIteration),
  stopCondition: z.string().default(defaultConfig.stopCondition),
  verificationCommand: z.string().default(""),
  autonomy: loopAutonomySchema,
  autoContinue: z.boolean().default(true),
});

export const loopReviewSchema = z.object({
  status: reviewStatusSchema,
  summary: z.string(),
  blockers: z.array(z.string()),
  requiredFixes: z.array(z.string()),
  raw: z.string().optional(),
  packetPath: z.string().optional(),
  reviewedAt: z.number(),
});

export const loopCheckpointSchema = z.object({
  iteration: z.number().int(),
  decision: loopDecisionSchema,
  verification: verificationStatusSchema,
  review: reviewStatusSchema,
  reviewSummary: z.string().optional(),
  reviewBlockers: z.array(z.string()).optional(),
  reviewRequiredFixes: z.array(z.string()).optional(),
  reviewRaw: z.string().optional(),
  reviewPacketPath: z.string().optional(),
  summary: z.string(),
  reason: z.string().optional(),
  next: z.string().optional(),
  plan: z.string().optional(),
  successCriteria: z.string().optional(),
  evidence: z.string().optional(),
});

export const activeLoopSchema = z.object({
  version: z.literal(2),
  config: loopConfigSchema,
  iteration: z.number().int(),
  status: z.enum(["active", "paused"]),
  plan: z.string(),
  successCriteria: z.string(),
  checkpoints: z.array(loopCheckpointSchema),
  checkpoint: loopCheckpointSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type LoopMode = z.infer<typeof loopModeSchema>;
export type LoopAutonomy = z.infer<typeof loopAutonomySchema>;
export type LoopConfig = z.infer<typeof loopConfigSchema>;
export type LoopDecision = z.infer<typeof loopDecisionSchema>;
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type LoopReview = z.infer<typeof loopReviewSchema>;
export type LoopCheckpoint = z.infer<typeof loopCheckpointSchema>;
export type ActiveLoop = z.infer<typeof activeLoopSchema>;

export function parseLoopConfig(value: unknown): LoopConfig | null {
  return loopConfigSchema.safeParse(value).data ?? null;
}

export function parseLoopCheckpoint(value: unknown): LoopCheckpoint | undefined {
  return loopCheckpointSchema.safeParse(value).data;
}

export function parseActiveLoop(value: unknown): ActiveLoop | undefined {
  return activeLoopSchema.safeParse(value).data;
}
