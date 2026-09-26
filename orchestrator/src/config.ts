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
// Optional sections: absent is fine; present means every key is required.
const OPTIONAL: Record<string, readonly string[]> = {
  jira: ["site", "cloud_id", "project", "status_start", "status_review", "status_open"],
};
const JIRA_SITE_RE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_RE = /^[A-Z][A-Z0-9]+$/;

export class ConfigError extends Error {}

export interface JiraConfig {
  site: string; // e.g. developertunnel.atlassian.net
  cloudId: string;
  project: string; // project key, e.g. KAN
  statusStart: string; // status names the orchestrator moves a ticket to
  statusReview: string;
  statusOpen: string;
}

/** The one naming rule for a Jira ticket (same as ticket_names() in scripts/shipgate_config.py). */
export function ticketNames(key: string, testsDir: string): { ref: string; slug: string; branch: string; testFile: string } {
  const slug = key.toLowerCase();
  return { ref: key, slug, branch: `fix/${slug}`, testFile: `${testsDir}/test_${slug.replaceAll("-", "_")}.py` };
}

export function jiraKeyRe(project: string): RegExp {
  return new RegExp(`^${project}-[1-9][0-9]*$`);
}

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
  jira: JiraConfig | null;
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
  for (const key of Object.keys(data)) if (!(key in SCHEMA) && !(key in OPTIONAL)) throw err(key, "unknown key");
  const v: Record<string, string> = {};
  for (const [section, keys] of Object.entries({ ...SCHEMA, ...OPTIONAL })) {
    const block = data[section];
    if (section in OPTIONAL && (block === undefined || block === null)) continue;
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
  let jira: JiraConfig | null = null;
  if ("jira.site" in v) {
    if (!JIRA_SITE_RE.test(get("jira.site"))) throw err("jira.site", "must be <name>.atlassian.net");
    if (!UUID_RE.test(get("jira.cloud_id"))) throw err("jira.cloud_id", "must be the site's cloudId (a UUID)");
    if (!PROJECT_RE.test(get("jira.project"))) throw err("jira.project", "must be a project key such as KAN");
    jira = {
      site: get("jira.site"),
      cloudId: get("jira.cloud_id"),
      project: get("jira.project"),
      statusStart: get("jira.status_start"),
      statusReview: get("jira.status_review"),
      statusOpen: get("jira.status_open"),
    };
  }
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
    jira,
  };
}
