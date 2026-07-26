import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const INLINE_MODE_EVENT = "inline-mode:update";

export type InlineModeTone = "accent" | "dim" | "error" | "muted" | "success" | "warning";

export type InlineModeColor = readonly [red: number, green: number, blue: number];

export interface InlineModeFrame {
  icon: string;
  tone?: InlineModeTone;
  color?: InlineModeColor;
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

export interface InlineModeUpdate {
  id: string;
  state?: InlineModeState;
}

/** Build a fixed-glyph, cosine-eased color breath without changing terminal cell width. */
export function smoothBreathingFrames(icon: string, low: InlineModeColor, high: InlineModeColor, frameCount = 60): InlineModeFrame[] {
  const count = Math.max(2, Math.round(frameCount));
  return Array.from({ length: count }, (_, index) => {
    const amount = (1 - Math.cos((index / count) * Math.PI * 2)) / 2;
    const color = low.map((channel, channelIndex) =>
      Math.round(channel + (high[channelIndex]! - channel) * amount),
    ) as unknown as InlineModeColor;
    return { icon, color };
  });
}

/** Publish or clear a compact mode pill over Pi's shared inter-extension event bus. */
export function publishInlineMode(pi: ExtensionAPI, id: string, state: InlineModeState | undefined): void {
  pi.events.emit(INLINE_MODE_EVENT, { id, state } satisfies InlineModeUpdate);
}
