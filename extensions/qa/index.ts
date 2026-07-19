import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BROWSER_QA_TOOL_NAME = "browser_qa_run";
const BROWSER_QA_APPROVAL = "BROWSER_QA_APPROVED=1";
const PLAYWRIGHT_OR_BROWSER_DRIVER = /\b(?:playwright|@playwright\/test|selenium|puppeteer)\b/i;
const BROWSER_QA_SHELL = /\b(?:yosoi|voidcrawl)\b/i;
const BROWSER_QA_CONTEXT = /\b(?:a3|browser|session|selector|qa)\b/i;
const SENSITIVE_BROWSER_ACTION =
  /\b(?:buy|checkout|create|delete|destroy|email|logout|mutate|payment|publish|purchase|remove|save|send|submit|update|upload|write)\b/i;
const SENSITIVE_URL_BITS = /[?&](?:access_token|api[_-]?key|auth|password|secret|session|token)=/i;

export function buildQaPrompt(focus?: string): string {
  const trimmedFocus = focus?.trim();
  return [
    "QA YOUR worked-on diff in this repository.",
    "",
    "Mission:",
    "- Stress, test, drive, and try to break the changed behavior.",
    "- Find edge cases, regressions, missing checks, brittle assumptions, and confusing UX before the work ships.",
    "- Improve the software, not just approve it.",
    "",
    "Tech debt pass:",
    "- Also flag debt introduced or worsened by the diff: duplication, leaky abstractions, brittle shortcuts, missing tests, or cleanup that should be tracked before it compounds.",
    "",
    "Required approach:",
    "- Inspect the current git diff, including staged, unstaged, and untracked changes; do not assume prior context is complete.",
    "- Identify the intended behavior from the diff, nearby code, tests, and docs.",
    "- Exercise realistic and adversarial paths with the narrowest meaningful tests/checks.",
    "- If you find a real issue, make the smallest targeted fix and rerun the relevant check.",
    "- If no fix is needed, report what you tested, what risks remain, and why the diff looks acceptable.",
    "- Avoid broad refactors or unrelated cleanup.",
    trimmedFocus ? `\nFocus requested by user:\n${trimmedFocus}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseBrowserQaArgs(args?: string): { target: string; scenario: string } {
  const trimmed = String(args ?? "").trim();
  if (!trimmed) return { target: "<target url or app route>", scenario: "selector-backed browser QA smoke" };

  const [target, ...rest] = trimmed.split(/\s+/);
  return {
    target,
    scenario: rest.join(" ").trim() || "selector-backed browser QA smoke",
  };
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/https?:\/\//g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "browser-qa"
  );
}

export function buildBrowserQaPrompt(args?: string): string {
  const { target, scenario } = parseBrowserQaArgs(args);
  const artifactRoot = `.yosoi/browser-qa/${slug(target)}`;

  return [
    "Launch a selector-backed browser QA run.",
    "",
    `Target: ${target}`,
    `Scenario: ${scenario}`,
    "",
    "Pi surface:",
    `- Command: /browser-qa ${target} ${scenario}`,
    `- Tool: call \`${BROWSER_QA_TOOL_NAME}\` before browser execution to declare targetUrl, scenario, selectors, allowedActions, blockedActions, and evidencePath.`,
    "",
    "Browser boundary:",
    "- Use VoidCrawl/Yosoi A3 for browser/session mechanics, selector resolution, AX/screenshot capture, and page evidence.",
    "- Do not install, import, scaffold, or run Playwright, Selenium, Puppeteer, or a new browser driver.",
    "- Start by discovering the repo-local VoidCrawl/Yosoi A3 command or tool. If that surface is unavailable, report the blocker instead of substituting another driver.",
    "",
    "Safety gates:",
    "- Default to read-only navigation, inspection, screenshots, AX tree capture, and selector checks.",
    "- Do not submit forms, purchase, delete, publish, send messages/email, upload files, change settings, log out, or mutate data unless the user explicitly approved that action.",
    `- If a sensitive action is approved, include \`${BROWSER_QA_APPROVAL}\` in the relevant tool/shell handoff and keep the action list narrow.`,
    "- Never include credentials, session tokens, API keys, or secret-bearing URLs in prompts, artifacts, shell commands, or selectors.",
    "",
    "Run contract:",
    `- Store evidence under \`${artifactRoot}/\`.`,
    `- Suggested artifacts: \`${artifactRoot}/selectors.json\`, \`${artifactRoot}/observations.jsonl\`, \`${artifactRoot}/report.md\`.`,
    "- Prefer stable selectors and accessible roles; record fallbacks when selectors are brittle.",
    "- Report passed checks, failed checks, blocked mechanics, exact selectors used, and remaining risk.",
  ].join("\n");
}

function includesApproval(value: string): boolean {
  return value.includes(BROWSER_QA_APPROVAL);
}

function isSensitiveBrowserQaShell(command: string): boolean {
  return BROWSER_QA_SHELL.test(command) && BROWSER_QA_CONTEXT.test(command) && SENSITIVE_BROWSER_ACTION.test(command);
}

function includesCredentialUrl(value: string): boolean {
  if (SENSITIVE_URL_BITS.test(value)) return true;

  const urls = value.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  return urls.some((raw) => {
    try {
      const parsed = new URL(raw);
      return Boolean(parsed.username || parsed.password);
    } catch {
      return false;
    }
  });
}

function normalizeList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function validateBrowserQaRun(params: Record<string, unknown>) {
  const targetUrl = String(params.targetUrl ?? "").trim();
  const scenario = String(params.scenario ?? "").trim();
  const selectors = normalizeList(params.selectors);
  const allowedActions = normalizeList(params.allowedActions);
  const blockedActions = normalizeList(params.blockedActions);
  const evidencePath = String(params.evidencePath ?? "").trim();
  const requiresSensitiveAction =
    Boolean(params.requiresSensitiveAction) || allowedActions.some((action) => SENSITIVE_BROWSER_ACTION.test(action));
  const approvalToken = String(params.approvalToken ?? "").trim();

  if (!targetUrl) throw new Error("browser_qa_run requires targetUrl.");
  if (includesCredentialUrl(targetUrl)) throw new Error("browser_qa_run targetUrl must not contain credentials, tokens, or secrets.");
  if (!scenario) throw new Error("browser_qa_run requires scenario.");
  if (!selectors.length) throw new Error("browser_qa_run requires at least one selector or accessible-role target.");
  if (!evidencePath.startsWith(".yosoi/browser-qa/") && !evidencePath.startsWith("/tmp/browser-qa/")) {
    throw new Error("browser_qa_run evidencePath must stay under .yosoi/browser-qa/ or /tmp/browser-qa/.");
  }
  if (requiresSensitiveAction && approvalToken !== BROWSER_QA_APPROVAL) {
    throw new Error(`Sensitive browser QA actions require explicit ${BROWSER_QA_APPROVAL}.`);
  }

  return { allowedActions, blockedActions, evidencePath, scenario, selectors, targetUrl };
}

export default function qa(pi: ExtensionAPI) {
  pi.registerCommand("qa", {
    description: "Stress-test and look for edge cases in the current worked-on diff",
    handler: async (args) => {
      pi.sendUserMessage(buildQaPrompt(String(args ?? "")));
    },
  });

  pi.registerCommand("browser-qa", {
    description: "Launch selector-backed browser QA through VoidCrawl/Yosoi A3",
    handler: async (args) => {
      pi.sendUserMessage(buildBrowserQaPrompt(String(args ?? "")));
    },
  });

  pi.registerTool({
    name: BROWSER_QA_TOOL_NAME,
    label: "Browser QA Run",
    description: "Validate and record a selector-backed browser QA handoff for VoidCrawl/Yosoi A3.",
    promptSnippet: "Declare the selector-backed browser QA run before invoking VoidCrawl/Yosoi browser mechanics.",
    promptGuidelines: [
      "Use this tool before running browser QA mechanics so target, selectors, allowed actions, blocked actions, and artifacts are explicit.",
      "Use VoidCrawl/Yosoi A3 for browser mechanics. Do not use Playwright, Selenium, Puppeteer, or a new browser driver.",
      `Set requiresSensitiveAction and approvalToken=${BROWSER_QA_APPROVAL} only when the user explicitly approved a sensitive action.`,
    ],
    parameters: Type.Object({
      targetUrl: Type.String({ description: "URL or local app route to inspect. Must not contain credentials or tokens." }),
      scenario: Type.String({ description: "The user-facing browser QA scenario to exercise." }),
      selectors: Type.Array(Type.String(), { description: "Stable CSS selectors or accessible-role targets to exercise." }),
      allowedActions: Type.Array(Type.String(), { description: "Narrow browser actions permitted for this run." }),
      blockedActions: Type.Array(Type.String(), { description: "Sensitive or irreversible actions that must not be performed." }),
      evidencePath: Type.String({ description: "Artifact directory under .yosoi/browser-qa/ or /tmp/browser-qa/." }),
      requiresSensitiveAction: Type.Optional(Type.Boolean({ description: "Whether the run performs sensitive or irreversible actions." })),
      approvalToken: Type.Optional(Type.String({ description: `Required value for sensitive runs: ${BROWSER_QA_APPROVAL}.` })),
    }),
    async execute(_toolCallId, params) {
      const run = validateBrowserQaRun(params as Record<string, unknown>);

      return {
        content: [
          {
            type: "text",
            text: [
              `Browser QA handoff accepted for ${run.targetUrl}.`,
              "Use VoidCrawl/Yosoi A3 for browser mechanics; do not use Playwright.",
              `Evidence path: ${run.evidencePath}`,
            ].join("\n"),
          },
        ],
        details: run,
      };
    },
  });

  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = String(event.input.command ?? "");
    if (PLAYWRIGHT_OR_BROWSER_DRIVER.test(command)) {
      return {
        block: true,
        reason: "Browser QA must use VoidCrawl/Yosoi A3. Do not install or run Playwright, Selenium, Puppeteer, or a new browser driver.",
      };
    }

    if (includesCredentialUrl(command)) {
      return {
        block: true,
        reason: "Browser QA commands must not include credentials, tokens, API keys, or secret-bearing URLs.",
      };
    }

    if (isSensitiveBrowserQaShell(command) && !includesApproval(command)) {
      return {
        block: true,
        reason: `Sensitive browser QA actions require explicit ${BROWSER_QA_APPROVAL} and a narrow allowed-action list.`,
      };
    }

    return undefined;
  });
}
