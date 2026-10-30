# toonarrow

**The open-source, multi-CLI alternative to Fermat's Last Token.**

toonarrow is a local proxy that cuts the tokens your coding agents send, by rewriting their context before it
reaches the provider. It works with **Claude Code, Codex, OpenCode and Kora**, runs entirely on your machine, needs
no account, and is Apache-2.0 licensed.

> *"I have discovered a truly marvelous proof of this, which this margin is too narrow to contain."*
> Pierre de Fermat, in the margin of his *Arithmetica*.
>
> Your context window is the margin. toonarrow makes the proof fit.

## Why

Coding agents resend the whole conversation on every turn: the system prompt, every tool definition, every file
they read and every command output. Most of it is noise the model does not need verbatim, and you pay for it again on
every request.

Measured on real sessions:

| What | Before | After |
|---|---:|---:|
| OpenCode system prompt with 688 installed skills (first request, gpt-6-luna) | 85,436 input tokens | 25,559 (-70%) |
| Output tokens of the main agent with the short-answer rule (Claude Code, Haiku, 2 paired runs) | 2,933 / 2,278 | 1,617 / 1,748 |
| Shell outputs from a real TypeScript monorepo (`git log`, `grep`, `tsc`, `ls -la`, ...) | 100% | 56% |

## What it does

- **Compresses shell output.** Per-command rules for `ls -l`, `git log/status`, `grep`/`rg`, `find`/`fd`, `pytest`,
  `vitest`/`jest`, `tsc`, `go test`, `cargo`, `npm`/`pip install`, `make`. Pipes and `&&` are never touched, and
  every compressed output tells the model how to get the raw one (`| cat`).
- **Compacts skill listings.** Skills you actually use keep their description; the rest are listed by name and
  still load on demand. `toonarrow skills --write` ranks them from your local history.
- **Replaces file tools.** An MCP server with `Search` (several files per call, folded grep results, tree-sitter
  outlines) and `Edit` (atomic batched edits with a read-gate).
- **Keeps answers short.** A short-answer rule appended to the main agent's system prompt.
- **Shows what it saved.** A local dashboard and `toonarrow stats`, in tokens, per day, session, model and client.

### Guarantees

- **Your prompt cache survives.** Every rewrite is a pure, deterministic and idempotent function of the block it
  touches: the same history produces the same bytes on every request.
- **toonarrow is never a dependency.** When it is not running, your agents run exactly as if it were not installed.
- **Nothing leaves your machine** except the requests your agents were already sending. No account, no telemetry.

## toonarrow and Fermat's Last Token

Fermat's Last Token showed that a local proxy plus better file tools can cut an agent's bill. toonarrow takes the
same idea to every coding agent, in the open.

| | toonarrow | Fermat's Last Token |
|---|---|---|
| Source | Open source (Apache-2.0) | Proprietary |
| Account | None | Required |
| Clients | Claude Code, Codex, OpenCode, Kora | Claude Code |
| Dashboard | Local, in tokens | Cloud |

*Comparison based on public information as of October 2026. toonarrow is not affiliated with or endorsed by
Quotient Labs; Fermat's Last Token is their product and trademark.*

## Install

Requirements: macOS, Node.js >= 24.

```bash
npm install -g toonarrow
toonarrow install
```

From source:

```bash
git clone https://github.com/andsigno82/toonarrow.git
cd toonarrow
npm install
node src/cli.ts install
```

`install` starts the proxy as a launchd service on `127.0.0.1:48700`, adds the `toonarrow` command to
`~/.local/bin`, and puts small shims for `claude`, `codex`, `opencode` and `kora` first in your PATH (a marked block
in `~/.zshrc`). Open a new shell and keep typing `claude`, `codex`, `opencode` or `kora` as usual: toonarrow attaches
by itself.

## Use

```bash
toonarrow status              # is the proxy running?
toonarrow stats --days 7      # tokens per model, session, client or day
toonarrow dashboard           # open http://127.0.0.1:48700/_toonarrow/
toonarrow skills --write      # keep descriptions only for the skills you use
```

Run a client explicitly through toonarrow, with options:

```bash
toonarrow claude [args]                  # Search/Edit tools, native file tools redirected
toonarrow opencode --toonarrow-tools     # also swap OpenCode's native file tools
toonarrow codex --toonarrow-no-brief     # without the short-answer rule
```

### Kora

Kora CLI reads `KORA_LLM_PROXY`, which the `kora` shim sets. Kora Desktop has an opt-in switch in
*Settings > Smart Token Engine > Context proxy*, in the releases that include it.

### Configuration

`~/.toonarrow/config.json`:

```json
{
  "port": 48700,
  "capture": "off",
  "compress": { "bash": true, "skills": false, "keepSkills": [] }
}
```

### Uninstall

```bash
toonarrow uninstall
```

Removes the service, the command, the shims and the `~/.zshrc` block. Your data stays in `~/.toonarrow`.

## How it works

```text
claude / codex / opencode / kora
        |  shim: is toonarrow running?  no -> run the client unchanged
        v
127.0.0.1:48700  ->  rewrite context  ->  provider API
        |              (shell output, skills)
        +-- tee response -> token usage -> ~/.toonarrow/usage
```

Details, invariants and the verified wire format of each client: [documentation/architecture.md](documentation/architecture.md).

## Contributing

Issues and pull requests are welcome. Before you send one:

```bash
npm test
npm run typecheck
```

Every new transformation needs a test that applies it twice and gets the same bytes, and no change may make a client
depend on toonarrow being up.

## License

[Apache-2.0](LICENSE)
