import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_DIR, loadConfig } from './config.ts';
import { BRIEF_GUIDANCE, fileToolGuidance } from './guidance.ts';
import { currentPlatform } from './platform/index.ts';

// Sibling of this module: cli.ts when run from source, cli.js in the npm build.
const CLI_PATH = fileURLToPath(new URL(`./cli${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
const NODE_ARGS = ['--disable-warning=ExperimentalWarning', CLI_PATH];

/** Native file tools replaced by mcp__toonarrow__Search / mcp__toonarrow__Edit while the gate is on. */
export const GATED_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const TOOLGATE_ENV = 'TOONARROW_TOOLGATE';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/** Claude Code PreToolUse hook: denies native file tools when the session was started by `toonarrow claude`. */
export async function preToolUseHook(input: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env[TOOLGATE_ENV] !== '1') return '';
  let tool = '';
  try {
    tool = JSON.parse(input).tool_name ?? '';
  } catch {
    return '';
  }
  if (!GATED_TOOLS.includes(tool)) return '';
  const replacement = READ_TOOLS.has(tool) ? 'mcp__toonarrow__Search' : 'mcp__toonarrow__Edit';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `toonarrow: ${tool} is disabled in this session, use ${replacement} instead (Bash stays available for running commands).`,
    },
  });
}

/** Client shims written by `toonarrow install`; the directory goes first in PATH (Fermat-style `claude` shim). */
export const SHIM_DIR = join(HOME_DIR, 'bin');
export const SHIM_CLIENTS = ['claude', 'codex', 'opencode', 'kora'] as const;
/** Set to the client name once a shim ran, so a shim reached again in the same chain (cmux, Fermat) passes through. */
export const SHIM_GUARD = 'TOONARROW_SHIM_ACTIVE';
/** Second line of every shim script (platform/posix.ts): how a shim is recognised wherever it is installed. */
export const SHIM_MARKER = '# toonarrow shim';

const realpathOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The real client binary: the first `name` in PATH after the shim directory, so a toonarrow shim never resolves to
 * itself (other wrappers placed before it, like cmux's, have already run by then).
 */
export function resolveClientBin(name: string, env: NodeJS.ProcessEnv = process.env, shimDir: string = SHIM_DIR): string {
  const shim = realpathOr(shimDir);
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const at = dirs.findIndex((d) => realpathOr(d) === shim);
  let candidates = (at >= 0 ? dirs.slice(at + 1) : dirs).filter((d) => realpathOr(d) !== shim);
  for (;;) {
    const found = currentPlatform().resolveExecutable(name, candidates);
    if (!found) throw new Error(`${name} not found in PATH`);
    if (!isShim(found)) return found;
    // A toonarrow shim outside shimDir (written under another TOONARROW_HOME): running it would start this shim
    // again, without end. Its directory is skipped.
    const dir = realpathOr(dirname(found));
    const rest = candidates.filter((d) => realpathOr(d) !== dir);
    if (rest.length === candidates.length) throw new Error(`${name} resolves to the toonarrow shim ${found}`);
    candidates = rest;
  }
}

/** True when `path` starts like a script written by shimScript (the first bytes only: clients are large binaries). */
function isShim(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(256);
    return head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString('latin1').includes(SHIM_MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * PATH without the shim directory. Every client a shim starts gets it, so neither the client nor a wrapper
 * between the shim and the client (cmux re-runs `claude` after dropping its own directory) can re-enter the shim.
 */
export function pathWithoutShims(path: string = process.env.PATH ?? '', shimDir: string = SHIM_DIR): string {
  const shim = realpathOr(shimDir);
  return path
    .split(delimiter)
    .filter((d) => d && realpathOr(d) !== shim)
    .join(delimiter);
}

/**
 * `env` with PATH replaced, under the PATH key the source already uses: Windows keeps `Path`, and a second key
 * would leave the child process with the old value.
 */
export function envWithPath(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
  const key = keys.includes('PATH') ? 'PATH' : (keys[0] ?? 'PATH');
  return { ...env, [key]: path };
}

/** Shell rc text with the toonarrow PATH block, see platform/posix.ts. */
export const withShimPathBlock = (text: string, add: boolean, shimDir: string = SHIM_DIR): string =>
  currentPlatform().withShimPathBlock(text, add, shimDir);

export const shimScript = (client: string): string => currentPlatform().shimScript(client, { execPath: process.execPath, cliPath: CLI_PATH });

/**
 * Entry point of the shims: the user types `kora` (or claude, codex, opencode) and toonarrow attaches when it runs,
 * like Fermat's `claude` shim. With toonarrow off the client runs exactly as without toonarrow (Fermat's vanilla mode).
 */
export async function launchShim(client: string, argv: string[]): Promise<number> {
  const passthrough = (): Promise<number> => run(resolveClientBin(client), argv, envWithPath(process.env, pathWithoutShims()));
  if (process.env[SHIM_GUARD] === client) return passthrough();
  process.env[SHIM_GUARD] = client;
  const config = loadConfig();
  const features = await proxyFeatures(`http://${config.host}:${config.port}`);
  if (!features || (client === 'kora' && !features.includes('via'))) return passthrough();
  switch (client) {
    case 'claude':
      return launchClaude(argv);
    case 'codex':
      return launchCodex(argv);
    case 'opencode':
      return launchOpencode(argv);
    case 'kora':
      return launchKora(argv);
    default:
      throw new Error(`no toonarrow shim for ${client}`);
  }
}

async function proxyUp(base: string): Promise<boolean> {
  return (await proxyFeatures(base)) !== undefined;
}

/** Features announced by a running toonarrow (`/_toonarrow/health`), or undefined when none answers. */
async function proxyFeatures(base: string): Promise<string[] | undefined> {
  try {
    const res = await fetch(`${base}/_toonarrow/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { features?: unknown };
    return Array.isArray(body.features) ? body.features.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return undefined;
  }
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** Environment without another proxy's wrapper variables (e.g. Fermat), so sessions do not mix. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = envWithPath(process.env, pathWithoutShims());
  for (const k of Object.keys(env)) if (/^(FERMAT|FERMATSLASTTOKEN|FILETOFISH|QUOTIENT)_/.test(k) || k === 'ANTHROPIC_CUSTOM_HEADERS') delete env[k];
  return env;
}

/** Launcher flags consumed by toonarrow; everything else goes to the client untouched. */
export function splitLauncherFlags(argv: string[]): { tools: boolean; brief: boolean; args: string[] } {
  return {
    tools: argv.includes('--toonarrow-tools'),
    brief: !argv.includes('--toonarrow-no-brief'),
    args: argv.filter((a) => a !== '--toonarrow-tools' && a !== '--toonarrow-no-brief'),
  };
}

export async function launchClaude(argv: string[]): Promise<number> {
  const { brief, args } = splitLauncherFlags(argv);
  const config = loadConfig();
  const base = `http://${config.host}:${config.port}`;
  mkdirSync(HOME_DIR, { recursive: true });
  const mcpPath = join(HOME_DIR, 'claude-mcp.json');
  const settingsPath = join(HOME_DIR, 'claude-settings.json');
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: { toonarrow: { command: process.execPath, args: [...NODE_ARGS, 'mcp'] } } }, null, 2));
  const hookCommand = [process.execPath, ...NODE_ARGS, 'hook', 'pretooluse'].map((a) => `'${a}'`).join(' ');
  writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: GATED_TOOLS.join('|'), hooks: [{ type: 'command', command: hookCommand }] }] } }, null, 2));

  const env = cleanEnv();
  env[TOOLGATE_ENV] = '1';
  if (await proxyUp(base)) env.ANTHROPIC_BASE_URL = `${base}/anthropic`;
  else {
    delete env.ANTHROPIC_BASE_URL;
    console.error(`toonarrow: proxy not running on ${base} (start it with "toonarrow serve" or "toonarrow install"); continuing with tools only`);
  }
  const extra = ['--mcp-config', mcpPath, '--settings', settingsPath];
  if (brief) {
    const briefPath = join(HOME_DIR, 'claude-instructions.md');
    writeFileSync(briefPath, BRIEF_GUIDANCE + '\n');
    extra.push('--append-system-prompt-file', briefPath);
  }
  return run(env.TOONARROW_CLAUDE_BIN ?? resolveClientBin('claude'), [...extra, ...args], env);
}

/** OpenCode provider id -> toonarrow upstream name, and the path suffix its SDK expects in baseURL. */
const OPENCODE_PROVIDERS: Record<string, string> = {
  'zai-coding-plan': 'zai-coding-plan',
  'minimax-coding-plan': 'minimax',
  minimax: 'minimax',
  'opencode-go': 'opencode-go',
  opencode: 'opencode',
  anthropic: 'anthropic/v1',
};

/** OpenCode built-in tools replaced by toonarrow_Search / toonarrow_Edit. */
export const OPENCODE_GATED_TOOLS = ['read', 'grep', 'glob', 'edit', 'write', 'apply_patch'];

/**
 * How the user is signed in to OpenAI in OpenCode: 'oauth' (ChatGPT plan, served by the Codex backend)
 * or 'api' (API key). Only the `type` field of OpenCode's auth store is read.
 */
export function opencodeOpenaiAuth(env: NodeJS.ProcessEnv = process.env): 'oauth' | 'api' | undefined {
  const dataDir = env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, 'opencode') : join(homedir(), '.local', 'share', 'opencode');
  try {
    const type = JSON.parse(readFileSync(join(dataDir, 'auth.json'), 'utf8'))?.openai?.type;
    return type === 'oauth' || type === 'api' ? type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Proxy routing always; toonarrow instructions when given; with `tools`, the toonarrow file tools replace the native ones.
 * Shell deny rules were tried and dropped: OpenCode only answers "Permission denied: shell" and GLM
 * then probed Code Mode and spawned subagents instead of switching to toonarrow_Search.
 */
export function opencodeConfig(base: string | undefined, instructionsPath: string | undefined, tools: boolean, openaiAuth?: 'oauth' | 'api'): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  // Merged with the user's own instructions (verified: arrays from config sources are concatenated).
  if (instructionsPath) config.instructions = [instructionsPath];
  if (tools) {
    // OpenCode 2.x schema; codemode: false exposes toonarrow_Search/toonarrow_Edit as direct tools
    // instead of hiding them behind the `execute` Code Mode runtime.
    config.mcp = { servers: { toonarrow: { type: 'local', command: [process.execPath, ...NODE_ARGS, 'mcp'], codemode: false } } };
    config.tools = Object.fromEntries(OPENCODE_GATED_TOOLS.map((t) => [t, false]));
  }
  if (base) {
    const providers = { ...OPENCODE_PROVIDERS };
    // OAuth requests go to the ChatGPT Codex backend; with an API key, to api.openai.com.
    if (openaiAuth) providers.openai = openaiAuth === 'oauth' ? 'chatgpt' : 'openai/v1';
    config.provider = Object.fromEntries(Object.entries(providers).map(([id, upstream]) => [id, { options: { baseURL: `${base}/${upstream}` } }]));
  }
  return config;
}

/**
 * OpenCode 2.x routes requests through a shared background service that never sees this
 * process's environment, so the session runs on a private server (--standalone) that does.
 */
export async function launchOpencode(argv: string[]): Promise<number> {
  const { tools, brief, args } = splitLauncherFlags(argv);
  const config = loadConfig();
  const base = `http://${config.host}:${config.port}`;
  const env = cleanEnv();
  const up = await proxyUp(base);
  if (!up) console.error(`toonarrow: proxy not running on ${base} (start it with "toonarrow serve" or "toonarrow install"); continuing with tools only`);
  mkdirSync(HOME_DIR, { recursive: true });
  const note = 'They are direct tools in your tool list: call toonarrow_Search and toonarrow_Edit directly, never through execute or Code Mode.';
  const sections = [...(brief ? [BRIEF_GUIDANCE] : []), ...(tools ? [fileToolGuidance('toonarrow_Search', 'toonarrow_Edit', note)] : [])];
  let instructionsPath: string | undefined;
  if (sections.length) {
    instructionsPath = join(HOME_DIR, 'opencode-instructions.md');
    writeFileSync(instructionsPath, sections.join('\n\n') + '\n');
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(opencodeConfig(up ? base : undefined, instructionsPath, tools, opencodeOpenaiAuth()));
  return run(env.TOONARROW_OPENCODE_BIN ?? resolveClientBin('opencode'), ['--standalone', ...args], env);
}

/**
 * Kora CLI: KORA_LLM_PROXY makes Kora send every remote provider request to <proxy>/_via/<scheme>/<host>/<path>,
 * so toonarrow needs no list of Kora's providers (kora, builtins, custom_*, OpenAI OAuth). Loopback endpoints stay direct.
 * Like ANTHROPIC_BASE_URL for Claude Code, Kora only honors the variable: it is set only when a toonarrow serving
 * /_via/ answers, and mid-session availability is the daemon's job (`toonarrow install`).
 */
export async function launchKora(argv: string[]): Promise<number> {
  const { args } = splitLauncherFlags(argv);
  const config = loadConfig();
  const base = `http://${config.host}:${config.port}`;
  const env = cleanEnv();
  const features = await proxyFeatures(base);
  if (features?.includes('via')) env.KORA_LLM_PROXY = base;
  else {
    delete env.KORA_LLM_PROXY;
    const why = features ? 'is an older build without the /_via/ route (restart it)' : 'is not running (start it with "toonarrow serve" or "toonarrow install")';
    console.error(`toonarrow: proxy on ${base} ${why}; running Kora directly`);
  }
  return run(env.TOONARROW_KORA_BIN ?? resolveClientBin('kora'), args, env);
}

interface CodexSessionMeta {
  model_provider?: unknown;
  cwd?: unknown;
  source?: unknown;
}

/** The `session_meta` payload on the first line of a Codex rollout (about 22 KB, base instructions included). */
function codexSessionMeta(file: string): CodexSessionMeta | undefined {
  try {
    const fd = openSync(file, 'r');
    try {
      const head = Buffer.alloc(256 * 1024);
      const line = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString('utf8').split('\n', 1)[0]!;
      const payload = JSON.parse(line)?.payload;
      return payload && typeof payload === 'object' ? payload : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

const realpath = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// Sessions the resume picker and --last offer by default; `exec` runs and subagent threads need flags or are hidden.
const INTERACTIVE_SOURCES = new Set(['cli', 'vscode']);

/** Codex's state directory: `$CODEX_HOME`, else ~/.codex. */
const codexHome = (env: NodeJS.ProcessEnv): string => env.CODEX_HOME ?? join(homedir(), '.codex');

/**
 * `model_provider` recorded for the session `codex resume`/`fork` reopens, or undefined when the target cannot be
 * identified (no resume, interactive picker, session name, archived or missing rollout). Only toonarrow 0.1.x
 * sessions, recorded under the custom `toonarrow` provider, need it: Codex refuses a resume whose recorded provider
 * differs from the current one (modelProviderMismatch). `--last` follows Codex's filters: the newest session of the
 * working directory (`-C`/`--cd`, any directory with `--all`), interactive only unless `--include-non-interactive`.
 */
export function codexResumeProvider(args: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | undefined {
  const at = args.findIndex((a) => a === 'resume' || a === 'fork');
  if (at < 0) return undefined;
  const rest = args.slice(at + 1);
  const sessions = join(codexHome(env), 'sessions');
  let rollouts: string[];
  try {
    rollouts = (readdirSync(sessions, { recursive: true }) as string[]).filter((f) => /^rollout-.*\.jsonl$/.test(basename(f))).map((f) => join(sessions, f));
  } catch {
    return undefined;
  }
  const provider = (meta: CodexSessionMeta | undefined): string | undefined => (typeof meta?.model_provider === 'string' ? meta.model_provider : undefined);
  const id = rest.find((a) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a));
  if (id) {
    const file = rollouts.find((f) => f.endsWith(`-${id.toLowerCase()}.jsonl`));
    return file ? provider(codexSessionMeta(file)) : undefined;
  }
  if (!rest.includes('--last')) return undefined;
  const cdAt = args.findIndex((a) => a === '-C' || a === '--cd');
  const cd = cdAt >= 0 ? args[cdAt + 1] : args.find((a) => a.startsWith('--cd='))?.slice(5);
  const dir = rest.includes('--all') ? undefined : realpath(resolve(cwd, cd ?? '.'));
  const interactiveOnly = !rest.includes('--include-non-interactive');
  const recent = rollouts
    .map((f) => {
      try {
        return { f, t: statSync(f).mtimeMs };
      } catch {
        return { f, t: 0 };
      }
    })
    .sort((a, b) => b.t - a.t);
  for (const { f } of recent) {
    const meta = codexSessionMeta(f);
    if (!meta) continue;
    if (dir !== undefined && (typeof meta.cwd !== 'string' || realpath(meta.cwd) !== dir)) continue;
    if (interactiveOnly && !(typeof meta.source === 'string' && INTERACTIVE_SOURCES.has(meta.source))) continue;
    return provider(meta);
  }
  return undefined;
}

/**
 * True when Codex is signed in with an API key: `auth_mode` "apikey" in `$CODEX_HOME/auth.json`, the value Codex
 * writes for `codex login --with-api-key`. Only that field is read. A ChatGPT sign-in, or credentials kept in the OS
 * keyring (no auth.json), gives false.
 */
export function codexApiKeyAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return JSON.parse(readFileSync(join(codexHome(env), 'auth.json'), 'utf8'))?.auth_mode === 'apikey';
  } catch {
    return false;
  }
}

/**
 * How Codex reaches the model through toonarrow: the built-in `openai` provider pointed at the proxy with
 * `openai_base_url`, Codex's documented seam for an LLM proxy. Sessions stay recorded as `openai`, so plain codex and
 * the IDE extension resume them and the other way round, and Codex keeps its WebSocket transport (relayed by the
 * proxy). Sessions recorded by toonarrow 0.1.x under the custom `toonarrow` provider resume with that provider:
 * through the proxy, or straight to the ChatGPT backend when it is down, so they still open, uncompressed.
 */
export function codexProviderOverrides(resumed: string | undefined, up: boolean, base: string, apiKey = false): string[] {
  if (resumed === 'toonarrow') {
    const url = up ? `${base}/chatgpt` : 'https://chatgpt.com/backend-api/codex';
    return ['-c', 'model_provider=toonarrow', '-c', `model_providers.toonarrow={name="toonarrow",base_url=${JSON.stringify(url)},wire_api="responses",requires_openai_auth=true}`];
  }
  // openai_base_url replaces the ChatGPT backend or the API base, whichever the sign-in uses.
  return up ? ['-c', `openai_base_url=${JSON.stringify(`${base}/${apiKey ? 'openai/v1' : 'chatgpt'}`)}`] : [];
}

export async function launchCodex(argv: string[]): Promise<number> {
  const { brief, args } = splitLauncherFlags(argv);
  const config = loadConfig();
  const base = `http://${config.host}:${config.port}`;
  const env = cleanEnv();
  const toml = (s: string): string => JSON.stringify(s);
  const extra = ['-c', `mcp_servers.toonarrow={command=${toml(process.execPath)},args=[${[...NODE_ARGS, 'mcp'].map(toml).join(',')}]}`];
  // Appended to Codex's base instructions; as a -c override it takes the place of a developer_instructions in config.toml.
  if (brief) extra.push('-c', `developer_instructions=${toml(BRIEF_GUIDANCE)}`);
  const resumed = codexResumeProvider(args, env);
  const up = await proxyUp(base);
  if (!up && resumed === 'toonarrow') console.error(`toonarrow: proxy not running on ${base}; resuming against the ChatGPT backend directly, uncompressed`);
  else if (!up) console.error(`toonarrow: proxy not running on ${base} (start it with "toonarrow serve" or "toonarrow install"); continuing with tools only`);
  extra.push(...codexProviderOverrides(resumed, up, base, codexApiKeyAuth(env)));
  return run(env.TOONARROW_CODEX_BIN ?? resolveClientBin('codex'), [...extra, ...args], env);
}
