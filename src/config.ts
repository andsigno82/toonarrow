import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Upstream name -> base URL. The name is the first path segment on the proxy. */
export type Upstreams = Record<string, string>;

/** 'meta': redacted headers + body shape. 'full': also request bodies (local debugging only). */
export type CaptureMode = 'off' | 'meta' | 'full';

export interface CompressConfig {
  /** Rule-based compression of shell tool results. */
  bash: boolean;
  /** Skill listings: skills outside keepSkills are listed by id only, without description. */
  skills: boolean;
  /** Skills that keep their description; written by `toonarrow skills --write` from the usage history. */
  keepSkills: string[];
}

export interface Config {
  host: string;
  port: number;
  upstreams: Upstreams;
  /** Writes request captures to ~/.toonarrow/capture for protocol discovery. */
  capture: CaptureMode;
  compress: CompressConfig;
}

export const HOME_DIR = process.env.TOONARROW_HOME ?? join(homedir(), '.toonarrow');
export const CONFIG_PATH = join(HOME_DIR, 'config.json');
export const LEDGER_DIR = join(HOME_DIR, 'usage');
export const CAPTURE_DIR = join(HOME_DIR, 'capture');
export const LOG_DIR = join(HOME_DIR, 'logs');
export const RUNTIME_PATH = join(HOME_DIR, 'runtime.json');

export const DEFAULT_CONFIG: Config = {
  host: '127.0.0.1',
  port: 48700,
  capture: 'off',
  compress: { bash: true, skills: false, keepSkills: [] },
  upstreams: {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
    chatgpt: 'https://chatgpt.com/backend-api/codex',
    // OpenCode providers (base URLs from the models.dev catalog).
    'zai-coding-plan': 'https://api.z.ai/api/coding/paas/v4',
    minimax: 'https://api.minimax.io/anthropic/v1',
    'opencode-go': 'https://opencode.ai/zen/go/v1',
    opencode: 'https://opencode.ai/zen/v1',
  },
};

export function loadConfig(path: string = CONFIG_PATH): Config {
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  return {
    host: raw.host ?? DEFAULT_CONFIG.host,
    port: raw.port ?? DEFAULT_CONFIG.port,
    capture: raw.capture ?? DEFAULT_CONFIG.capture,
    compress: { ...DEFAULT_CONFIG.compress, ...raw.compress },
    upstreams: { ...DEFAULT_CONFIG.upstreams, ...raw.upstreams },
  };
}

/** Writes the default config if none exists. Returns true when a file was created. */
/** Merges `values` into the `compress` section of the config file, leaving every other key as written. */
export function setCompressConfig(values: Partial<CompressConfig>, path: string = CONFIG_PATH): void {
  const raw = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>) : {};
  raw.compress = { ...raw.compress, ...values } as CompressConfig;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
}

export function initConfig(path: string = CONFIG_PATH): boolean {
  if (existsSync(path)) return false;
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  return true;
}
