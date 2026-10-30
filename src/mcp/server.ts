import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { fileToolGuidance } from '../guidance.ts';
import { VERSION } from '../proxy.ts';
import { edit } from './edit.ts';
import { normalizePatterns, search } from './search.ts';
import { Session } from './session.ts';

// Tool descriptions travel with every request: keep them short and operational.
const SEARCH_DESCRIPTION = `Read files, list files and search content in one tool (replaces Read, Glob and Grep).
- patterns: file paths or globs, relative to path (default: cwd). Pass several at once to read them in one call.
- "file.ts#120-180" reads a line range; files are read 500 lines at a time.
- contentRegex: JavaScript regex; returns matching lines with their line numbers, unrelated lines are folded as "…a-b" with a hint of the next symbol. Use context for surrounding lines.
- summary: true returns an outline (functions, classes, methods with line ranges) instead of content.
- mode: "paths" lists files, "count" counts matches; the default is content for files and regex, paths for globs.
- Re-reading unchanged content returns a short "[unchanged]" stub: do not re-read to verify edits.`;

const EDIT_DESCRIPTION = `Create and modify files (replaces Edit, Write and MultiEdit). Batch edits in edits[]: applied in order, atomic per file.
- old_string + new_string: replace an exact, unique snippet (add context lines if it is not unique, or replace_all: true).
- new_string only: create a new file. With overwrite: true: replace a whole existing file.
- file_path may end with "#start-end" to restrict matching to those lines.
- The file must have been read with Search in this session and not changed on disk since.
- The result reports the changed line range; no need to re-read the file afterwards.`;

// Server-level guidance (MCP `instructions`), surfaced by clients that support it (Claude Code does, OpenCode 2.2 does not).
const INSTRUCTIONS = fileToolGuidance('Search', 'Edit');

export async function runMcpServer(cwd: string = process.cwd()): Promise<void> {
  const session = new Session();
  const server = new McpServer({ name: 'toonarrow', version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'Search',
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        patterns: z.union([z.string(), z.array(z.string())]).describe('File paths or globs, optionally with #start-end'),
        path: z.string().optional().describe('Root directory for relative patterns'),
        contentRegex: z.string().optional(),
        ignoreCase: z.boolean().optional(),
        context: z.number().int().min(0).max(20).optional(),
        mode: z.enum(['paths', 'content', 'count']).optional(),
        summary: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const patterns = normalizePatterns(args.patterns);
      const text = await search({ ...args, patterns }, session, cwd);
      return { content: [{ type: 'text', text }], isError: text.startsWith('error:') };
    },
  );

  server.registerTool(
    'Edit',
    {
      description: EDIT_DESCRIPTION,
      inputSchema: {
        edits: z
          .array(
            z.object({
              file_path: z.string(),
              old_string: z.string().optional(),
              new_string: z.string(),
              replace_all: z.boolean().optional(),
              overwrite: z.boolean().optional(),
            }),
          )
          .min(1),
      },
    },
    async (args) => {
      const { text, isError } = await edit(args.edits, session, cwd);
      return { content: [{ type: 'text', text }], isError };
    },
  );

  await server.connect(new StdioServerTransport());
}
