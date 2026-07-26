import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { LEADER_MAPPINGS } from "../../leader-mappings";
import { VIM_LEADER_EVENT } from "./protocol";

const LEADER = " ";
const LEADER_TIMEOUT_MS = 500;
const VIM_MODE_EVENT = "vim-mode:update";
const SEQUENCES = Object.keys(LEADER_MAPPINGS) as Array<keyof typeof LEADER_MAPPINGS>;

type VimMode = "insert" | "normal" | "visual" | "visualLine" | "visualBlock";

type VimLeaderDependencies = {
  submitEditor: () => void;
  defer: (callback: () => void) => void;
};

const defaultDependencies: VimLeaderDependencies = {
  submitEditor: () => {
    process.stdin.emit("data", Buffer.from("\r"));
  },
  defer: queueMicrotask,
};

export function createVimLeader(pi: ExtensionAPI, dependencies: Partial<VimLeaderDependencies> = {}) {
  const deps = { ...defaultDependencies, ...dependencies };
  let sequence: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeTerminal: (() => void) | undefined;
  let vimMode: VimMode | undefined;

  const unsubscribeVimMode = pi.events.on(VIM_MODE_EVENT, (data) => {
    vimMode = (data as { mode?: VimMode }).mode;
    if (vimMode === "insert") clear();
  });

  const clear = () => {
    sequence = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    unsubscribeTerminal?.();
    unsubscribeTerminal = ctx.ui.onTerminalInput((data) => {
      // Raw extension listeners run before TUI filters Kitty key-release events.
      // A Space release must not cancel the leader before the command key arrives.
      if (isKeyRelease(data)) return undefined;

      if (sequence === undefined) {
        if (vimMode === "insert" || !isKey(data, "space", LEADER) || ctx.ui.getEditorText().length !== 0) return undefined;
        sequence = "";
        timer = setTimeout(clear, LEADER_TIMEOUT_MS);
        return { consume: true };
      }

      sequence += sequenceKey(data) ?? data;
      const exact = SEQUENCES.find((candidate) => candidate === sequence);
      const prefix = SEQUENCES.some((candidate) => candidate.startsWith(sequence));
      if (exact) {
        const action = LEADER_MAPPINGS[exact];
        clear();
        if (action === "reload") triggerReload(ctx, deps);
        else pi.events.emit(VIM_LEADER_EVENT, { sequence: exact, action });
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
    vimMode = undefined;
    unsubscribeTerminal?.();
    unsubscribeTerminal = undefined;
    unsubscribeVimMode();
  });
}

export default function vimLeader(pi: ExtensionAPI) {
  createVimLeader(pi);
}

function triggerReload(ctx: ExtensionContext, deps: VimLeaderDependencies) {
  ctx.ui.setEditorText("/reload");
  deps.defer(deps.submitEditor);
}

function sequenceKey(data: string): string | undefined {
  return [...new Set(SEQUENCES.flatMap((candidate) => [...candidate]))].find((key) => isKey(data, key, key));
}

function isKey(data: string, key: string, raw: string): boolean {
  return data === raw || matchesKey(data, key);
}
