import type { CompressConfig } from './config.ts';
import { rewriteAnthropic, rewriteChat, rewriteResponses, rewrote } from './compress/request.ts';
import type { ResponsesState, RewriteStats } from './compress/request.ts';
import { rewriteSkills } from './compress/skills.ts';
import type { SkillStats } from './compress/skills.ts';
import type { SessionMemo } from './session-memo.ts';
import type { Wire } from './wire.ts';

type Json = Record<string, any>;

export interface RequestRewrite {
  compression?: RewriteStats;
  skills?: SkillStats;
  /** True when the body changed and must be re-serialized. */
  changed: boolean;
}

/**
 * Applies the configured rewrites to a parsed request body, in place: one path for HTTP requests and WebSocket
 * `response.create` messages. `state` carries the Responses tool calls (and exec sessions) seen earlier on the same WebSocket, whose outputs
 * arrive in later messages without the call.
 */
export function rewriteRequest(
  json: Json,
  wire: Wire,
  compress: CompressConfig,
  keepSkills: ReadonlySet<string>,
  memo?: SessionMemo,
  state?: ResponsesState,
): RequestRewrite {
  let compression: RewriteStats | undefined;
  if (compress.bash) {
    if (wire === 'anthropic-messages') compression = rewriteAnthropic(json, memo);
    else if (wire === 'openai-responses') compression = rewriteResponses(json, memo, state);
    else if (wire === 'openai-chat') compression = rewriteChat(json, memo);
  }
  const skills = compress.skills ? rewriteSkills(json, wire, memo ? memo.keepSkills(keepSkills) : keepSkills) : undefined;
  return { compression, skills, changed: rewrote(compression) || !!skills?.skillsHidden };
}
