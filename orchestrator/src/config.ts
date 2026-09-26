// shipgate.yaml loader (spec docs/superpowers/specs/2026-09-26-any-repo-setup-design.md §2). Same rules as
// scripts/shipgate_config.py; both run tests/fixtures/config/. SHIPGATE_CONFIG=<path> overrides the location.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const URL_RE = /^https?:\/\/[^\s/]+/;
const MAX_DESCRIPTION = 500;
const SCHEMA: Record<string, readonly string[]> = {
  target: ["repo", "default_branch", "description"],
  python: ["install", "test", "source_dir", "tests_dir"],
  trueforge: ["url", "model"],
};

export class ConfigError extends Error {}

export interface Config {
  repo: string;
  owner: string;
  name: string;
  defaultBranch: string;
  description: string;
  install: string;
  test: string;
  sourceDir: string;
  testsDir: string;
  trueforgeUrl: string;
  model: string;
}

/** SHIPGATE_CONFIG, else the git-ignored shipgate.local.yaml (each runner's own target), else shipgate.yaml. */
export function configPath(root: string = ROOT): string {
  if (process.env.SHIPGATE_CONFIG) return process.env.SHIPGATE_CONFIG;
  const local = resolve(root, "shipgate.local.yaml");
  return existsSync(local) ? local : resolve(root, "shipgate.yaml");
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function relative(v: string): boolean {
  return !v.startsWith("/") && !v.split("/").includes("..") && !/^[A-Za-z]:/.test(v);
}

export function loadConfig(path: string = configPath()): Config {
  const file = basename(path);
  const err = (key: string, problem: string) => new ConfigError(`${file}: ${key}: ${problem}`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw err("(file)", `cannot read ${path} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    throw err("(file)", "invalid YAML");
  }
  if (!isMapping(data)) throw err("(root)", "must be a mapping");
  for (const key of Object.keys(data)) if (!(key in SCHEMA)) throw err(key, "unknown key");
  const v: Record<string, string> = {};
  for (const [section, keys] of Object.entries(SCHEMA)) {
    const block = data[section];
    if (!isMapping(block)) throw err(section, "missing or not a mapping");
    for (const key of Object.keys(block)) if (!keys.includes(key)) throw err(`${section}.${key}`, "unknown key");
    for (const key of keys) {
      const value = block[key];
      if (typeof value !== "string" || value.trim() === "") throw err(`${section}.${key}`, "missing or empty");
      v[`${section}.${key}`] = value.trim();
    }
  }
  const get = (k: string): string => v[k] ?? "";
  if (!REPO_RE.test(get("target.repo"))) throw err("target.repo", "must be owner/name");
  if (get("target.description").length > MAX_DESCRIPTION) {
    throw err("target.description", `longer than ${MAX_DESCRIPTION} characters`);
  }
  for (const key of ["python.install", "python.test"]) {
    if (get(key).includes("`")) throw err(key, "must not contain a backtick");
  }
  for (const key of ["python.source_dir", "python.tests_dir"]) {
    if (!relative(get(key))) throw err(key, "must be a relative path without '..'");
    v[key] = get(key).replace(/\/+$/, "");
  }
  if (!URL_RE.test(get("trueforge.url"))) throw err("trueforge.url", "must be an http(s) URL");
  const repo = get("target.repo");
  const [owner, name] = repo.split("/", 2) as [string, string];
  return {
    repo,
    owner,
    name,
    defaultBranch: get("target.default_branch"),
    description: get("target.description"),
    install: get("python.install"),
    test: get("python.test"),
    sourceDir: get("python.source_dir"),
    testsDir: get("python.tests_dir"),
    trueforgeUrl: get("trueforge.url"),
    model: get("trueforge.model"),
  };
}
