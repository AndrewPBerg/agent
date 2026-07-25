export function shouldCreateInitialTitlePending(args: {
  pending: boolean;
  generating: boolean;
  titleGenerationEnabled: boolean;
  hasTemporaryTitle: boolean;
  shouldSkip: boolean;
}): boolean {
  if (args.pending || args.generating) return false;
  if (!args.titleGenerationEnabled) return false;
  if (args.hasTemporaryTitle) return false;
  return !args.shouldSkip;
}
