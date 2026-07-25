import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type ProjectMetadata = {
  source: string;
  ecosystem: string;
  name: string;
};

type Detector = {
  source: string;
  ecosystem: string;
  read(cwd: string): string | undefined;
};

const MAX_METADATA_ITEMS = 8;

export function collectProjectMetadata(cwd: string): ProjectMetadata[] {
  const out: ProjectMetadata[] = [];
  const seen = new Set<string>();
  for (const detector of detectors(cwd)) {
    const name = cleanName(detector.read(cwd));
    if (!name) continue;
    const key = `${detector.ecosystem}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: detector.source,
      ecosystem: detector.ecosystem,
      name,
    });
    if (out.length >= MAX_METADATA_ITEMS) break;
  }
  return out;
}

export function formatProjectMetadata(projects: ProjectMetadata[]): string {
  return projects.map((project) => `${project.ecosystem}:${project.name} (${project.source})`).join(", ");
}

function detectors(cwd: string): Detector[] {
  return [
    jsonDetector("package.json", "node", (json) => stringField(json, "name")),
    tomlDetector("Cargo.toml", "rust", (toml) => tomlSectionString(toml, "package", "name")),
    tomlDetector(
      "pyproject.toml",
      "python",
      (toml) => tomlSectionString(toml, "project", "name") ?? tomlSectionString(toml, "tool.poetry", "name"),
    ),
    yamlDetector("pubspec.yaml", "dart", (yaml) => yamlTopLevelString(yaml, "name")),
    textDetector("go.mod", "go", (text) => text.match(/^\s*module\s+(\S+)/m)?.[1]),
    jsonDetector("composer.json", "php", (json) => stringField(json, "name")),
    textDetector("pom.xml", "jvm", parsePomName),
    textDetector("settings.gradle", "gradle", parseGradleRootName),
    textDetector("settings.gradle.kts", "gradle", parseGradleRootName),
    textDetector("build.gradle", "gradle", parseGradleRootName),
    textDetector("build.gradle.kts", "gradle", parseGradleRootName),
    ...gemspecDetectors(cwd),
    textDetector("mix.exs", "elixir", (text) => text.match(/\bapp:\s*:([A-Za-z0-9_]+)/)?.[1]),
    jsonDetector("deno.json", "deno", (json) => stringField(json, "name")),
    jsonDetector("deno.jsonc", "deno", (json) => stringField(json, "name")),
  ];
}

function jsonDetector(source: string, ecosystem: string, readJson: (json: unknown) => string | undefined): Detector {
  return {
    source,
    ecosystem,
    read: (cwd) => {
      const text = readText(join(cwd, source));
      if (!text) return undefined;
      try {
        return readJson(JSON.parse(stripJsonComments(text)));
      } catch {
        return undefined;
      }
    },
  };
}

function tomlDetector(source: string, ecosystem: string, readToml: (toml: string) => string | undefined): Detector {
  return {
    source,
    ecosystem,
    read: (cwd) => {
      const text = readText(join(cwd, source));
      return text ? readToml(text) : undefined;
    },
  };
}

function yamlDetector(source: string, ecosystem: string, readYaml: (yaml: string) => string | undefined): Detector {
  return {
    source,
    ecosystem,
    read: (cwd) => {
      const text = readText(join(cwd, source));
      return text ? readYaml(text) : undefined;
    },
  };
}

function textDetector(source: string, ecosystem: string, readTextFile: (text: string) => string | undefined): Detector {
  return {
    source,
    ecosystem,
    read: (cwd) => {
      const text = readText(join(cwd, source));
      return text ? readTextFile(text) : undefined;
    },
  };
}

function gemspecDetectors(cwd: string): Detector[] {
  try {
    return readdirSync(cwd)
      .filter((entry) => entry.endsWith(".gemspec"))
      .sort()
      .slice(0, 3)
      .map((source) =>
        textDetector(
          source,
          "ruby",
          (text) => text.match(/\b(?:spec|s)\.name\s*=\s*["']([^"']+)["']/)?.[1] ?? basename(source, ".gemspec"),
        ),
      );
  } catch {
    return [];
  }
}

function readText(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" ? item : undefined;
}

function cleanName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function tomlSectionString(toml: string, section: string, key: string): string | undefined {
  const lines = toml.split(/\r?\n/);
  let inSection = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      inSection = sectionMatch[1] === section;
      continue;
    }
    if (!inSection) continue;
    const keyMatch = line.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(.+)$`));
    if (!keyMatch) continue;
    return parseTomlStringValue(keyMatch[1]!);
  }
  return undefined;
}

function parseTomlStringValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.match(/^["']([^"']+)["']/)?.[1];
}

function yamlTopLevelString(yaml: string, key: string): string | undefined {
  const match = yaml.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m"));
  if (!match) return undefined;
  return match[1]!
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+#.*$/, "");
}

function parsePomName(xml: string): string | undefined {
  const artifactId = xml.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1];
  if (!artifactId) return undefined;
  const groupId = xml.match(/<groupId>\s*([^<]+?)\s*<\/groupId>/)?.[1];
  return groupId ? `${groupId}:${artifactId}` : artifactId;
}

function parseGradleRootName(text: string): string | undefined {
  return text.match(/\brootProject\.name\s*=\s*["']([^"']+)["']/)?.[1] ?? text.match(/\brootProject\.name\s*=\s*"([^"]+)"/)?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
