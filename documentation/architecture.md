# toonarrow architecture

A local HTTP proxy (Node >= 24, TypeScript run natively, zero runtime dependencies) between coding agents and
provider APIs. It reads every request, rewrites the context deterministically, forwards it, and tees the response to
record token usage.

## Request flow

```text
client (Claude Code / Codex / OpenCode / Kora)
  -> http://127.0.0.1:48700/<upstream>/<path>          named upstream from config (anthropic, openai, chatgpt, ...)
     or http://127.0.0.1:48700/_via/<scheme>/<host>/<path>   target carried in the path (Kora)
  -> detectWire(path)        anthropic-messages | openai-responses | openai-chat | other
  -> parse body, request metadata (model, stream, session, client)
  -> rewrites                shell results (compress.bash), skill listings (compress.skills)
                             re-serialized only when something changed
  -> upstream (accept-encoding: identity)
  <- response streamed back byte for byte, tee into the usage collector
  -> ledger ~/.toonarrow/usage/usage-YYYY-MM-DD.jsonl
```

## Invariants

1. **Deterministic and idempotent.** Every rewrite is a pure function of the block it touches. The same history
   yields the same bytes on every request, and a second pass changes nothing, so the provider's cached prefix
   survives. Each transformation has a second-pass test.
2. **Fail-soft.** An unparsable body, an unknown format or a low gain is forwarded unchanged.
3. **Escape hatch.** Every compressed shell output ends with `[toonarrow <rule>: N->M chars; ... | cat]`. A command
   ending in `| cat` is never compressed, so `cmd | cat` (or `( … ) | cat` for a chain) always returns the raw output.
4. **Rules only where the origin is certain.** Command rules apply to a simple command, or to the last step of a
   chain whose other steps print nothing on success (`cd dir`, `export`, `set`, `unset`, `source`, `nvm use`). Any
   other compound output (pipes, loops, several commands) gets only the lossless generic cleanup (ANSI codes, redraws,
   repeated lines with a count).
5. **Diagnostics survive.** Rules never drop error and warning lines, failing test names or `file:line` references;
   each rule has a sample in `test/fixtures/shell-samples.ts` and property tests check that its signal lines survive.
6. **JSON bytes are kept.** Inside JSON tool results only the edited string fields change (`src/compress/json.ts`);
   the payload is never re-serialized.
7. **Never a dependency.** With the proxy off, every client runs exactly as without toonarrow (see Client
   integration).

## Modules

| File | Role |
|---|---|
| `src/config.ts` | `~/.toonarrow/config.json`: host, port, upstreams, capture (`off`/`meta`/`full`), compress |
| `src/proxy.ts` | server, routing (`/<upstream>/`, `/_via/`), rewrites, usage tee, early client close, dashboard routes |
| `src/wire.ts`, `src/sse.ts`, `src/usage.ts` | wire detection, incremental SSE parser, provider-neutral usage, stream error events |
| `src/meta.ts` | session and client identity, body decoding (gzip/br/zstd), header redaction |
| `src/compress/shell/` | per-command rules by family (`files`, `git`, `tests`, `build`) and the registry in `index.ts`: ls -l, git log/status, grep/rg, find/fd, pytest, vitest/jest, tsc, go test, cargo, npm/pip install, make |
| `src/compress/request.ts` | shell call/result pairing for Anthropic Messages, Responses API and Chat Completions |
| `src/compress/json.ts` | byte-preserving JSON edits: in-place replacement of top-level string fields, whitespace-only minify |
| `src/compress/skills.ts` | skill listings: full entry for skills in `compress.keepSkills`, names only for the rest |
| `src/skill-usage.ts` | skill usage from local history (OpenCode database, Claude Code transcripts, Kora sessions), for `toonarrow skills` |
| `src/ledger.ts`, `src/report.ts` | JSONL usage ledger; aggregation shared by `toonarrow stats` and the dashboard |
| `src/dashboard.ts` | local dashboard page served at `/_toonarrow/` |
| `src/launch.ts` | client launchers, shims, the Claude Code `PreToolUse` hook |
| `src/platform/` | what differs per OS: background service, `toonarrow` wrapper, shim scripts, shell rc block, opening a URL, executable lookup; macOS in `darwin.ts`, other systems not supported yet |
| `src/mcp/*` | MCP stdio server with `Search` and `Edit` (multi-file reads, folded grep, tree-sitter outlines, read-gate) |
| `src/cli.ts` | `serve`, `status`, `stats`, `dashboard`, `skills`, `install`/`uninstall`, `env`, `mcp`, `hook`, launchers |

## Proxy routes

| Route | Purpose |
|---|---|
| `/<upstream>/<path>` | forward to a named upstream from `config.upstreams` |
| `/_via/<scheme>/<host>/<path>` | forward to the target in the path; a target pointing back at toonarrow is refused |
| `/_toonarrow/health` | `{ ok, version, pid, features }`; clients require `features` to contain `via` before using `/_via/` |
| `/_toonarrow/`, `/_toonarrow/api/summary?days=N` | dashboard page and its data |

Errors produced by toonarrow itself carry `x-toonarrow-error`: `route` means nothing was forwarded (safe to resend
directly), `upstream` and `internal` mean the request may have been forwarded.

## Verified wire formats

Shell tools whose results are compressed:

| Client | Call | Result |
|---|---|---|
| Claude Code | `tool_use` `Bash`, `input.command` | `tool_result.content`, string or one text block |
| Codex | `custom_tool_call` `exec` scripts made only of `text(await tools.exec_command({cmd}))` statements; `function_call` `exec_command`/`shell` | `*_output`: a header, then one JSON `{output}` per call in order, or `...Output:\n<text>`. Scripts with any other statement pass through |
| OpenCode 2.x | `shell`, `input.command` (Chat, Anthropic and Responses wires) | `role: tool` message, `tool_result` or `function_call_output` |
| Kora | `executeCommand`, `{command, readOnly}` | JSON `{success, stdout, stderr, exit_code}`: `stdout` and `stderr` are compressed |

Skill listings: OpenCode `<available_skills>` (XML entries `<id>/<name>/<description>`), Kora `## Available Skills`
(lines `- **name**: description`). Unused skills are collapsed into one line of names; they stay loadable by name.

Session identity, in order: `x-claude-code-session-id`, Claude Code `metadata.user_id`, `session_id` header (Codex),
`session_id` body field (Kora, which may also send `x-opencode-session-id` from a session-header rule),
`x-opencode-session-id`, `prompt_cache_key`.

## Usage accounting

- `input` excludes cached tokens on every wire, so `input + cacheRead + cacheWrite` is the full prompt.
- Saved tokens are estimated per request: characters removed by toonarrow times the request's own token density
  (billed prompt tokens divided by the bytes actually sent). They are tokens that would otherwise have been sent in
  that request.
- An error event inside a 2xx stream (for example a gateway 429 relayed as an SSE event) is recorded as
  `stream error: ...` and counted as a failed request.
- Only inference requests (Anthropic Messages, Responses, Chat Completions) enter totals, sessions, models and
  clients. Model lists, health probes and other paths are only counted, as "not inference".

## Client integration

**Shims (default).** `toonarrow install` writes `claude`, `codex`, `opencode` and `kora` shims to `~/.toonarrow/bin`
and puts that directory first in PATH through a marked block in `~/.zshrc`. A shim:

- checks `/_toonarrow/health`; when the proxy is off it runs the real client unchanged;
- otherwise applies the client's launcher (below);
- resolves the real binary after its own directory and removes that directory from the child's PATH, so wrappers in
  the chain (terminal integrations, other proxies' shims) can never re-enter it.

**Launchers** (`toonarrow <client>`), all without touching the client's global configuration:

- Claude Code: `ANTHROPIC_BASE_URL`, `--mcp-config` (Search/Edit), `--settings` (`PreToolUse` hook that redirects
  native file tools while `TOONARROW_TOOLGATE=1`), `--append-system-prompt-file` (short-answer rule).
- Codex: `-c` overrides for `model_providers.toonarrow`, `mcp_servers.toonarrow` and `developer_instructions`.
- OpenCode 2.x: `opencode --standalone` with `OPENCODE_CONFIG_CONTENT` (provider base URLs, instructions file;
  `--toonarrow-tools` swaps native file tools for the MCP ones). The shared background service never sees the
  client's environment, hence the private server.
- Kora CLI: `KORA_LLM_PROXY=<proxy>`; Kora rewrites every remote provider base URL to `/_via/`. Kora Desktop has an
  opt-in setting instead (an app started from Finder sees no shell environment).

The short-answer rule can be left out with `--toonarrow-no-brief`.

## Provider quirks

- ChatGPT backend (`chatgpt.com/backend-api/codex`): no `content-type` on responses, and Codex closes the connection
  right after `response.completed`; usage is kept from what already streamed.
- OpenCode with OpenAI OAuth first tries a WebSocket upgrade, gets a 405 through the proxy and falls back to HTTP.
- Some gateways relay upstream errors as an SSE event inside an HTTP 200 stream.

## Local data

`~/.toonarrow/`: `config.json`, `usage/` (ledger), `capture/` (only with `capture` on), `logs/`, `bin/` (shims),
`runtime.json`. Nothing leaves the machine except the proxied requests themselves: no account, no telemetry.
