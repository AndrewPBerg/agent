import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const INLINE_MODE_EVENT = "inline-mode:update";

export type InlineModeTone = "accent" | "dim" | "error" | "muted" | "success" | "warning";

export interface InlineModeFrame {
  icon: string;
  tone?: InlineModeTone;
}

export interface InlineModeState {
  label: string;
  detail?: string;
  icon?: string;
  tone?: InlineModeTone;
  frames?: readonly InlineModeFrame[];
  intervalMs?: number;
  priority?: number;
}

export interface ActiveInlineMode {
  id: string;
  state: InlineModeState;
}

export interface InlineModeUpdate {
  id: string;
  state?: InlineModeState;
}

/** Publish or clear a compact mode pill over Pi's shared inter-extension event bus. */
export function publishInlineMode(pi: ExtensionAPI, id: string, state: InlineModeState | undefined): void {
  pi.events.emit(INLINE_MODE_EVENT, { id, state } satisfies InlineModeUpdate);
}

export function sortedInlineModes(states: ReadonlyMap<string, InlineModeState>): ActiveInlineMode[] {
  return [...states.entries()]
    .map(([id, state]) => ({ id, state }))
    .sort((left, right) => (right.state.priority ?? 0) - (left.state.priority ?? 0) || left.id.localeCompare(right.id));
}

export function inlineModeAnimationInterval(modes: readonly ActiveInlineMode[]): number | undefined {
  const intervals = modes.filter((mode) => (mode.state.frames?.length ?? 0) > 1).map((mode) => Math.max(60, mode.state.intervalMs ?? 160));
  return intervals.length ? Math.min(...intervals) : undefined;
}
