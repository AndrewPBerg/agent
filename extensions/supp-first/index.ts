import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const BYPASS = /\bSUPP_OK=1\b|#\s*supp-ok\b/i;
const AD_HOC_SCRIPT = /\b(?:python3?|node|ruby|perl)\s+(?:-c\b|-\s*<<|<<)/;
const SUPP_OUTPUT_PARSE = /\bsupp\b[\s\S]*(?:\|\s*(?:python3?|node|ruby|perl)\b|>\s*\/tmp\/supp|\/tmp\/pi-bash-|\/tmp\/supp-)/;
const UNBOUNDED_SUPP_TREE_JSON = /\bsupp\s+(?:-n\s+|--no-copy\s+)?tree\b(?=[^\n]*(?:^|\s)--json(?:\s|$))(?![^\n]*(?:\s-d\b|\s--depth\b))/;

const SUPP_GUIDANCE =
  `

# SUPP-aware guidance
When the current working directory is inside a git/code repository and the user asks how/where/why/what about the code, behavior, tests, config, dependencies, or architecture, inspect the repository before answering unless they explicitly ask for a no-tools/high-level answer. Prefer a small evidence-gathering pass and cite relevant files/symbols; do not answer repo-specific questions from memory alone.

For repo exploration and question answering, prefer bounded, human-readable SUPP when it fits: ` +
  "`supp -n tree -d 2`, `supp -n diff`, `supp -n sym <query>`, `supp -n why <target>`, `supp -n deps <path> -d 1`, or `supp -n <paths> --map`." +
  ` Raw Unix tools like ls/find/rg are valid when they are the direct, simple way to answer the question.

If you clone, enter, or assess a code repository, run one bounded SUPP topology command unless the task is purely literal docs/config lookup: ` +
  "`supp -n tree <repo> -d 2`." +
  ` For third-party packages, extensions, CLIs, or tools that will run locally, do a small source-shape review before recommending install:
- inspect manifest/package metadata, install/lifecycle scripts, and declared entrypoints;
- prefer ` +
  "`supp -n tree <repo> -d 2`, `supp -n <entrypoint> --map`, and `supp -n deps <entrypoint> -d 1`;" +
  `
- use rg/read for exact risky strings such as postinstall, preinstall, exec, spawn, child_process, curl, fetch, token, env, writeFile, chmod, shell, oauth;
- include recommendation, confidence, what was inspected, main risks, pinned/temporary install command, rollback command, and verification command.

Do not dump large SUPP JSON and write ad-hoc Python/Node/Ruby/Perl to parse it unless there is a clear reason and the command marker SUPP_OK=1.`;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + SUPP_GUIDANCE,
    };
  });

  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = String(event.input.command ?? "");
    if (BYPASS.test(command)) return undefined;

    if (UNBOUNDED_SUPP_TREE_JSON.test(command)) {
      return {
        block: true,
        reason:
          "SUPP-first gate: do not run unbounded `supp tree --json`; it creates huge JSON then tempts ad-hoc parsing. Use `supp -n tree -d 2` or `supp -n tree <path> -d 3` first. Add `SUPP_OK=1` only with a reason.",
      };
    }

    if (AD_HOC_SCRIPT.test(command) && SUPP_OUTPUT_PARSE.test(command)) {
      return {
        block: true,
        reason:
          "SUPP-aware gate: ad-hoc parsing of large SUPP output is blocked. Use smaller SUPP commands/flags (`supp -n tree -d 2`, `supp -n tree <path> -d 3`, `supp -n <path> --map`, `supp -n sym`, `supp -n why`) or rerun with `SUPP_OK=1` and state why.",
      };
    }

    return undefined;
  });
}
