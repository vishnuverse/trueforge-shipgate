/**
 * Register the model provider, connectors and doctor-check TrueForge for Ticket Resolver (spec any-repo §4).
 * With a jira: section in shipgate.yaml it also registers the `jira` connector (JIRA_EMAIL + JIRA_API_KEY) and
 * checks the ticket-resolver-jira agent.
 *   npx --yes tsx scripts/setup_trueforge.ts [--rotate-keys] [--allow-remote]   # register (keys from .env)
 *   npx --yes tsx scripts/setup_trueforge.ts --check                            # doctor only
 * Exit 0 ok, 1 a step failed, 2 usage/config error. Never prints key values.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, type JiraConfig, ROOT, loadConfig } from "../orchestrator/src/config.ts";
import { SetupError, doctor, registerAll } from "../orchestrator/src/setup.ts";

async function main(argv: string[]): Promise<number> {
  const known = new Set(["--rotate-keys", "--allow-remote", "--check"]);
  const bad = argv.find((a) => !known.has(a));
  if (bad !== undefined) {
    console.error(`setup_trueforge: unknown argument '${bad}'`);
    return 2;
  }
  const envFile = process.env.SHIPGATE_ENV_FILE ?? join(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  let base: string;
  let model: string;
  let jira: JiraConfig | null;
  try {
    const cfg = loadConfig();
    base = (process.env.TRUEFORGE_URL ?? cfg.trueforgeUrl).replace(/\/+$/, "");
    model = cfg.model;
    jira = cfg.jira; // null: GitHub only, no jira connector and no Jira agent checks
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`setup_trueforge: ${err.message}`);
      return 2;
    }
    throw err;
  }
  try {
    if (argv.includes("--check")) {
      const checks = await doctor(base, fetch, model, jira);
      for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    await registerAll(
      base,
      {
        openrouterKey: process.env.OPENROUTER_API_KEY,
        openaiKey: process.env.OPENAI_API_KEY,
        githubPat: process.env.GITHUB_PAT,
        jiraEmail: process.env.JIRA_EMAIL,
        jiraToken: process.env.JIRA_API_KEY,
      },
      { rotateKeys: argv.includes("--rotate-keys"), allowRemote: argv.includes("--allow-remote") },
      fetch,
      console.log,
      model,
      jira,
    );
    return 0;
  } catch (err) {
    if (err instanceof SetupError) {
      console.error(`✗ ${err.message}`);
      return 1;
    }
    throw err;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
