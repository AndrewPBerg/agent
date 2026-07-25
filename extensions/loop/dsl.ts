import type { z } from "zod";
import { type Workflow, type WorkflowStage, workflowSchema } from "./schemas";

const MAX_REPEATS = 25;

export type LegacyStage = { prompt: string };
export type ParseWorkflowResult = { success: true; workflow: Workflow } | { success: false; error: string };

function stageId(index: number, type: string): string {
  return `${String(index + 1).padStart(2, "0")}-${type}`;
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "workflow"}: ${issue.message}`).join("; ");
}

export function parseLegacyStages(input: string): LegacyStage[] | null {
  const segments = input.split("|").map((segment) => segment.trim());
  if (segments.length === 0 || segments.some((segment) => !segment)) return null;

  const objective = segments[0];
  if (!objective) return null;

  const stages: LegacyStage[] = [{ prompt: objective }];
  for (const segment of segments.slice(1)) {
    const match = segment.match(/^(.*?)(?:\s+lp\s+(\d+))?$/i);
    const command = match?.[1]?.trim();
    const repeats = match?.[2] === undefined ? 1 : Number(match[2]);
    if (!command || !Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) return null;
    const prompt = command.startsWith("/") ? command : `/${command}`;
    stages.push(...Array.from({ length: repeats }, () => ({ prompt })));
  }
  return stages;
}

function parseSegment(segment: string, index: number): WorkflowStage[] {
  const hasLegacyRepeat = /\s+lp\s+\d+$/i.test(segment);
  if (!hasLegacyRepeat) {
    const qa = segment.match(/^qa(?:\s+until\s+clean)?(?:\s+max\s+(\d+))?(?:\s+(.+))?$/i);
    if (qa) {
      const maxAttempts = qa[1] === undefined ? 3 : Number(qa[1]);
      return [{ id: stageId(index, "qa"), type: "qa", maxAttempts, focus: qa[2]?.trim() || undefined }];
    }

    const stress = segment.match(/^stress(?:\s+([a-z0-9._-]+))?$/i);
    if (stress) return [{ id: stageId(index, "stress"), type: "stress", profile: stress[1] ?? "auto" }];

    const pr = segment.match(/^pr(?:\s+(prepare|draft|ready|off))?(?:\s+if\s+passed)?$/i);
    if (pr) return [{ id: stageId(index, "pr"), type: "pr", mode: (pr[1]?.toLowerCase() as any) ?? "draft", when: "passed" }];

    const agent = segment.match(/^agent\s+([a-z0-9._-]+)\s+(.+)$/i);
    if (agent) return [{ id: stageId(index, "agent"), type: "agent", agent: agent[1], task: agent[2].trim(), maxAttempts: 1 }];
  }

  const repeated = segment.match(/^(.*?)(?:\s+lp\s+(\d+))?$/i);
  const raw = repeated?.[1]?.trim();
  const repeats = repeated?.[2] === undefined ? 1 : Number(repeated[2]);
  if (!raw || !Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS)
    throw new Error(`stage ${index + 1}: repeat count must be 1-${MAX_REPEATS}`);

  if (index === 0 && !raw.startsWith("/"))
    return Array.from({ length: repeats }, (_, offset) => ({
      id: stageId(index + offset, "prompt"),
      type: "prompt" as const,
      prompt: raw,
    }));

  const command = raw.startsWith("/") ? raw : `/${raw}`;
  return Array.from({ length: repeats }, (_, offset) => ({
    id: stageId(index + offset, "command"),
    type: "command" as const,
    command,
    gated: false,
  }));
}

export function parseInlineWorkflow(input: string): ParseWorkflowResult {
  const segments = input.split("|").map((segment) => segment.trim());
  if (!segments.length || segments.some((segment) => !segment)) return { success: false, error: "pipeline contains an empty stage" };

  try {
    const stages = segments.flatMap((segment, index) => parseSegment(segment, index));
    const parsed = workflowSchema.safeParse({ stages });
    return parsed.success ? { success: true, workflow: parsed.data } : { success: false, error: zodMessage(parsed.error) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function completeSegment(
  segment: string,
  workflowNames: string[],
  profileNames: string[],
): Array<{ value: string; label: string; description?: string }> {
  const normalized = segment.trim().toLowerCase();
  const candidates = [
    ...workflowNames.map((value) => ({ value, label: value, description: "named workflow" })),
    { value: "qa until clean max 3", label: "qa until clean max 3", description: "repeat QA until clean" },
    { value: "stress auto", label: "stress auto", description: "run matching stress profiles" },
    ...profileNames.map((profile) => ({ value: `stress ${profile}`, label: `stress ${profile}`, description: "stress profile" })),
    { value: "pr draft if passed", label: "pr draft if passed", description: "push and create a draft PR" },
    { value: "pr prepare if passed", label: "pr prepare if passed", description: "prepare PR without pushing" },
    { value: "pr ready if passed", label: "pr ready if passed", description: "create a ready PR" },
  ];
  return candidates.filter((candidate) => !normalized || candidate.value.startsWith(normalized));
}

export function completeLoopArguments(prefix: string, workflowNames: string[], profileNames: string[]) {
  const controls = ["status", "stop", "resume", "list", "reload", "validate", "schema"];
  const pipe = prefix.lastIndexOf("|");
  if (pipe < 0) {
    const normalized = prefix.trim().toLowerCase();
    const controlItems = controls
      .filter((value) => value.startsWith(normalized))
      .map((value) => ({ value, label: value, description: "loop control" }));
    return [...controlItems, ...completeSegment(prefix, workflowNames, profileNames)];
  }

  const head = prefix.slice(0, pipe + 1);
  const segment = prefix.slice(pipe + 1);
  return completeSegment(segment, [], profileNames).map((item) => ({ ...item, value: `${head} ${item.value}` }));
}

export const LOOP_MAX_REPEATS = MAX_REPEATS;
