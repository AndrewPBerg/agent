import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { type MarkdownPresentation, SemanticMarkdown } from "./renderer.ts";

const CUSTOM_TYPE = "pi.markdown-presentation";
const PATCH_STATE = Symbol.for("andrew.agent.semantic-markdown.patch-state");

type PatchState = {
  presentation: MarkdownPresentation;
  patchedPrototypes: WeakSet<object>;
};

type GlobalWithPatch = typeof globalThis & { [PATCH_STATE]?: PatchState };

function state(): PatchState {
  const target = globalThis as GlobalWithPatch;
  if (!target[PATCH_STATE]) {
    target[PATCH_STATE] = {
      presentation: "semantic",
      patchedPrototypes: new WeakSet<object>(),
    };
  }
  return target[PATCH_STATE];
}

function patchMarkdownRenderer(): void {
  const target = Markdown.prototype as unknown as Record<PropertyKey, unknown>;
  const patchState = state();
  if (patchState.patchedPrototypes.has(target)) return;

  for (const key of Reflect.ownKeys(SemanticMarkdown.prototype)) {
    if (key === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(SemanticMarkdown.prototype, key);
    if (descriptor) Object.defineProperty(target, key, descriptor);
  }

  const semanticRender = SemanticMarkdown.prototype.render;
  Object.defineProperty(target, "render", {
    configurable: true,
    writable: true,
    value(this: { options?: Record<string, unknown> }, width: number): string[] {
      this.options ??= {};
      this.options.presentation = patchState.presentation;
      return semanticRender.call(this as unknown as SemanticMarkdown, width);
    },
  });
  patchState.patchedPrototypes.add(target);
}

function isPresentation(value: unknown): value is MarkdownPresentation {
  return value === "semantic" || value === "source";
}

function presentationFromBranch(ctx: ExtensionContext): MarkdownPresentation {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    const value = (entry.data as { presentation?: unknown } | undefined)?.presentation;
    if (isPresentation(value)) return value;
  }
  return "semantic";
}

function applyPresentation(ctx: ExtensionContext, presentation = presentationFromBranch(ctx)): void {
  state().presentation = presentation;
  if (ctx.mode === "tui") {
    ctx.ui.setStatus("semantic-markdown", ctx.ui.theme.fg("dim", `md:${presentation}`));
  }
}

export default function semanticMarkdownExtension(pi: ExtensionAPI): void {
  patchMarkdownRenderer();

  pi.on("session_start", (_event, ctx) => {
    applyPresentation(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    applyPresentation(ctx);
  });

  pi.registerCommand("presentation", {
    description: "Show or change Markdown presentation (semantic|source)",
    getArgumentCompletions(prefix) {
      return ["semantic", "source"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (!requested) {
        ctx.ui.notify(`Markdown presentation: ${state().presentation}`, "info");
        return;
      }
      if (!isPresentation(requested)) {
        ctx.ui.notify("Usage: /presentation semantic|source", "warning");
        return;
      }
      pi.appendEntry(CUSTOM_TYPE, { version: 1, presentation: requested });
      applyPresentation(ctx, requested);
      ctx.ui.notify(`Markdown presentation: ${requested}`, "info");
    },
  });
}
