import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type State = "on" | "off";

const SHORTBREATH_PROMPT = `
SHORTBREATH MODE:
- Be concise. No preamble, no pleasantries.
- Prefer bullets over paragraphs.
- Default to <= 5 bullets or <= 120 words unless user asks for depth.
- Keep commands, code, paths, errors exact.
- Do not compress away warnings, uncertainty, security issues, or irreversible-action caveats.
- If blocked, ask one direct question.
`;

export default function shortbreath(pi: ExtensionAPI) {
  let state: State = "on";

  function setState(next: State, ctx: { ui: { setStatus(key: string, value?: string): void } }) {
    state = next;
    ctx.ui.setStatus("shortbreath", `shortbreath:${state}`);
  }

  pi.on("session_start", (_event, ctx) => {
    let restored: State = "on";

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "shortbreath") continue;
      const value = (entry.data as { state?: State } | undefined)?.state;
      if (value === "on" || value === "off") restored = value;
    }

    setState(restored, ctx);
  });

  pi.registerCommand("shortbreath", {
    description: "Toggle concise-response mode",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const items = ["on", "off", "stop"].filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = String(args ?? "")
        .trim()
        .toLowerCase();
      let next: State;

      if (!arg) next = state === "on" ? "off" : "on";
      else if (arg === "on") next = "on";
      else if (arg === "off" || arg === "stop") next = "off";
      else {
        ctx.ui.notify("Use /shortbreath, /shortbreath on, or /shortbreath off", "error");
        return;
      }

      setState(next, ctx);
      pi.appendEntry("shortbreath", { state });
      ctx.ui.notify(`shortbreath ${state}`, "info");
    },
  });

  pi.on("before_agent_start", (event) => {
    if (state !== "on") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${SHORTBREATH_PROMPT}` };
  });
}
