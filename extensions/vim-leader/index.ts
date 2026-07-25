import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { VIM_LEADER_EVENT } from "./protocol";

const LEADER = " ";
const LEADER_TIMEOUT_MS = 500;
const SEQUENCES = ["d", "m", "y"] as const;

export default function vimLeader(pi: ExtensionAPI) {
  let sequence: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeTerminal: (() => void) | undefined;

  const clear = () => {
    sequence = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    unsubscribeTerminal?.();
    unsubscribeTerminal = ctx.ui.onTerminalInput((data) => {
      if (sequence === undefined) {
        if (!isKey(data, "space", LEADER) || ctx.ui.getEditorText().length !== 0) return undefined;
        sequence = "";
        timer = setTimeout(clear, LEADER_TIMEOUT_MS);
        return { consume: true };
      }

      sequence += sequenceKey(data) ?? data;
      const exact = SEQUENCES.find((candidate) => candidate === sequence);
      const prefix = SEQUENCES.some((candidate) => candidate.startsWith(sequence));
      if (exact) {
        clear();
        pi.events.emit(VIM_LEADER_EVENT, { sequence: exact });
        return { consume: true };
      }
      if (prefix) return { consume: true };

      const replay = sequence;
      clear();
      return { data: replay };
    });
  });

  pi.on("session_shutdown", () => {
    clear();
    unsubscribeTerminal?.();
    unsubscribeTerminal = undefined;
  });
}

function sequenceKey(data: string): string | undefined {
  return [...new Set(SEQUENCES.flatMap((candidate) => [...candidate]))].find((key) => isKey(data, key, key));
}

function isKey(data: string, key: string, raw: string): boolean {
  return data === raw || matchesKey(data, key);
}
