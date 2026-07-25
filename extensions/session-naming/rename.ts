import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runAutoTitleCommand } from "./auto-title.js";
import { DEFAULT_PI_CONFIG, loadPiConfig, type SessionRenameConfig } from "./config.js";
import { markManualTitle } from "./state.js";
import { emitSessionTitleMessage } from "./title-message.js";

async function loadRenameConfig(cwd: string): Promise<SessionRenameConfig> {
  try {
    return (await loadPiConfig(cwd)).config.session.rename;
  } catch {
    return DEFAULT_PI_CONFIG.session.rename;
  }
}

export async function registerSessionRename(pi: ExtensionAPI): Promise<void> {
  const config = await loadRenameConfig(process.cwd());
  if (!config.enabled) return;

  pi.registerCommand(config.command || "rename", {
    description: "Rename the current session, or use `/rename auto` to regenerate its title",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg.toLowerCase() === "auto") {
        await runAutoTitleCommand(pi, ctx);
        return;
      }

      let name = arg;
      if (!name && config.interactiveWhenEmpty) {
        const current = pi.getSessionName() ?? "";
        const input = await ctx.ui.input("Rename session", current);
        if (input === undefined) return;
        name = input.trim();
      }

      if (!name && !config.interactiveWhenEmpty) {
        const current = pi.getSessionName();
        ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
        return;
      }

      pi.setSessionName(name);
      markManualTitle(pi, name);
      emitSessionTitleMessage(
        pi,
        {
          title: name,
          actor: "/rename",
          source: "manual",
        },
        { ctx },
      );
    },
  });
}

export default registerSessionRename;
