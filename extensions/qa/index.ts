import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function qa(pi: ExtensionAPI) {
  pi.registerCommand("qa", {
    description: "Stress-test and look for edge cases in the current worked-on diff",
    handler: async (args) => {
      pi.sendUserMessage(buildQaPrompt(String(args ?? "")));
    },
  });
}
