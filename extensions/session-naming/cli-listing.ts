import { writeSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CLI_COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
} as const;

export function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");
}

export function color(value: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${value}${CLI_COLORS.reset}` : value;
}

export function writeStdoutLine(output: string): void {
  writeSync(1, `${output}\n`);
}

export function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

export function registerSharedJsonFlag(pi: ExtensionAPI, flagName = "json"): void {
  try {
    pi.registerFlag(flagName, {
      description: "Output listing data as JSON",
      type: "boolean",
    });
  } catch {
    // Another extension already registered the shared --json flag.
  }
}
