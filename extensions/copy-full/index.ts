import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function textBlock(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);

  return content
    .map((block: any) => {
      if (block?.type === "text") return block.text ?? "";
      if (block?.type === "thinking") return `<thinking>\n${block.thinking ?? ""}\n</thinking>`;
      if (block?.type === "toolCall")
        return `<tool_call name=${JSON.stringify(block.name)} id=${JSON.stringify(block.id)}>\n${JSON.stringify(block.arguments ?? {}, null, 2)}\n</tool_call>`;
      if (block?.type === "image") return `[image: ${block.mimeType ?? "unknown"}, ${String(block.data ?? "").length} base64 chars]`;
      return JSON.stringify(block, null, 2);
    })
    .filter(Boolean)
    .join("\n\n");
}

function formatMessage(message: any, mode: "full" | "debug"): string | null {
  switch (message.role) {
    case "user":
      return `### User\n\n${textBlock(message.content)}`;
    case "assistant":
      return mode === "debug"
        ? `### Assistant (${message.provider ?? "?"}/${message.model ?? "?"}; stop=${message.stopReason ?? "?"})\n\n${textBlock(message.content)}`
        : `### Assistant\n\n${textBlock(message.content)}`;
    case "toolResult":
      if (mode === "full" && message.toolName !== "bash") return null;
      return `### Command output${mode === "debug" ? `: ${message.toolName ?? "?"} (${message.isError ? "error" : "ok"})` : ""}\n\n${textBlock(message.content)}`;
    case "bashExecution":
      return `### Command\n\n\`\`\`bash\n${message.command ?? ""}\n\`\`\`\n\n### Command output\n\n\`\`\`text\n${message.output ?? ""}\n\`\`\``;
    case "custom":
      return mode === "debug" ? `### Custom: ${message.customType ?? "unknown"}\n\n${textBlock(message.content)}` : null;
    case "branchSummary":
      return mode === "debug" ? `### Branch summary\n\n${message.summary ?? ""}` : null;
    case "compactionSummary":
      return mode === "debug" ? `### Compaction summary\n\n${message.summary ?? ""}` : null;
    default:
      return mode === "debug" ? `### ${message.role ?? "message"}\n\n${JSON.stringify(message, null, 2)}` : null;
  }
}

function tryCopy(text: string): boolean {
  const attempts: Array<[string, string[]]> = [];
  if (process.platform === "darwin") attempts.push(["pbcopy", []]);
  else if (process.platform === "win32") attempts.push(["clip", []]);
  else {
    attempts.push(["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
  }

  for (const [cmd, args] of attempts) {
    try {
      const result = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 });
      if (!result.error && result.status === 0) return true;
    } catch {}
  }

  // OSC 52 fallback for terminal clipboard integrations; keep bounded.
  const encoded = Buffer.from(text).toString("base64");
  if (encoded.length <= 100_000) {
    process.stdout.write(`\x1b]52;c;${encoded}\x07`);
    return true;
  }
  return false;
}

function getMessages(ctx: any): any[] {
  return ctx.sessionManager
    .getBranch()
    .map((entry: any) => {
      if (entry.type === "message") return entry.message;
      if (entry.type === "compaction") return { role: "compactionSummary", summary: entry.summary };
      if (entry.type === "branch_summary") return { role: "branchSummary", summary: entry.summary };
      if (entry.type === "custom_message") return { role: "custom", customType: entry.customType, content: entry.content };
      return null;
    })
    .filter(Boolean);
}

function buildConversation(ctx: any, mode: "full" | "debug"): string {
  const body = getMessages(ctx)
    .map((message) => formatMessage(message, mode))
    .filter(Boolean)
    .join("\n\n---\n\n");

  if (mode === "full") return body + "\n";

  const options = ctx.getSystemPromptOptions?.();
  const contextFiles = (options?.contextFiles ?? [])
    .map((file: any) => `### ${file.path}\n\n\`\`\`\n${file.content ?? ""}\n\`\`\``)
    .join("\n\n");
  const skills = (options?.skills ?? []).map((skill: any) => `- ${skill.name ?? skill.path ?? JSON.stringify(skill)}`).join("\n");

  return [
    "# Pi debug conversation context",
    "",
    "## Session metadata",
    `- cwd: ${ctx.cwd}`,
    `- session: ${ctx.sessionManager.getSessionFile?.() ?? "in-memory"}`,
    `- model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"}`,
    "",
    "## System prompt",
    ctx.getSystemPrompt?.() ?? "",
    "",
    "## Loaded context files",
    contextFiles || "(none)",
    "",
    "## Loaded skills",
    skills || "(none)",
    "",
    "## Conversation",
    body,
    "",
  ].join("\n");
}

async function copyBuiltContext(ctx: any, mode: "full" | "debug") {
  await ctx.waitForIdle();
  const text = buildConversation(ctx, mode);
  if (!tryCopy(text))
    throw new Error("Failed to copy to clipboard (install wl-clipboard/xclip/xsel, or use a terminal with OSC 52 for <=100KB)");
  ctx.ui.notify(`Copied ${mode} context (${text.length.toLocaleString()} chars)`, "info");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-full", {
    description: "Copy visible user/assistant conversation plus command output",
    handler: async (_args, ctx) => copyBuiltContext(ctx, "full"),
  });

  pi.registerCommand("copy-debug", {
    description: "Copy full debug context including metadata, prompt, skills, and hidden entries",
    handler: async (_args, ctx) => copyBuiltContext(ctx, "debug"),
  });
}
