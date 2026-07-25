import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

export const AUTO_TITLE_ENTRY = "pi-extensions-session-title";
export const MANUAL_TITLE_ENTRY = "pi-extensions-session-title-manual";

export type TitleState = {
  title?: string;
  at: string;
  source: "auto" | "manual";
  temporary?: boolean;
};

type CustomEntryLike = {
  type: string;
  customType?: string;
  data?: unknown;
};

function isTitleState(value: unknown): value is TitleState {
  return value !== null && typeof value === "object" && "source" in value;
}

export function getLatestAutoTitleState(ctx: ExtensionContext): TitleState | undefined {
  let latest: TitleState | undefined;
  for (const entry of ctx.sessionManager.getEntries() as CustomEntryLike[]) {
    if (entry.type !== "custom" || entry.customType !== AUTO_TITLE_ENTRY) continue;
    if (isTitleState(entry.data)) latest = entry.data;
  }
  return latest;
}

export function hasManualTitle(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === MANUAL_TITLE_ENTRY);
}

export function hasTemporaryAutoTitle(ctx: ExtensionContext): boolean {
  return getLatestAutoTitleState(ctx)?.temporary === true;
}

export function shouldSkipAutoTitle(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  options: { allowTemporaryRetry?: boolean; force?: boolean } = {},
): boolean {
  if (options.force) return false;
  if (hasManualTitle(ctx)) return true;
  const latestAuto = getLatestAutoTitleState(ctx);
  const currentName = pi.getSessionName();
  if (latestAuto?.temporary && options.allowTemporaryRetry) {
    // If another surface (for example Pi's builtin /name) changed the name after
    // our temporary title, treat that as a manual name and do not overwrite it.
    return Boolean(currentName && currentName !== latestAuto.title);
  }
  if (latestAuto) return true;
  return Boolean(currentName);
}

export function markAutoTitle(pi: ExtensionAPI, title: string, model: string, temporary: boolean): void {
  pi.appendEntry<TitleState & { model: string }>(AUTO_TITLE_ENTRY, {
    title,
    model,
    temporary,
    at: new Date().toISOString(),
    source: "auto",
  });
}

export function markManualTitle(pi: ExtensionAPI, title?: string): void {
  pi.appendEntry<TitleState>(MANUAL_TITLE_ENTRY, {
    title,
    at: new Date().toISOString(),
    source: "manual",
  });
}

export function markManualTitleInSession(sessionManager: SessionManager, title?: string): void {
  sessionManager.appendCustomEntry(MANUAL_TITLE_ENTRY, {
    title,
    at: new Date().toISOString(),
    source: "manual",
  } satisfies TitleState);
}
