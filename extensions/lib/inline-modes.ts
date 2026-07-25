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

const states = new Map<string, InlineModeState>();
const listeners = new Set<() => void>();

/** Publish or clear a compact mode pill rendered by the shared inline footer. */
export function setInlineMode(id: string, state: InlineModeState | undefined): void {
  if (state) states.set(id, state);
  else states.delete(id);
  for (const listener of listeners) listener();
}

export function getInlineModes(): ActiveInlineMode[] {
  return [...states.entries()]
    .map(([id, state]) => ({ id, state }))
    .sort((left, right) => (right.state.priority ?? 0) - (left.state.priority ?? 0) || left.id.localeCompare(right.id));
}

export function inlineModeAnimationInterval(): number | undefined {
  const intervals = getInlineModes()
    .filter((mode) => (mode.state.frames?.length ?? 0) > 1)
    .map((mode) => Math.max(60, mode.state.intervalMs ?? 160));
  return intervals.length ? Math.min(...intervals) : undefined;
}

export function subscribeInlineModes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
