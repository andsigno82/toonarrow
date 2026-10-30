import type { Wire } from '../wire.ts';

type Json = Record<string, any>;

export interface SkillStats {
  /** Skills listed by id only in this request. */
  skillsHidden: number;
  skillsCharsSaved: number;
}

/** OpenCode skill listing: `<available_skills>` with one `<skill><id/><name/><description/></skill>` per skill. */
const LISTING = /<available_skills>\n([\s\S]*?)<\/available_skills>/;
const ENTRY = /[ \t]*<skill>\n?[\s\S]*?<\/skill>\n?/g;
const tag = (entry: string, name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(entry)?.[1]?.trim();

/** Kora CLI skill listing: "## Available Skills", one intro line, then `- **name**: description` lines. */
const KORA_LISTING = /## Available Skills\n[^\n]*\n\n((?:- \*\*[^\n]+?\*\*:[^\n]*(?:\n|$))+)/;
const KORA_ENTRY = /^- \*\*(.+?)\*\*:/;

/**
 * Keeps the full entry of the skills in `keep` (matched by id or name) and lists every other skill
 * by id only, in the OpenCode and Kora CLI formats. A pure function of (text, keep): the rewritten
 * system prompt stays cache-stable.
 */
export function compactSkillListing(text: string, keep: ReadonlySet<string>): { text: string; hidden: number } {
  const opencode = compactOpencodeListing(text, keep);
  const kora = compactKoraListing(opencode.text, keep);
  return { text: kora.text, hidden: opencode.hidden + kora.hidden };
}

function compactKoraListing(text: string, keep: ReadonlySet<string>): { text: string; hidden: number } {
  const m = KORA_LISTING.exec(text);
  if (!m) return { text, hidden: 0 };
  const block = m[1]!;
  const kept: string[] = [];
  const names: string[] = [];
  for (const line of block.split('\n').filter(Boolean)) {
    const name = KORA_ENTRY.exec(line)![1]!;
    if (keep.has(name)) kept.push(line);
    else names.push(name);
  }
  if (!names.length) return { text, hidden: 0 };
  kept.push(`- Other skills, descriptions omitted (load one by name with the \`skill\` tool when its name fits the task): ${names.join(', ')}`);
  const start = m.index + m[0].length - block.length;
  const listing = kept.join('\n') + (block.endsWith('\n') ? '\n' : '');
  return { text: text.slice(0, start) + listing + text.slice(start + block.length), hidden: names.length };
}

function compactOpencodeListing(text: string, keep: ReadonlySet<string>): { text: string; hidden: number } {
  const m = LISTING.exec(text);
  if (!m) return { text, hidden: 0 };
  const kept: string[] = [];
  const ids: string[] = [];
  for (const entry of m[1]!.match(ENTRY) ?? []) {
    const name = tag(entry, 'name');
    const id = tag(entry, 'id') ?? name;
    if (!id || keep.has(id) || (name !== undefined && keep.has(name))) kept.push(entry);
    else ids.push(id);
  }
  if (!ids.length) return { text, hidden: 0 };
  const more = `  <more_skills note="descriptions omitted; load one by id with the skill tool when its name fits the task">${ids.join(', ')}</more_skills>\n`;
  const listing = `<available_skills>\n${kept.join('')}${more}</available_skills>`;
  return { text: text.slice(0, m.index) + listing + text.slice(m.index + m[0].length), hidden: ids.length };
}

/** System-level texts of a request, as [holder, key] pairs so they can be replaced in place. */
function systemSlots(body: Json, wire: Wire): Array<[Json, string | number]> {
  const slots: Array<[Json, string | number]> = [];
  const addContent = (holder: Json, key: string | number, partTypes: string[]): void => {
    const value = holder[key];
    if (typeof value === 'string') slots.push([holder, key]);
    else if (Array.isArray(value)) {
      for (const part of value) if (partTypes.includes(part?.type) && typeof part.text === 'string') slots.push([part, 'text']);
    }
  };
  if (wire === 'anthropic-messages') addContent(body, 'system', ['text']);
  else if (wire === 'openai-chat' && Array.isArray(body.messages)) {
    for (const msg of body.messages) if (msg?.role === 'system' || msg?.role === 'developer') addContent(msg, 'content', ['text']);
  } else if (wire === 'openai-responses') {
    if (typeof body.instructions === 'string') slots.push([body, 'instructions']);
    if (Array.isArray(body.input)) {
      for (const item of body.input) if (item?.role === 'system' || item?.role === 'developer') addContent(item, 'content', ['input_text', 'text']);
    }
  }
  return slots;
}

/** Compacts the skill listing in the system texts of a request body, in place. */
export function rewriteSkills(body: Json, wire: Wire, keep: ReadonlySet<string>): SkillStats {
  const stats: SkillStats = { skillsHidden: 0, skillsCharsSaved: 0 };
  for (const [holder, key] of systemSlots(body, wire)) {
    const before = holder[key] as string;
    const r = compactSkillListing(before, keep);
    if (!r.hidden) continue;
    holder[key] = r.text;
    stats.skillsHidden += r.hidden;
    stats.skillsCharsSaved += before.length - r.text.length;
  }
  return stats;
}
