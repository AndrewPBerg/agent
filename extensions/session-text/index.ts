import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VIM_LEADER_EVENT, type VimLeaderInvocation } from "../vim-leader/protocol";
import { openSessionTextBrowser } from "./browser";

export default function sessionText(pi: ExtensionAPI) {
  let sessionContext: ExtensionContext | undefined;

  pi.registerCommand("session-text", {
    description: "Browse, search, and copy canonical session text",
    handler: async (_args, ctx) => openSessionTextBrowser(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
  });

  pi.on("session_shutdown", () => {
    sessionContext = undefined;
  });

  const unsubscribeLeader = pi.events.on(VIM_LEADER_EVENT, (data) => {
    const invocation = data as VimLeaderInvocation;
    if (invocation?.action !== "session-text" || !sessionContext) return;
    void openSessionTextBrowser(sessionContext).catch((error) => {
      sessionContext?.ui.notify(`Could not open session text: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
  });

  pi.on("session_shutdown", unsubscribeLeader);
}
