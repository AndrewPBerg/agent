import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const COMMANDS = ["help", "plan", "explore", "memory", "audit"] as const;
type GroceryCommand = (typeof COMMANDS)[number];

interface ParsedArgs {
  command: GroceryCommand;
  target: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function workspace(cwd: string): string {
  return join(cwd, "grocery-agent");
}

function paths(cwd: string, date = today()) {
  const root = workspace(cwd);
  return {
    root,
    recipeMemory: join(root, "memories", "recipe-memory.md"),
    preferences: join(root, "memories", "preferences.md"),
    staples: join(root, "memories", "staples.md"),
    questionMemory: join(root, "memories", "question-memory.md"),
    goals: join(root, "goals"),
    auditLog: join(root, "audit-log", `${date}.md`),
    groceryList: join(root, "grocery-lists", `${date}.md`),
    discoveryArtifacts: join(cwd, ".yosoi", "grocery-agent", date),
  };
}

function parseArgs(args: string): ParsedArgs {
  const trimmed = args.trim();
  if (!trimmed) return { command: "help", target: "" };
  const [first, ...rest] = trimmed.split(/\s+/);
  if ((COMMANDS as readonly string[]).includes(first)) return { command: first as GroceryCommand, target: rest.join(" ") };
  return { command: "plan", target: trimmed };
}

function formatPathBlock(ctx: ExtensionContext, date?: string): string {
  const p = paths(ctx.cwd, date);
  return `Workspace/files:
- Root: ${p.root}
- Recipe memory: ${p.recipeMemory}
- Preferences: ${p.preferences}
- Pantry/staples memory: ${p.staples}
- Question memory: ${p.questionMemory}
- Goals directory: ${p.goals}
- Audit log: ${p.auditLog}
- Grocery list output: ${p.groceryList}
- Discovery artifacts, if web/source research is used: ${p.discoveryArtifacts}`;
}

function groceryPrompt(ctx: ExtensionContext, mode: "plan" | "explore", target: string): string {
  const action = mode === "explore" ? "Explore recipe and snack ideas before planning" : "Create this week's grocery plan";
  const seed = target.trim() || "Use current memories, goals, and any meal ideas from this conversation.";

  return `${action} with Grocery Agent.

User seed / request:
${seed}

${formatPathBlock(ctx)}

Workflow:
1. Read existing grocery memory, preferences, staples, question memory, goals, and recent audit logs when present; if missing, create sensible starter files/directories.
2. Treat user-provided meals as strong seeds. Preserve them unless there is a clear conflict with preferences/goals.
3. Build a small "knowns / unknowns" planning model from memory plus the selected meals before asking anything:
   - Known from memory: usual servings, pantry staples, spice level, snack style, dislikes, favorite repeats, goal defaults.
   - Known from the seed: selected meals, cuisine/style clues, breakfast/dinner/snack coverage, likely core ingredients.
   - Unknown or stale: only items not answered by memory/seed or likely to change week-to-week.
4. Ask only derived questions. Do not use a fixed questionnaire. Ask at most 2–4 high-leverage questions, skip questions memory already answers, and offer remembered defaults inline (for example, "I can assume your usual X unless changed"). If enough is known, proceed with stated assumptions instead of asking.
5. After the user answers, update question memory/staples/preferences with stable facts and keep one-off answers in the weekly audit.
6. Use memory first: identify repeats, new ideas, skipped items, disliked ingredients, and useful staples from previous recipe runs.
7. Use available discovery/research capabilities only when recipe details, novelty, source evidence, or substitutions are needed. Keep discovery artifacts separate from grocery memory/audit output.
8. After confirmation or if the user asked for a fast draft, write a simple markdown grocery list organized by aisle/category. At the top include goals, meal ideas, breakfast ideas when relevant, snack ideas, and recipe/source notes.
9. Write an audit log for the week recording suggested/chosen recipes, repeats vs new ideas, assumptions, source URLs if any, and follow-up memory notes.

Required grocery-list sections:
- Title with week/date
- Goals
- Meal Ideas
- Breakfast Ideas, if applicable
- Snack Ideas
- Recipe Sources / Notes
- Produce
- Meat / Protein
- Dairy
- Bakery / Grains
- Pantry
- Frozen
- Spices / Condiments
- Notes / Audit

Dynamic question behavior:
For a seed like Korean honey BBQ, banana oatmeal muffins, egg bake, and cottage cheese pasta with spinach, derive questions from what memory does not yet know. If memory already contains usual servings, stocked staples, preferred spice level, or snack defaults, do not ask those again; state the default and proceed. If memory is empty, ask only the few missing details that materially affect quantities or substitutions, then save durable answers so future runs become less repetitive.`;
}

function helpText(ctx: ExtensionContext): string {
  return `Grocery Agent commands:
- /grocery plan [meal ideas or goals]
- /grocery explore [recipe/snack direction]
- /grocery memory
- /grocery audit

${formatPathBlock(ctx)}

Grocery Agent is vertically agnostic: it owns planning, memories, audits, and markdown grocery output. Other capabilities may combine with it for recipe/source discovery.`;
}

function briefCommandText(command: GroceryCommand, target: string): string {
  if (command === "help")
    return "Use Grocery Agent. Show concise help and explain that follow-up questions should be derived from memory, selected meals, stale pantry facts, and missing planning fields.";
  if (command === "memory") return "Use Grocery Agent to review recipe memory and preferences, then suggest concise memory updates.";
  if (command === "audit")
    return "Use Grocery Agent to review recent weekly audit logs and summarize repeats, skips, ratings, and follow-up memory notes.";
  const seed = target.trim() || "Ask me what I want for this week's grocery plan.";
  return `Use Grocery Agent for ${command}. Seed/request: ${seed}`;
}

async function notifyOnly(ctx: ExtensionCommandContext, text: string): Promise<void> {
  if (ctx.hasUI) ctx.ui.notify(text, "info");
}

export default function groceryAgentExtension(pi: ExtensionAPI) {
  pi.registerCommand("grocery", {
    description: "Plan weekly groceries with recipe memory, goals, audit logs, and aisle-organized markdown output",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const items = COMMANDS.filter((command) => command.startsWith(normalized)).map((command) => ({ value: command, label: command }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      if (parsed.command === "help") return notifyOnly(ctx, helpText(ctx));
      pi.sendUserMessage(briefCommandText(parsed.command, parsed.target));
    },
  });

  pi.registerTool({
    name: "grocery_plan",
    label: "Grocery Plan",
    description: "Build a Grocery Agent prompt for weekly meal planning and markdown grocery-list output",
    promptSnippet: "Prepare grocery planning prompts with memories, goals, audit logs, and aisle-organized markdown output",
    promptGuidelines: [
      "Use grocery_plan when the user asks for weekly meal prep, grocery lists, recipe memories, snack ideas, or aisle-organized grocery output.",
    ],
    parameters: Type.Object({
      request: Type.String({ description: "Meal ideas, goals, or grocery planning request" }),
      mode: Type.Optional(Type.Union([Type.Literal("plan"), Type.Literal("explore")], { description: "Planning mode" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const mode = params.mode ?? "plan";
      const prompt = groceryPrompt(ctx, mode, params.request);
      return {
        content: [{ type: "text", text: prompt }],
        details: { mode, workspace: workspace(ctx.cwd), paths: paths(ctx.cwd) },
      };
    },
  });
}
