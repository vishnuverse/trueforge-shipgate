// Repo root and .env loading. Values are never printed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `git rev-parse --show-toplevel`, falling back to the parent of orchestrator/. */
export function repoRoot(): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: HERE,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return out;
  } catch {
    // not a git checkout (e.g. a tarball): fall through
  }
  return resolve(HERE, "..", "..");
}

/** Parse KEY=VALUE lines (optional `export `, quotes, # comments). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    let value = m[2] as string;
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, -1);
      if (q === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[key] = value;
  }
  return out;
}

/** Load <root>/.env into process.env without overriding variables that are already set. Returns the keys loaded. */
export function loadDotenv(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const path = join(root, ".env");
  if (!existsSync(path)) return [];
  const parsed = parseDotenv(readFileSync(path, "utf8"));
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) {
      env[k] = v;
      loaded.push(k);
    }
  }
  return loaded;
}
