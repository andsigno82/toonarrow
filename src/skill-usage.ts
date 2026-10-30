import { existsSync } from 'node:fs';
import { glob, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type UsageSource = 'opencode' | 'claude' | 'kora';

/** Skill id -> invocations per client. */
export type SkillUsage = Map<string, Record<UsageSource, number>>;

function add(usage: SkillUsage, id: unknown, source: UsageSource): void {
  if (typeof id !== 'string' || !id) return;
  const row = usage.get(id) ?? { opencode: 0, claude: 0, kora: 0 };
  row[source]++;
  usage.set(id, row);
}

export const opencodeDbPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'opencode.db');

/** Skill tool calls stored by OpenCode: input `id` in 2.x, `name` before. Read-only. */
export async function readOpencodeUsage(dbPath: string, usage: SkillUsage): Promise<void> {
  if (!existsSync(dbPath)) return;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(`select json_extract(data, '$.state.input') as input from part where json_extract(data, '$.type') = 'tool' and json_extract(data, '$.tool') = 'skill'`)
      .all() as Array<{ input: string | null }>;
    for (const { input } of rows) {
      try {
        const args = JSON.parse(input ?? 'null');
        add(usage, args?.id ?? args?.name, 'opencode');
      } catch {
        // malformed tool input
      }
    }
  } finally {
    db.close();
  }
}

/** Skill tool calls in Claude Code transcripts (every .jsonl under projectsDir, tool_use `Skill` with input `skill`). */
export async function readClaudeUsage(projectsDir: string, usage: SkillUsage): Promise<void> {
  if (!existsSync(projectsDir)) return;
  for await (const file of glob('**/*.jsonl', { cwd: projectsDir })) {
    // Dangling symlinks and transcripts removed mid-scan are skipped.
    const text = await readFile(join(projectsDir, file), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.includes('"name":"Skill"')) continue;
      try {
        const content = JSON.parse(line)?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) if (part?.type === 'tool_use' && part.name === 'Skill') add(usage, part.input?.skill, 'claude');
      } catch {
        // partial line
      }
    }
  }
}

/** Kora profile root as the Kora CLI resolves it, without the ~/.kora-dev fallback. */
export const koraProfileRoot = (env: NodeJS.ProcessEnv = process.env): string => env.KORA_PROFILE ?? env.KORA_PROFILE_ROOT ?? join(homedir(), '.kora');

/** Skill tool calls in Kora session documents (`sessions/*.json`, parts `{type: 'tool-call', toolName: 'skill', args: {name}}`). */
export async function readKoraUsage(profileRoot: string, usage: SkillUsage): Promise<void> {
  const dir = join(profileRoot, 'sessions');
  if (!existsSync(dir)) return;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, any>;
    if (o.type === 'tool-call' && o.toolName === 'skill') add(usage, o.args?.name, 'kora');
    else for (const v of Object.values(o)) visit(v);
  };
  for await (const file of glob('*.json', { cwd: dir })) {
    const text = await readFile(join(dir, file), 'utf8').catch(() => '');
    // Cheap filter before parsing whole session documents.
    if (!text.includes('"toolName":"skill"')) continue;
    try {
      visit(JSON.parse(text));
    } catch {
      // partially written session
    }
  }
}

export async function readSkillUsage(env: NodeJS.ProcessEnv = process.env): Promise<SkillUsage> {
  const usage: SkillUsage = new Map();
  await readOpencodeUsage(opencodeDbPath(env), usage);
  await readClaudeUsage(join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'), usage);
  await readKoraUsage(koraProfileRoot(env), usage);
  return usage;
}
