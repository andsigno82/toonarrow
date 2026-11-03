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
   survives. Each transformation has a second-pass test. Within a session the first decision for each block (and
   the skill keep-list of the first request) is recorded in `~/.toonarrow/sessions/` and replayed, so a rule
   upgrade or a config change applies only to blocks the provider has not cached yet (`src/session-memo.ts`).
2. **Fail-soft.** An unparsable body, an unknown format or a low gain is forwarded unchanged.
3. **Escape hatch.** Every compressed shell output ends with `[toonarrow <rule>: N->M chars; ... | cat]`. A command
   ending in `| cat` is never compressed, so `cmd | cat` (or `( … ) | cat` for a chain) always returns the raw output.
4. **Rules only where the origin is certain.** Command rules apply to a simple command, to the last step of a
   chain whose other steps print nothing on success (`cd dir`, `export`, `set`, `unset`, `source`, `nvm use`,
   variable assignments), or to the head of a pipeline whose remaining stages only select lines (`head`, `tail`,
   `sort`, `uniq`, `grep`, `rg`, `tee`, bare `cat`). Filter options are a whitelist per command: any other option
   (`grep -n/-H/-A/--color`, `head -c`, `uniq -c`…) or a file operand makes the origin ambiguous. On output whose
   origin stays ambiguous (loops, several real commands, rewriting filters like `sed`/`awk`) only the `byFormat`
   rules run: each recognises a tool by its
   output signature and rewrites just the lines in its own format — a run of `path:N:text` matches becomes a
   grouped grep report while every other line passes through byte for byte. When several format rules recognise
   the same output the one that removes the most bytes wins; everything else gets the lossless generic cleanup
   (ANSI codes, redraws, repeated lines with a count).
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
| `src/compress/request.ts` | shell call/result pairing for Anthropic Messages, Responses API and Chat Completions; the Codex code-mode script reader (statement grammar, `write_stdin` sessions) |
| `src/compress/memo.ts`, `src/session-memo.ts` | per-session memo of compression decisions and its on-disk store |
| `src/compress/search.ts` | non-shell search results, lossless: OpenCode `grep` (common directory factored, `Line N:` -> `N:`), Kora `searchCode` (JSON -> grep-style text with count, truncation and note); `is_error` results untouched; Anthropic, Chat Completions and Responses wires |
| `src/compress/json.ts` | byte-preserving JSON edits: in-place replacement of top-level string fields (also inside one top-level object field), whitespace-only minify |
| `src/compress/skills.ts` | skill listings: Codex entries regrouped by root (lossless, always on); with `compress.skills`, full entry for skills in `compress.keepSkills`, names only for the rest |
| `src/skill-usage.ts` | skill usage from local history (OpenCode database, Claude Code transcripts, Kora sessions), for `toonarrow skills` |
| `src/estimate.ts` | `toonarrow estimate`: local history of each client rebuilt as its request bodies and passed to the proxy's rewrites, offline |
| `src/ledger.ts`, `src/report.ts` | JSONL usage ledger; aggregation shared by `toonarrow stats` and the dashboard |
| `src/dashboard.ts` | local dashboard page served at `/_toonarrow/` |
| `src/launch.ts`, `src/codex-config.ts` | client launchers, shims, the Claude Code `PreToolUse` hook; the `developer_instructions` a Codex run would use (TOML string reader) |
| `src/platform/` | what differs per OS: background service, `toonarrow` wrapper, shim scripts, shell rc block, opening a URL, executable lookup; macOS in `darwin.ts` (launchd), Linux in `linux.ts` (`systemd --user`), other systems not supported yet |
| `src/mcp/*` | MCP stdio server with `Search` and `Edit` (multi-file reads, folded grep, tree-sitter outlines, read-gate) |
| `src/cli.ts` | `serve`, `status`, `stats`, `dashboard`, `skills`, `estimate`, `install`/`uninstall`, `env`, `mcp`, `hook`, launchers |

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
| Codex | `custom_tool_call` `exec` scripts made only of known statements (below); `function_call` `exec_command`/`shell`/`bash` | `*_output`: a header (`Script completed\nWall time …`), then one part per call in call order: JSON `{output}`, a `Promise.allSettled` result `{status, value: {output}}`, or the plain output; a single call may also be `...Output:\n<text>`. Parts that do not line up one per call pass through |
| OpenCode 2.x | `shell`, `input.command` (Chat, Anthropic and Responses wires) | `role: tool` message, `tool_result` or `function_call_output` |
| Kora | `executeCommand`, `{command, readOnly}` | JSON `{success, stdout, stderr, exit_code}`: `stdout` and `stderr` are compressed |

Codex code-mode statements (Codex 0.160-0.166): `text(await tools.X({...}))`; `const r = await tools.X({...});
text(r.output)` or `text(JSON.stringify(r))`; `const rs = await Promise.allSettled([...])` or `Promise.all([...])`
followed by `for (const r of rs) text(...)` or `rs.forEach(text)`. The script is scanned with string literals and
comments respected; each `tools.*` call is one output part. `exec_command` parts are compressed with their `cmd`,
`write_stdin` parts with the command running in that `session_id` (learned from an earlier exec result that carried
it, kept per conversation and per WebSocket), other tools' parts (`web__run`, `apply_patch`) stay as they are. Any
other statement (`ALL_TOOLS` lookups, post-processing like `.slice()`, template literals with `${}`) leaves the whole
script alone. Codex merges or truncates the parts when the output is too long; then the count no longer matches
and nothing is touched.

Skill listings: OpenCode `<available_skills>` (XML entries `<id>/<name>/<description>`), Kora `## Available Skills`
(lines `- **name**: description`), Codex `<skills_instructions>` (`### Skill roots` table, then `### Available
skills` lines `- name: [description ](file: rN/path/SKILL.md)`). Codex entries without a description whose file is
`<root>/<name>/SKILL.md` become one `- rN: a, b, c` line per root, under a note giving that rule: every path is
recoverable, so this runs without `compress.skills`, and only when it makes the listing shorter. With
`compress.skills`, unused skills of every format are collapsed into names; they stay loadable by name.

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
- Codex: `-c` overrides for `openai_base_url` and `developer_instructions`; `mcp_servers.toonarrow` only with
  `--toonarrow-tools` (Codex code mode defers MCP tools: they are on the `tools` object and in `ALL_TOOLS` but not
  described to the model, so the launcher then also tells it to call `tools.mcp__toonarrow__Search`/`Edit`).
  A `developer_instructions` override replaces the configured value, so the launcher reads the one the run would use
  (profile from `-p`, nearest project `.codex/config.toml`, `$CODEX_HOME/config.toml`) and appends toonarrow's
  guidance after it; a value that is not a plain TOML string disables the guidance instead of being dropped.
  `openai_base_url` is Codex's documented seam for pointing the built-in `openai` provider at a proxy (`openai` is
  a reserved provider id: `[model_providers.openai]` cannot be overridden). Codex records the provider id in each
  session and refuses `resume`/`fork` on a mismatch (`modelProviderMismatch`); keeping `openai` means sessions made
  through toonarrow, with plain codex or in the IDE extension resume in any of them. toonarrow 0.1.x used a custom
  `toonarrow` provider instead: for those sessions only, the launcher reads the recorded `model_provider` from the
  rollout's `session_meta` (session UUID, or `--last` with Codex's filters: working directory, interactive sources)
  and resumes them with that provider, straight to `chatgpt.com/backend-api/codex` when the proxy is down. The base
  URL follows the sign-in: `/chatgpt` for ChatGPT, `/openai/v1` when `auth_mode` in `$CODEX_HOME/auth.json` is
  `apikey` (only that field is read; credentials in the OS keyring count as ChatGPT).
- OpenCode 2.x: `opencode --standalone` with `OPENCODE_CONFIG_CONTENT` (provider base URLs, instructions file;
  `--toonarrow-tools` swaps native file tools for the MCP ones). The shared background service never sees the
  client's environment, hence the private server.
- Kora CLI: `KORA_LLM_PROXY=<proxy>`; Kora rewrites every remote provider base URL to `/_via/`. Kora Desktop has an
  opt-in setting instead (an app started from Finder sees no shell environment).

The short-answer rule can be left out with `--toonarrow-no-brief`.

## Provider quirks

- ChatGPT backend (`chatgpt.com/backend-api/codex`): no `content-type` on responses, and Codex closes the connection
  right after `response.completed`; usage is kept from what already streamed.
- Responses API WebSocket mode (Codex 0.166.0, verified against the ChatGPT backend): the built-in `openai` provider
  opens `ws(s)://<base>/responses`, offers `permessage-deflate` and accepts a handshake without it. It sends a
  warmup `response.create` (`generate: false`, empty input), then one `response.create` per turn with only the new
  input items and `previous_response_id`; the tool call answered by a `*_output` item arrived earlier as a server
  `response.output_item.done`. toonarrow relays the socket (`src/ws.ts`): client `response.create` messages get the
  HTTP Responses rewrite with the connection's known calls, server events pass through untouched, and each turn is
  one ledger entry (`method: WS`, `transport: websocket`). When the upstream refuses the socket the client gets
  426: Codex then falls back to HTTPS at once, while any other refusal (e.g. 405) costs it 5 reconnect attempts
  first. Other WebSocket paths are refused with 426. The `ws` package is loaded on the first upgrade only.
- OpenCode with OpenAI OAuth also tries a Responses WebSocket first; it is relayed the same way.
- Some gateways relay upstream errors as an SSE event inside an HTTP 200 stream.

## Local data

`~/.toonarrow/`: `config.json`, `usage/` (ledger), `sessions/` (per-session memo of compression decisions: one
private JSONL file per session, deleted after 14 days without use, capped at 32 MB each), `capture/` (only with
`capture` on), `logs/`, `bin/` (shims), `runtime.json`. Nothing leaves the machine except the proxied requests themselves: no account, no telemetry.
