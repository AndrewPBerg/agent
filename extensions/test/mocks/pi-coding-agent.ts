export type ExtensionAPI = MockPi;
export type ExtensionContext = any;
export type ExtensionCommandContext = any;
export type Theme = any;

export function isToolCallEventType(toolName: string, event: { toolName?: string }) {
  return event.toolName === toolName;
}

export function isBashToolResult(event: { toolName?: string }) {
  return event.toolName === "bash";
}

export function createLocalBashOperations() {
  return {
    exec: async () => ({ output: "", exitCode: 0, cancelled: false, truncated: false }),
  };
}

export function createBashTool(_cwd: string, options: any = {}) {
  return {
    name: "bash",
    label: "bash",
    description: "Run a shell command",
    parameters: {},
    execute: vi.fn(async (_id, params, signal, _onUpdate) => {
      if (options.operations) {
        const chunks: Buffer[] = [];
        const result = await options.operations.exec(params.command, _cwd, {
          onData: (data: Buffer) => chunks.push(data),
          signal,
          timeout: params.timeout,
          env: process.env,
        });
        return { content: [{ type: "text", text: Buffer.concat(chunks).toString() }], details: result };
      }
      return { content: [{ type: "text", text: "local" }], details: {} };
    }),
  };
}

export function createGrepTool(_cwd: string) {
  return {
    name: "grep",
    label: "grep",
    description: "Search file contents",
    parameters: {},
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "local grep" }], details: undefined })),
  };
}

export class SessionManager {
  static async list() {
    return [];
  }
  static async listAll() {
    return [];
  }
}

export const CONFIG_DIR_NAME = ".pi";

export class MockPi {
  events = new Map<string, Array<(...args: any[]) => any>>();
  commands = new Map<string, any>();
  tools = new Map<string, any>();
  messageRenderers = new Map<string, any>();
  toolRenderers = new Map<string, any>();
  shortcuts = new Map<string, any>();
  flags = new Map<string, any>();
  entries: Array<{ customType: string; data: any }> = [];
  activeTools = ["read", "bash", "edit", "write"];
  allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name }));
  flagValues = new Map<string, any>();

  on(event: string, handler: (...args: any[]) => any) {
    const handlers = this.events.get(event) ?? [];
    handlers.push(handler);
    this.events.set(event, handlers);
  }

  registerCommand(name: string, definition: any) {
    this.commands.set(name, definition);
  }

  registerTool(definition: any) {
    this.tools.set(definition.name, definition);
    if (!this.allTools.some((tool) => tool.name === definition.name)) this.allTools.push({ name: definition.name });
  }

  registerMessageRenderer(type: string, renderer: any) {
    this.messageRenderers.set(type, renderer);
  }

  registerToolRenderer(name: string, renderer: any) {
    this.toolRenderers.set(name, renderer);
  }

  registerShortcut(key: string, definition: any) {
    this.shortcuts.set(key, definition);
  }

  registerFlag(name: string, definition: any) {
    this.flags.set(name, definition);
  }

  appendEntry(customType: string, data: any) {
    this.entries.push({ customType, data });
  }

  sendUserMessage() {}
  sendMessage() {}
  getActiveTools() {
    return this.activeTools;
  }
  getAllTools() {
    return this.allTools;
  }
  setActiveTools(names: string[]) {
    this.activeTools = names;
  }
  getFlag(name: string) {
    return this.flagValues.get(name);
  }
}

export function createMockPi() {
  return new MockPi();
}

export function createMockContext(overrides: Partial<any> = {}) {
  return {
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      setWidget: vi.fn(),
      setTitle: vi.fn(),
      setEditorText: vi.fn(),
      getEditorText: vi.fn(() => ""),
      pasteToEditor: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
    },
    sessionManager: {
      getBranch: vi.fn(() => []),
      getEntries: vi.fn(() => []),
      getLeafId: vi.fn(() => undefined),
      getSessionFile: vi.fn(() => undefined),
    },
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    ...overrides,
  };
}

import { vi } from "vitest";
