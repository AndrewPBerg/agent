import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MAILBOX_CANCEL_RUN_EVENT,
  MAILBOX_SPAWN_ACCEPTED_EVENT,
  MAILBOX_SPAWN_REJECTED_EVENT,
  MAILBOX_SPAWN_REQUEST_EVENT,
  MAILBOX_TERMINAL_EVENT,
  type MailboxCorrelation,
  type MailboxSpawnAccepted,
  type MailboxSpawnRejected,
  type MailboxTerminal,
} from "../subagent-mailbox/protocol";
import { renderScalarTemplate, selectStressProfiles } from "./config";
import {
  type LoopConfig,
  type LoopRun,
  loopRunSchema,
  type StageResult,
  type StressProfile,
  stageResultSchema,
  type Workflow,
  type WorkflowStage,
} from "./schemas";

const STATE_TYPE = "loop-run-state";
const STATUS_KEY = "loop";
const RESULT_MARKER = "lp_result";

type RepoSnapshot = { fingerprint: string; changedFiles: string[] };
type PendingMailboxStage = { requests: Map<string, string>; results: Map<string, StageResult> };

function nowId(): string {
  return `lp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function stageId(stage: WorkflowStage, index: number): string {
  return stage.id ?? `${String(index + 1).padStart(2, "0")}-${stage.type}`;
}

function output(result: any): string {
  return String(result?.stdout ?? result?.output ?? "").trim();
}

function parseAgentResult(value: string | undefined): StageResult | undefined {
  if (!value?.trim()) return undefined;
  const tagged = value.match(new RegExp(`<${RESULT_MARKER}>\\s*([\\s\\S]*?)\\s*</${RESULT_MARKER}>`, "i"))?.[1];
  const candidate = tagged ?? (value.trim().startsWith("{") ? value.trim() : undefined);
  if (!candidate) return undefined;
  try {
    return stageResultSchema.safeParse(JSON.parse(candidate)).data;
  } catch {
    return undefined;
  }
}

function resultContract(allowed: string): string {
  return [
    "This is a gated /lp stage.",
    `Before finishing, call report_loop_stage with one of: ${allowed}.`,
    "Include concise evidence such as exact tests, runtime checks, selectors, or PR URL.",
    "Do not claim success from intent or partial output.",
  ].join("\n");
}

function agentResultContract(): string {
  return [
    "Return a structured terminal result as the final text, with no text after it:",
    `<${RESULT_MARKER}>{"status":"passed|blocked|failed","summary":"...","evidence":["..."]}</${RESULT_MARKER}>`,
    "Use passed only when concrete evidence supports the result.",
  ].join("\n");
}

export class LoopEngine {
  private run: LoopRun | undefined;
  private config: LoopConfig;
  private ctx: ExtensionContext | undefined;
  private pendingResult: StageResult | undefined;
  private mailbox: PendingMailboxStage | undefined;
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly pi: ExtensionAPI,
    config: LoopConfig,
  ) {
    this.config = config;
    this.unsubscribers = [
      pi.events.on(MAILBOX_SPAWN_ACCEPTED_EVENT, (data) => this.onMailboxAccepted(data as MailboxSpawnAccepted)),
      pi.events.on(MAILBOX_SPAWN_REJECTED_EVENT, (data) => this.onMailboxRejected(data as MailboxSpawnRejected)),
      pi.events.on(MAILBOX_TERMINAL_EVENT, (data) => void this.onMailboxTerminal(data as MailboxTerminal)),
    ];
  }

  setConfig(config: LoopConfig) {
    this.config = config;
  }

  workflowNames(): string[] {
    return Object.keys(this.config.workflows).sort();
  }

  profileNames(): string[] {
    return Object.keys(this.config.stressProfiles).sort();
  }

  currentRun(): LoopRun | undefined {
    return this.run;
  }

  private currentStage(): WorkflowStage | undefined {
    return this.run?.stages[this.run.currentStage];
  }

  private sessionVariable(customType: string, read: (data: unknown) => unknown): string | undefined {
    if (!this.ctx) return undefined;
    const entries = this.ctx.sessionManager.getBranch?.() ?? this.ctx.sessionManager.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
      if (entry.type !== "custom" || entry.customType !== customType) continue;
      const value = read(entry.data);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  }

  private sendUserMessage(content: string) {
    if (typeof this.ctx?.isIdle !== "function" || this.ctx.isIdle()) this.pi.sendUserMessage(content);
    else this.pi.sendUserMessage(content, { deliverAs: "followUp" });
  }

  private persist() {
    if (!this.run) return;
    this.run.updatedAt = Date.now();
    this.pi.appendEntry(STATE_TYPE, { version: 1, run: this.run });
    this.updateStatus();
  }

  private updateStatus() {
    if (!this.ctx || !this.run || ["completed", "stopped"].includes(this.run.status)) {
      this.ctx?.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const stage = this.currentStage();
    this.ctx.ui.setStatus(
      STATUS_KEY,
      `lp:${this.run.status} ${this.run.currentStage + 1}/${this.run.stages.length}${stage ? ` ${stage.type}#${this.run.attempt}` : ""}`,
    );
  }

  describe(): string {
    if (!this.run) return "No loop run is active.";
    const stage = this.currentStage();
    return [
      `Run: ${this.run.id}`,
      `Workflow: ${this.run.workflowId ?? "inline"}`,
      `Status: ${this.run.status}`,
      `Stage: ${Math.min(this.run.currentStage + 1, this.run.stages.length)}/${this.run.stages.length}${stage ? ` (${stage.type})` : ""}`,
      `Attempt: ${this.run.attempt}`,
      this.run.blocker ? `Blocker: ${this.run.blocker}` : undefined,
      this.run.prUrl ? `PR: ${this.run.prUrl}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  restore(ctx: ExtensionContext) {
    this.ctx = ctx;
    const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
    let restored: LoopRun | undefined;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as { type?: string; customType?: string; data?: { run?: unknown } };
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      restored = loopRunSchema.safeParse(entry.data?.run).data;
      break;
    }
    this.run = restored;
    if (this.run && ["running", "waiting"].includes(this.run.status)) {
      this.run.status = "interrupted";
      this.run.blocker = "The session ended while a stage was active. Resume explicitly to avoid repeating side effects.";
      this.run.pendingJobIds = [];
      this.run.pendingRequestIds = [];
      this.persist();
    }
    this.updateStatus();
  }

  shutdown() {
    if (this.run && ["running", "waiting"].includes(this.run.status)) {
      this.pi.events.emit(MAILBOX_CANCEL_RUN_EVENT, { owner: "loop", runId: this.run.id });
      this.run.status = "interrupted";
      this.run.blocker = "Session shut down during an active stage.";
      this.persist();
    }
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.ctx?.ui.setStatus(STATUS_KEY, undefined);
    this.ctx = undefined;
  }

  async start(workflow: Workflow, ctx: ExtensionContext, workflowId?: string) {
    this.ctx = ctx;
    const stages = workflow.stages.map((stage, index) => ({ ...stage, id: stageId(stage, index) })) as WorkflowStage[];
    this.run = loopRunSchema.parse({
      version: 1,
      id: nowId(),
      workflowId,
      description: workflow.description,
      stages,
      stressProfiles: this.config.stressProfiles,
      status: "running",
      currentStage: 0,
      attempt: 1,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      pendingRequestIds: [],
      pendingJobIds: [],
      evidence: [],
    });
    this.persist();
    await this.dispatch();
  }

  async resume(ctx: ExtensionContext) {
    this.ctx = ctx;
    if (!this.run || !["interrupted", "blocked"].includes(this.run.status))
      throw new Error("No interrupted or blocked loop is available to resume.");
    this.run.status = "running";
    this.run.blocker = undefined;
    this.run.pendingJobIds = [];
    this.run.pendingRequestIds = [];
    this.pendingResult = undefined;
    this.mailbox = undefined;
    this.persist();
    await this.dispatch();
  }

  stop(message = "Loop stopped") {
    if (!this.run || ["completed", "stopped"].includes(this.run.status)) return false;
    this.pi.events.emit(MAILBOX_CANCEL_RUN_EVENT, { owner: "loop", runId: this.run.id });
    this.run.status = "stopped";
    this.run.blocker = message;
    this.persist();
    this.ctx?.ui.notify(message, "info");
    return true;
  }

  report(value: unknown): StageResult {
    if (!this.run || !["running", "waiting"].includes(this.run.status)) throw new Error("No active /lp stage is accepting a result.");
    const result = stageResultSchema.parse(value);
    this.pendingResult = result;
    return result;
  }

  guardToolCall(event: { toolName: string; input?: unknown }) {
    const stage = this.currentStage();
    if (stage?.type !== "pr" || event.toolName !== "bash") return undefined;
    const command = String((event.input as { command?: unknown } | undefined)?.command ?? "");
    if (/\bgit\s+push\b[^\n]*(?:--force|-f\b)/i.test(command))
      return { block: true, reason: "The /lp PR stage never permits force pushes." };
    if (stage.mode === "draft" && /\bgh\s+pr\s+create\b/i.test(command) && !/--draft\b/i.test(command))
      return { block: true, reason: "The configured /lp PR mode is draft; gh pr create must include --draft." };
    return undefined;
  }

  async onAgentSettled(ctx: ExtensionContext) {
    this.ctx = ctx;
    if (!this.run || this.run.status !== "running") return;
    const stage = this.currentStage();
    if (!stage || stage.type === "stress" || stage.type === "agent") return;

    if (stage.type === "prompt" || (stage.type === "command" && !stage.gated)) {
      await this.recordAndAdvance({ status: "passed", summary: `${stage.type} stage settled`, evidence: [] });
      return;
    }

    const result = this.pendingResult;
    this.pendingResult = undefined;
    if (!result) {
      this.block(`Stage ${stage.id} settled without calling report_loop_stage.`);
      return;
    }
    await this.evaluateReportedStage(stage, result);
  }

  private async evaluateReportedStage(stage: WorkflowStage, result: StageResult) {
    const snapshot = await this.repoSnapshot();
    this.run!.evidence.push({
      stageId: stageId(stage, this.run!.currentStage),
      attempt: this.run!.attempt,
      result,
      fingerprint: snapshot.fingerprint,
      completedAt: Date.now(),
    });

    if (result.status === "blocked" || result.status === "failed") {
      this.block(result.summary);
      return;
    }

    if (stage.type === "qa") {
      const changedDuringStage = Boolean(this.run!.stageStartedFingerprint && this.run!.stageStartedFingerprint !== snapshot.fingerprint);
      if (result.status === "fixed" || changedDuringStage) {
        if (this.run!.attempt >= stage.maxAttempts) {
          this.block(`QA changed the diff but reached maxAttempts=${stage.maxAttempts}.`);
          return;
        }
        this.run!.attempt += 1;
        this.run!.status = "running";
        this.persist();
        await this.dispatch();
        return;
      }
      if (result.status !== "clean") {
        this.block(`QA stage requires clean or fixed, received ${result.status}.`);
        return;
      }
      this.run!.gateFingerprint = snapshot.fingerprint;
      await this.advance();
      return;
    }

    if (stage.type === "pr") {
      if (result.status !== "passed" && result.status !== "clean") {
        this.block(`PR stage requires passed, received ${result.status}.`);
        return;
      }
      if (stage.mode !== "prepare" && stage.mode !== "off") {
        const verified = await this.inspectPr();
        if (!verified) {
          this.block("PR stage reported success, but gh pr view could not verify the pull request.");
          return;
        }
        if (stage.mode === "draft" && !verified.isDraft) {
          this.block("PR stage was configured for draft, but the resulting PR is ready for review.");
          return;
        }
        if (stage.mode === "ready" && verified.isDraft) {
          this.block("PR stage was configured as ready, but the resulting PR is still a draft.");
          return;
        }
        this.run!.prUrl = verified.url;
      }
      await this.advance();
      return;
    }

    if (result.status !== "passed" && result.status !== "clean") {
      this.block(`Gated stage requires passed, received ${result.status}.`);
      return;
    }
    await this.advance();
  }

  private block(reason: string) {
    if (!this.run) return;
    this.run.status = "blocked";
    this.run.blocker = reason;
    this.run.pendingRequestIds = [];
    this.run.pendingJobIds = [];
    this.persist();
    this.ctx?.ui.notify(`Loop blocked: ${reason}`, "warning");
  }

  private async recordAndAdvance(result: StageResult) {
    if (!this.run) return;
    this.run.evidence.push({
      stageId: stageId(this.currentStage()!, this.run.currentStage),
      attempt: this.run.attempt,
      result,
      completedAt: Date.now(),
    });
    await this.advance();
  }

  private async advance() {
    if (!this.run) return;
    this.run.currentStage += 1;
    this.run.attempt = 1;
    this.run.pendingRequestIds = [];
    this.run.pendingJobIds = [];
    this.run.stageStartedFingerprint = undefined;
    this.pendingResult = undefined;
    this.mailbox = undefined;
    if (this.run.currentStage >= this.run.stages.length) {
      this.run.status = "completed";
      this.persist();
      this.ctx?.ui.notify(this.run.prUrl ? `Loop complete: ${this.run.prUrl}` : "Loop complete", "info");
      return;
    }
    this.run.status = "running";
    this.persist();
    await this.dispatch();
  }

  private async dispatch() {
    if (!this.run || !this.ctx || this.run.status !== "running") return;
    const stage = this.currentStage();
    if (!stage) return;
    const snapshot = await this.repoSnapshot();
    this.run.stageStartedFingerprint = snapshot.fingerprint;
    this.persist();

    if (stage.type === "prompt") {
      this.sendUserMessage(stage.prompt);
      return;
    }
    if (stage.type === "command") {
      this.sendUserMessage(stage.gated ? `${stage.command}\n\n${resultContract("passed, blocked, failed")}` : stage.command);
      return;
    }
    if (stage.type === "qa") {
      const focus = [stage.focus, resultContract("clean, fixed, blocked, failed")].filter(Boolean).join("\n\n");
      this.sendUserMessage(`/qa ${focus}`);
      return;
    }
    if (stage.type === "stress") {
      await this.dispatchStress(stage, snapshot);
      return;
    }
    if (stage.type === "agent") {
      await this.dispatchAgents([{ id: stage.agent, profile: { agent: stage.agent, task: stage.task } as StressProfile }]);
      return;
    }
    await this.dispatchPr(stage, snapshot);
  }

  private async dispatchStress(stage: Extract<WorkflowStage, { type: "stress" }>, snapshot: RepoSnapshot) {
    const selected = selectStressProfiles(this.run!.stressProfiles, stage.profile, basename(this.ctx!.cwd), snapshot.changedFiles);
    if (!selected.length) {
      this.block(`No stress profile matched ${JSON.stringify(stage.profile)} for ${basename(this.ctx!.cwd)}.`);
      return;
    }
    await this.dispatchAgents(selected);
  }

  private async dispatchAgents(selected: Array<{ id: string; profile: StressProfile }>) {
    if (!this.run || !this.ctx) return;
    if (!(this.pi.getAllTools?.() ?? []).some((tool: { name: string }) => tool.name === "spawn_agent")) {
      this.block("The subagent mailbox is unavailable; spawn_agent is not registered.");
      return;
    }

    this.mailbox = { requests: new Map(), results: new Map() };
    this.run.status = "waiting";
    for (const { id } of selected) {
      const requestId = `${this.run.id}:${stageId(this.currentStage()!, this.run.currentStage)}:${this.run.attempt}:${id}`;
      this.mailbox.requests.set(requestId, id);
      this.run.pendingRequestIds.push(requestId);
    }
    this.persist();

    for (const { id, profile } of selected) {
      const requestId = [...this.mailbox.requests.entries()].find(([, profileId]) => profileId === id)?.[0];
      if (!requestId) {
        this.block(`Internal mailbox correlation was not created for stress profile ${id}.`);
        return;
      }
      const correlation: MailboxCorrelation = {
        owner: "loop",
        runId: this.run.id,
        stageId: stageId(this.currentStage()!, this.run.currentStage),
        attempt: this.run.attempt,
        requestId,
      };
      const variables = {
        "goal.objective": this.sessionVariable(
          "codex-goal",
          (data) => (data as { goal?: { objective?: unknown } } | undefined)?.goal?.objective,
        ),
        "plan.file": this.sessionVariable("plan-mode", (data) => (data as { planFile?: unknown } | undefined)?.planFile),
        "repo.root": this.ctx.cwd,
        "profile.id": id,
        "workflow.description": this.run.description,
      };
      this.pi.events.emit(MAILBOX_SPAWN_REQUEST_EVENT, {
        correlation,
        agent: profile.agent,
        task: `${renderScalarTemplate(profile.task, variables)}\n\n${agentResultContract()}`,
        cwd: this.ctx.cwd,
        delivery: "event",
      });
    }
  }

  private correlationMatches(correlation: MailboxCorrelation | undefined): boolean {
    if (!this.run || !correlation || !["running", "waiting"].includes(this.run.status)) return false;
    return (
      correlation.owner === "loop" &&
      correlation.runId === this.run.id &&
      correlation.stageId === stageId(this.currentStage()!, this.run.currentStage) &&
      correlation.attempt === this.run.attempt &&
      this.run.pendingRequestIds.includes(correlation.requestId)
    );
  }

  private onMailboxAccepted(event: MailboxSpawnAccepted) {
    if (!this.correlationMatches(event.correlation) || !this.run) return;
    if (!this.run.pendingJobIds.includes(event.job.id)) this.run.pendingJobIds.push(event.job.id);
    this.persist();
  }

  private onMailboxRejected(event: MailboxSpawnRejected) {
    if (!this.correlationMatches(event.correlation) || !this.mailbox) return;
    this.mailbox.results.set(event.correlation.requestId, {
      status: "failed",
      summary: event.error,
      evidence: [],
    });
    void this.finishMailboxStageIfReady();
  }

  private async onMailboxTerminal(event: MailboxTerminal) {
    if (!this.correlationMatches(event.correlation) || !this.mailbox) return;
    const result =
      event.job.status === "completed"
        ? (parseAgentResult(event.job.output) ?? {
            status: "failed" as const,
            summary: "Subagent completed without a valid <lp_result> payload.",
            evidence: event.job.output ? [event.job.output.slice(-500)] : [],
          })
        : {
            status: "failed" as const,
            summary: event.job.error ?? `Subagent ${event.job.status}.`,
            evidence: [],
          };
    this.mailbox.results.set(event.correlation!.requestId, result);
    await this.finishMailboxStageIfReady();
  }

  private async finishMailboxStageIfReady() {
    if (!this.run || !this.mailbox || this.mailbox.results.size < this.mailbox.requests.size) return;
    const results = [...this.mailbox.results.values()];
    const failed = results.find((result) => result.status !== "passed" && result.status !== "clean");
    const snapshot = await this.repoSnapshot();
    for (const result of results) {
      this.run.evidence.push({
        stageId: stageId(this.currentStage()!, this.run.currentStage),
        attempt: this.run.attempt,
        result,
        fingerprint: snapshot.fingerprint,
        completedAt: Date.now(),
      });
    }
    if (failed) {
      const stage = this.currentStage();
      if (stage?.type === "agent" && this.run.attempt < stage.maxAttempts) {
        this.run.attempt += 1;
        this.run.status = "running";
        this.run.pendingRequestIds = [];
        this.run.pendingJobIds = [];
        this.mailbox = undefined;
        this.persist();
        await this.dispatch();
        return;
      }
      this.block(failed.summary);
      return;
    }
    if (this.run.stageStartedFingerprint !== snapshot.fingerprint) {
      const qaIndex = this.run.stages.findIndex((stage) => stage.type === "qa");
      if (qaIndex >= 0) {
        this.run.currentStage = qaIndex;
        this.run.attempt = 1;
        this.run.status = "running";
        this.run.blocker = undefined;
        this.persist();
        await this.dispatch();
      } else this.block("An async stage changed the diff and no QA stage is available to revalidate it.");
      return;
    }
    this.run.gateFingerprint = snapshot.fingerprint;
    await this.advance();
  }

  private async dispatchPr(stage: Extract<WorkflowStage, { type: "pr" }>, snapshot: RepoSnapshot) {
    if (stage.mode === "off") {
      await this.recordAndAdvance({ status: "passed", summary: "PR stage disabled by configuration.", evidence: [] });
      return;
    }
    if (this.run!.gateFingerprint && this.run!.gateFingerprint !== snapshot.fingerprint) {
      this.block("The diff changed after QA/stress evidence was collected; PR creation was refused.");
      return;
    }

    const branch = output(await this.pi.exec("git", ["branch", "--show-current"], { timeout: 5_000 }));
    if (!branch || ["main", "master", "develop", "development"].includes(branch)) {
      this.block(`PR creation is not allowed from protected branch ${JSON.stringify(branch || "(detached)")}.`);
      return;
    }

    if (stage.mode !== "prepare") {
      const remote = await this.pi.exec("git", ["remote", "get-url", "origin"], { timeout: 5_000 });
      if (remote?.code !== 0 || !output(remote)) {
        this.block("PR creation requires an origin remote.");
        return;
      }
      const auth = await this.pi.exec("gh", ["auth", "status"], { timeout: 10_000 });
      if (auth?.code !== 0) {
        this.block("PR creation requires a working gh authentication session.");
        return;
      }
    }

    const existing = await this.inspectPr();
    if (existing) {
      this.run!.prUrl = existing.url;
      if ((stage.mode === "draft" && existing.isDraft) || (stage.mode === "ready" && !existing.isDraft)) {
        await this.recordAndAdvance({
          status: "passed",
          summary: "Existing PR already satisfies the configured mode.",
          evidence: [existing.url],
          url: existing.url,
        });
        return;
      }
    }

    const modeInstruction =
      stage.mode === "prepare"
        ? "Prepare a concise PR title and body, but do not commit, push, or create a PR."
        : `Commit the intended diff, push ${branch} without force, and create a ${stage.mode === "draft" ? "draft" : "ready-for-review"} PR with gh.`;
    this.sendUserMessage(
      [
        "Complete the gated /lp PR stage.",
        modeInstruction,
        "Inspect the full branch diff first. Do not include unrelated files, do not force-push, and do not change branches.",
        stage.mode === "draft" ? "The gh pr create command must include --draft." : undefined,
        "If a PR already exists, reuse it instead of creating a duplicate.",
        resultContract("passed, blocked, failed"),
        "Include the verified PR URL in report_loop_stage.url when a PR is created or reused.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  private async inspectPr(): Promise<{ url: string; isDraft: boolean } | undefined> {
    try {
      const result = await this.pi.exec("gh", ["pr", "view", "--json", "url,isDraft,headRefName"], { timeout: 10_000 });
      if (result?.code !== undefined && result.code !== 0) return undefined;
      const parsed = JSON.parse(output(result));
      return typeof parsed.url === "string" && typeof parsed.isDraft === "boolean"
        ? { url: parsed.url, isDraft: parsed.isDraft }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async repoSnapshot(): Promise<RepoSnapshot> {
    try {
      let base = "HEAD";
      const remoteHead = output(
        await this.pi.exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { timeout: 5_000 }),
      );
      if (remoteHead) base = remoteHead;
      else {
        for (const candidate of ["origin/main", "origin/master"]) {
          const exists = await this.pi.exec("git", ["rev-parse", "--verify", "--quiet", candidate], { timeout: 5_000 });
          if (exists?.code === 0) {
            base = candidate;
            break;
          }
        }
      }
      const diff = output(await this.pi.exec("git", ["diff", "--binary", "--no-ext-diff", base, "--"], { timeout: 15_000 }));
      const changed = output(await this.pi.exec("git", ["diff", "--name-only", base, "--"], { timeout: 10_000 }))
        .split(/\r?\n/)
        .filter(Boolean);
      const untracked = output(await this.pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { timeout: 10_000 }))
        .split(/\r?\n/)
        .filter(Boolean);
      const untrackedHashes: string[] = [];
      for (const file of untracked) {
        const hash = output(await this.pi.exec("git", ["hash-object", "--", file], { timeout: 5_000 }));
        untrackedHashes.push(`${file}:${hash}`);
      }
      const changedFiles = [...new Set([...changed, ...untracked])].sort();
      return {
        fingerprint: createHash("sha256")
          .update(`${base}\0${diff}\0${untrackedHashes.sort().join("\n")}`)
          .digest("hex"),
        changedFiles,
      };
    } catch {
      return {
        fingerprint: createHash("sha256")
          .update(this.ctx?.cwd ?? "unknown")
          .digest("hex"),
        changedFiles: [],
      };
    }
  }
}
