import { spawnSync } from "node:child_process";

const OSC52_MAX_BASE64_BYTES = 100_000;

function clipboardCommands(): Array<readonly [string, readonly string[]]> {
  if (process.platform === "darwin") return [["pbcopy", []]];
  if (process.platform === "win32") return [["clip", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
}

export async function copySessionText(text: string): Promise<void> {
  for (const [command, args] of clipboardCommands()) {
    try {
      const result = spawnSync(command, args, {
        input: text,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 5_000,
      });
      if (!result.error && result.status === 0) return;
    } catch {
      // Try the next host clipboard backend.
    }
  }

  const encoded = Buffer.from(text).toString("base64");
  if (encoded.length <= OSC52_MAX_BASE64_BYTES) {
    process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
    return;
  }
  throw new Error("No clipboard helper available (install wl-clipboard, xclip, or xsel)");
}
