import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const BYPASS = /\bWTF_OK=1\b|#\s*wtf-ok\b/i;
const RAW_WORKTREE_ADD = /\bgit\s+(?:-[^\n\s]+\s+)*worktree\s+add\b/;
const ENV_CONTENT_READ =
  /(?:^|[;&|]\s*)(?:cat|less|more|head|tail|sed|awk|grep|rg|bat)\b[^\n]*(?:^|[\s'"])(?:[\w./-]*\.env[\w.-]*)(?:[\s'"]|$)/m;

const WTF_WORKTREE_GUIDANCE = `

# WTF worktrees
For agent worktrees use WTF, not raw git: \`wtf new <branch> --copy-env --no-serve\`.
For disposable trials add \`--no-install\`. Inside the wtf repo before release, use \`go run ./cmd/wtf new ...\`.
Never print/read \`.env*\`; verify copies only with \`stat\`, \`test ! -L\`, and \`cmp -s\`.\n`;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + WTF_WORKTREE_GUIDANCE };
  });

  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = String(event.input.command ?? "");
    if (BYPASS.test(command)) return undefined;

    if (RAW_WORKTREE_ADD.test(command)) {
      return {
        block: true,
        reason:
          "Use `wtf new <branch> --copy-env --no-serve` for agent worktrees. Add `WTF_OK=1` only when raw git worktree behavior is required.",
      };
    }

    if (ENV_CONTENT_READ.test(command)) {
      return {
        block: true,
        reason:
          "Do not print/read .env contents. Verify with `stat`, `test -f`, `test ! -L`, or `cmp -s` only. Add `WTF_OK=1` only with explicit approval.",
      };
    }

    return undefined;
  });
}
