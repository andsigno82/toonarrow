#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_DIR, CONFIG_PATH, LEDGER_DIR, LOG_DIR, RUNTIME_PATH, SESSIONS_DIR, initConfig, loadConfig, setCompressConfig } from './config.ts';
import type { Config } from './config.ts';
import { Ledger, dayStamp } from './ledger.ts';
import { clientLabel, grouped, isInference } from './report.ts';
import type { LedgerEntry } from './ledger.ts';
import { SHIM_CLIENTS, SHIM_DIR, launchClaude, launchCodex, launchKora, launchOpencode, launchShim, preToolUseHook } from './launch.ts';
import { currentPlatform } from './platform/index.ts';
import { VERSION, createProxyServer } from './proxy.ts';
import { SessionMemoStore } from './session-memo.ts';

const CLI_PATH = fileURLToPath(import.meta.url);

const baseUrl = (c: Config): string => `http://${c.host}:${c.port}`;

function serve(): void {
  const config = loadConfig();
  const server = createProxyServer({
    config,
    ledger: new Ledger(LEDGER_DIR),
    captureDir: CAPTURE_DIR,
    memo: new SessionMemoStore(SESSIONS_DIR),
    log: (m) => console.error(`[toonarrow] ${m}`),
  });
  server.listen(config.port, config.host, () => {
    writeFileSync(RUNTIME_PATH, JSON.stringify({ host: config.host, port: config.port, pid: process.pid, version: VERSION, startedAt: new Date().toISOString() }) + '\n');
    console.error(`[toonarrow] ${VERSION} listening on ${baseUrl(config)} (capture: ${config.capture})`);
  });
  const stop = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function status(): Promise<void> {
  const config = loadConfig();
  try {
    const res = await fetch(`${baseUrl(config)}/_toonarrow/health`, { signal: AbortSignal.timeout(2000) });
    console.log(`running: ${baseUrl(config)} ${JSON.stringify(await res.json())}`);
  } catch {
    console.log(`not running on ${baseUrl(config)}`);
    process.exitCode = 1;
  }
}

type GroupBy = 'day' | 'model' | 'session' | 'upstream' | 'client';

const groupKey = (e: LedgerEntry, by: GroupBy): string =>
  by === 'day' ? dayStamp(new Date(e.ts)) : by === 'model' ? (e.model ?? '?') : by === 'session' ? (e.sessionKey ?? '?') : by === 'upstream' ? e.upstream : clientLabel(e.client);

async function stats(args: string[]): Promise<void> {
  const days = Number(flag(args, '--days') ?? 1);
  const by = (flag(args, '--by') ?? 'model') as GroupBy;
  const entries = await new Ledger(LEDGER_DIR).read(days);
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const table = grouped(entries.filter(isInference), (e) => groupKey(e, by), by).map((r) => {
    const prompt = r.input + r.cacheRead + r.cacheWrite;
    return {
      [by]: r[by],
      requests: r.requests,
      errors: r.errors,
      input: fmt(r.input),
      cacheRead: fmt(r.cacheRead),
      cacheWrite: fmt(r.cacheWrite),
      output: fmt(r.output),
      cacheHit: prompt ? `${((100 * r.cacheRead) / prompt).toFixed(1)}%` : '-',
      saved: fmt(r.savedSkills + r.savedBash + r.savedTools),
    };
  });
  if (!table.length) console.log(`no requests in the last ${days} day(s)`);
  else console.table(table);
}

/** Ranks skills by recorded use; with --write, keeps the descriptions of those used at least --min times. */
async function skills(args: string[]): Promise<void> {
  const min = Number(flag(args, '--min') ?? 1);
  const { readSkillUsage } = await import('./skill-usage.ts');
  const rows = [...(await readSkillUsage())]
    .map(([skill, u]) => ({ skill, opencode: u.opencode, claude: u.claude, kora: u.kora, total: u.opencode + u.claude + u.kora }))
    .sort((a, b) => b.total - a.total || a.skill.localeCompare(b.skill));
  const keep = rows.filter((r) => r.total >= min).map((r) => r.skill).sort();
  if (rows.length) console.table(rows);
  console.log(`${keep.length} skill(s) used at least ${min} time(s) keep their description; every other skill is listed by id only`);
  if (!args.includes('--write')) return console.log('dry run: pass --write to save compress.keepSkills and enable compress.skills');
  setCompressConfig({ skills: true, keepSkills: keep });
  console.log(`saved to ${CONFIG_PATH}; restart the proxy to apply`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function install(): void {
  const platform = currentPlatform();
  const cmd = { execPath: process.execPath, cliPath: CLI_PATH };
  const wrapper = platform.wrapperPath();
  const rc = platform.shellRc();
  if (initConfig()) console.log(`config: created ${CONFIG_PATH}`);
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, platform.wrapperScript(cmd));
  chmodSync(wrapper, 0o755);
  console.log(`wrapper: ${wrapper}`);
  const service = platform.installService(cmd, LOG_DIR);
  console.log(`daemon: ${service.label} loaded (${service.path})`);
  mkdirSync(SHIM_DIR, { recursive: true });
  for (const client of SHIM_CLIENTS) {
    const path = join(SHIM_DIR, client);
    writeFileSync(path, platform.shimScript(client, cmd));
    chmodSync(path, 0o755);
  }
  writeFileSync(rc, platform.withShimPathBlock(existsSync(rc) ? readFileSync(rc, 'utf8') : '', true, SHIM_DIR));
  console.log(`shims: ${SHIM_CLIENTS.join(', ')} in ${SHIM_DIR}, first in PATH via ${rc} (open a new shell)`);
}

function uninstall(): void {
  const platform = currentPlatform();
  const wrapper = platform.wrapperPath();
  const rc = platform.shellRc();
  platform.removeService();
  rmSync(wrapper, { force: true });
  for (const client of SHIM_CLIENTS) rmSync(join(SHIM_DIR, client), { force: true });
  if (existsSync(rc)) writeFileSync(rc, platform.withShimPathBlock(readFileSync(rc, 'utf8'), false, SHIM_DIR));
  console.log(`removed daemon, wrapper, shims and the ${rc} block; data kept in ${dirname(CONFIG_PATH)}`);
}

// Static client config has no fallback: with toonarrow off that client stops working. The launchers check the proxy
// at start and run the client directly when it is down (Kora CLI included, like Claude Code).
const HARD_DEPENDENCY = '# WARNING: static config, the client fails while toonarrow is down. Prefer the launcher (toonarrow <client>), which runs it directly when the proxy is off.\n';

function env(client: string | undefined): void {
  const u = baseUrl(loadConfig());
  const snippets: Record<string, string> = {
    claude: `# shell, or "env" in ~/.claude/settings.json\nexport ANTHROPIC_BASE_URL=${u}/anthropic`,
    codex: `# ~/.codex/config.toml (user-level only)\nmodel_provider = "toonarrow"\n\n[model_providers.toonarrow]\nname = "toonarrow"\nbase_url = "${u}/chatgpt"     # ChatGPT login; use "${u}/openai/v1" + env_key = "OPENAI_API_KEY" for API keys\nwire_api = "responses"\nrequires_openai_auth = true`,
    opencode: `// opencode.json\n{\n  "provider": {\n    "anthropic": { "options": { "baseURL": "${u}/anthropic/v1" } },\n    "openai": { "options": { "baseURL": "${u}/openai/v1" } }\n  }\n}`,
    kora: `# Kora CLI: every remote provider goes through toonarrow (/_via/<scheme>/<host>/<path>)\nexport KORA_LLM_PROXY=${u}`,
  };
  for (const k of ['claude', 'codex', 'opencode', 'kora']) snippets[k] = HARD_DEPENDENCY + snippets[k];
  if (!client || !snippets[client]) {
    console.error(`usage: toonarrow env <${Object.keys(snippets).join('|')}>`);
    process.exitCode = 1;
    return;
  }
  console.log(snippets[client]);
}

const USAGE = `toonarrow ${VERSION}
usage:
  toonarrow serve                         run the proxy in the foreground
  toonarrow status                        health check of the running proxy
  toonarrow stats [--days N] [--by day|model|session|upstream|client]
  toonarrow dashboard                     open the local dashboard (served by the running proxy at /_toonarrow/)
  toonarrow install | uninstall           launchd daemon, ~/.local/bin/toonarrow wrapper, client shims (claude, codex, opencode, kora)
  toonarrow env <claude|codex|opencode|kora>
  toonarrow skills [--min N] [--write]    rank skills by use (OpenCode, Claude Code, Kora); --write keeps descriptions only for those
  toonarrow mcp                           MCP stdio server with the Search and Edit tools
  toonarrow claude [args]                 run Claude Code through toonarrow (proxy, MCP tools, native file tools gated)
  toonarrow codex [args]                  run Codex through toonarrow (proxy, MCP tools)
  toonarrow opencode [--toonarrow-tools] [args] run OpenCode through toonarrow (private server + proxy; --toonarrow-tools swaps native file tools for toonarrow_Search/toonarrow_Edit)
  toonarrow kora [args]                   run the Kora CLI through toonarrow (KORA_LLM_PROXY)
                                     claude/codex/opencode add a short-answers rule to the system prompt; --toonarrow-no-brief leaves it out
  toonarrow config                        print config path and effective config`;

async function main(argv: string[]): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error(`Node >= 24 required (running ${process.version})`);
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'serve':
      return serve();
    case 'status':
      return status();
    case 'stats':
      return stats(args);
    case 'dashboard': {
      const url = `${baseUrl(loadConfig())}/_toonarrow/`;
      console.log(url);
      currentPlatform().openUrl(url);
      return;
    }
    case 'install':
      return install();
    case 'uninstall':
      return uninstall();
    case 'env':
      return env(args[0]);
    case 'skills':
      return skills(args);
    case 'mcp':
      // Loaded lazily: the proxy daemon never needs the MCP SDK or tree-sitter.
      return (await import('./mcp/server.ts')).runMcpServer();
    case 'hook': {
      if (args[0] !== 'pretooluse') throw new Error(`unknown hook: ${args[0]}`);
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const out = await preToolUseHook(Buffer.concat(chunks).toString('utf8'));
      if (out) process.stdout.write(out);
      return;
    }
    case 'claude':
      process.exitCode = await launchClaude(args);
      return;
    case 'codex':
      process.exitCode = await launchCodex(args);
      return;
    case 'opencode':
      process.exitCode = await launchOpencode(args);
      return;
    case 'kora':
      process.exitCode = await launchKora(args);
      return;
    case 'shim':
      process.exitCode = await launchShim(args[0] ?? '', args.slice(1));
      return;
    case 'config':
      console.log(resolve(CONFIG_PATH));
      console.log(JSON.stringify(loadConfig(), null, 2));
      return;
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`toonarrow: ${err.message}`);
  process.exit(1);
});
