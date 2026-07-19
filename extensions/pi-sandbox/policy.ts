import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SAFE_DOTENV_NAMES = new Set([".env.example", ".env.sample", ".env.template"]);
const PRIVATE_KEY_NAMES = new Set(["id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"]);
const SKIPPED_SCAN_DIRECTORIES = new Set([".cache", ".git", "node_modules", "sandbox-cache"]);

export const HOST_EXECUTION_TOOLS = new Set([
  "bugrun_continue",
  "bugrun_debug",
  "bugrun_expand",
  "bugrun_start",
  "bugrun_status",
  "bugrun_stop",
  "flameframe_inspect",
  "flameframe_process",
  "flameframe_zoom",
]);

export function normalizeToolPath(inputPath: string, cwd: string): string {
  const withoutAt = inputPath.trim().replace(/^@/, "");
  return isAbsolute(withoutAt) ? resolve(withoutAt) : resolve(cwd, withoutAt || ".");
}

async function canonicalizeWithExistingParent(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath);
  } catch {
    const missing: string[] = [];
    let current = absolutePath;

    for (;;) {
      const parent = dirname(current);
      if (parent === current) return absolutePath;
      missing.unshift(basename(current));
      current = parent;
      try {
        const canonicalParent = await realpath(current);
        return resolve(canonicalParent, ...missing);
      } catch {
        // Continue until an existing parent is found.
      }
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isSensitiveFilename(name: string): boolean {
  if (name === ".env" || (name.startsWith(".env.") && !SAFE_DOTENV_NAMES.has(name))) return true;
  if (PRIVATE_KEY_NAMES.has(name) || [...PRIVATE_KEY_NAMES].some((prefix) => name.startsWith(`${prefix}.`))) return true;
  return name.endsWith(".key") || name.endsWith(".pem");
}

export function protectedRoots(home: string, uid = process.getuid?.()): string[] {
  const roots = [
    join(home, ".ssh"),
    join(home, ".cache"),
    join(home, ".gnupg"),
    join(home, ".aws"),
    join(home, ".azure"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".config", "gcloud"),
    join(home, ".config", "gh"),
    join(home, ".pi", "agent", "mcp-oauth"),
    "/proc",
    "/sys",
  ];
  if (uid !== undefined) roots.push(`/run/user/${uid}`);
  return roots.map((path) => resolve(path));
}

export async function protectedPathReason(inputPath: string, cwd: string, home = process.env.HOME ?? ""): Promise<string | undefined> {
  const lexical = normalizeToolPath(inputPath, cwd);
  const canonical = await canonicalizeWithExistingParent(lexical);
  const candidates = [lexical, canonical];

  for (const candidate of candidates) {
    if (isSensitiveFilename(basename(candidate))) return "sensitive environment or private-key file";
  }

  const roots = protectedRoots(home);
  for (const root of roots) {
    if (candidates.some((candidate) => isWithin(root, candidate))) return `protected path ${root}`;
  }

  const exactFiles = [join(home, ".pi", "agent", "auth.json"), join(home, ".pi", "agent", "settings.json")].map((path) => resolve(path));
  if (exactFiles.some((path) => candidates.includes(path))) return "Pi credential-bearing configuration";

  return undefined;
}

async function pathKind(path: string): Promise<"directory" | "file" | undefined> {
  try {
    const info = await lstat(path);
    if (info.isDirectory()) return "directory";
    if (info.isFile() || info.isSymbolicLink()) return "file";
  } catch {
    return undefined;
  }
  return undefined;
}

export async function existingProtectedDirectories(home: string): Promise<string[]> {
  const result: string[] = [];
  for (const path of protectedRoots(home)) {
    if ((await pathKind(path)) === "directory") result.push(path);
  }
  return result;
}

async function discoverSensitiveFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_SCAN_DIRECTORIES.has(entry.name)) pending.push(path);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && isSensitiveFilename(entry.name)) {
        if (entry.isSymbolicLink()) {
          try {
            found.push(await realpath(path));
          } catch {
            // A broken symlink has no secret content to expose.
          }
        } else {
          found.push(path);
        }
      }
    }
  }

  return found;
}

export async function sensitiveFilesForSandbox(cwd: string, home: string): Promise<string[]> {
  const roots = new Set([resolve(cwd), resolve(home)]);
  const found = new Set<string>();
  for (const root of roots) {
    for (const path of await discoverSensitiveFiles(root)) found.add(path);
  }

  for (const path of [join(home, ".pi", "agent", "auth.json"), join(home, ".pi", "agent", "settings.json")]) {
    if ((await pathKind(path)) === "file") {
      try {
        found.add(await realpath(path));
      } catch {
        found.add(path);
      }
    }
  }

  return [...found].sort();
}

export async function workspaceAndGitMounts(cwd: string): Promise<string[]> {
  let current = resolve(cwd);
  let workspace = current;
  const mounts = new Set<string>();

  for (;;) {
    const dotGit = join(current, ".git");
    const kind = await pathKind(dotGit);
    if (kind) {
      workspace = current;
      if (kind === "file") {
        try {
          const text = await readFile(dotGit, "utf8");
          const match = /^gitdir:\s*(.+)$/m.exec(text);
          if (match) {
            const gitDir = resolve(current, match[1]!.trim());
            mounts.add(gitDir);
            try {
              const commonText = await readFile(join(gitDir, "commondir"), "utf8");
              mounts.add(resolve(gitDir, commonText.trim()));
            } catch {
              mounts.add(resolve(gitDir, "..", ".."));
            }
          }
        } catch {
          // A malformed .git file should not widen the sandbox.
        }
      }
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  mounts.add(workspace);
  return [...mounts];
}
