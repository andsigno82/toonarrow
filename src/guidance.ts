/**
 * Output-length rule for the main agent: output tokens are the most expensive ones and are never cached.
 * Appended to the client's own system prompt (Claude Code, Codex, OpenCode), so it stays cache-stable.
 */
export const BRIEF_GUIDANCE = `Response length (toonarrow):
- Lead with the result. Keep prose in a final answer to about 120 words; go longer only when the user asks for detail, an explanation, a plan or a document.
- No preamble, no restating the request, no recap of what the tool calls already show, no closing offers.
- Between tool calls, write one short sentence or nothing.
- Code, commands, diffs and tables are outside the word limit, but include only what the user needs.`;

/** Agent guidance for the toonarrow file tools; tool names differ per client (mcp__toonarrow__Search, toonarrow_Search). */
export function fileToolGuidance(search: string, edit: string, note = ''): string {
  return `File work goes through the toonarrow tools: ${search} to read, list and grep files; ${edit} to create and modify them.${note ? `\n${note}` : ''}
Do not use the shell for read-shaped commands (cat, head, tail, sed -n, grep, rg, find, ls of files) or write-shaped ones (sed -i, echo/cat > file, tee): use ${search} and ${edit}.
Read several files in one ${search} call; batch independent changes in one ${edit} call; do not re-read a file just to verify an edit.
Use the shell for building, testing, git and package management.`;
}
