import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionAutoTitle } from "./auto-title.js";
import { DEFAULT_PI_CONFIG, loadPiConfig } from "./config.js";
import { registerSessionList } from "./list.js";
import { registerSessionRename } from "./rename.js";
import { registerSessionTitleMessageRenderer } from "./title-message.js";

async function loadConfig() {
  try {
    return (await loadPiConfig(process.cwd())).config;
  } catch {
    return DEFAULT_PI_CONFIG;
  }
}

export default async function sessionExtension(pi: ExtensionAPI): Promise<void> {
  const config = await loadConfig();
  registerSessionTitleMessageRenderer(pi);
  await registerSessionList(pi);
  await registerSessionRename(pi);
  registerSessionAutoTitle(pi, config);
}
