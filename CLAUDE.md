# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`clap-its-a-wrap` is an npm package that installs a `clap` command. `clap` starts a local Anthropic-compatible proxy (a bundled copy of `cognition-claude-proxy`) and then runs the `claude` CLI with `ANTHROPIC_BASE_URL` pointed at it. The proxy translates Anthropic Messages API calls into Connect-RPC/protobuf calls to the Devin CLI backend (`server.codeium.com`), so Claude Code can drive the models that backend offers (SWE-2, GLM, DeepSeek, Claude, GPT, "fusion" combos).

Plain Node.js (>=18.19, needed for extensionless ESM `bin/clap`). The package is `"type": "module"`, so every file uses ESM `import`. There are no dependencies, no build step and no linter.

## Commands

```bash
npm test                         # runs node test.js (file existence, `node --check` on every source, content smoke checks)
node lib/proxy/src/server.js     # run the proxy directly (127.0.0.1:$CCP_PORT, default 8765)
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/v1/models
./bin/clap [--proxy DIR] [--update] [claude args...]
./bin/clap --setup-models        # interactive: allowlist + where blocked models go -> ~/.clap/models.json, restarts proxy
./bin/clap --doctor              # checks node/claude/git/API key; offers to install or update claude
./bin/clap --routes              # print the running proxy's routes + reroutes seen (GET /routes); starts nothing
```

Because `test.js` is a single script with no test filtering, the only way to run one check is to comment out the others.

To exercise the launcher without a real `claude` or touching `~/.clap`, put a stub `claude` script first on `PATH` and set `CLAP_CACHE_DIR`, `CLAP_WORKSPACE` and `CCP_PORT` to throwaway values. `/health` needs no API key.

Repo: https://github.com/ReuK212/clap-its-a-wrap. Release with `npm version <bump>` (commits and tags `vX.Y.Z`), then `npm publish`; `npm pack --dry-run` shows what ships (`bin`, `lib`, README, LICENSE, package.json).

## Architecture

**Launcher (`bin/clap`)**
1. Loads `KEY=VALUE` lines from `$CLAP_WORKSPACE/.env.global` (default `~/repos/_ai_workspace/.env.global`) into `process.env`. If `CCP_API_KEY` is unset, it is copied from `COGNITION_API_KEY`.
2. Resolves the proxy directory in this order: `--proxy DIR`, then `--update` (which `git clone`s into `$CLAP_CACHE_DIR`, default `~/.clap/cognition-claude-proxy`), then the cached clone, then the bundled copy. A directory is valid if it contains `src/server.js`.
3. If `/health` already responds, it reuses that proxy. If the port is taken by something else, it refuses to start. Otherwise it spawns a detached, unref'd `node src/server.js`, with stdout and stderr going straight to `$CLAP_CACHE_DIR/proxy.log`, and polls `/health` (via `fetch`; no curl needed) for up to 5s. The proxy keeps running after `clap` exits, and later runs reuse it.
4. Sets `ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT` and spawns `claude`. Leave `/v1` off: the SDK appends `/v1/messages` itself, and a `/v1` base sends every request to a 404, which Claude Code reports as "issue with the selected model". It spawns `claude` with the remaining args (`--proxy` and `--update` are removed). `clap` exits with `claude`'s exit code. It also sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=262000` (SWE-2's window) unless the user set it or `CCP_ROUTING=off`. Claude Code otherwise sizes compaction for the Claude model it asked for: 1M for `claude-opus-5-5`, checked with `clap -p /context`. This variable caps the window and never raises it, so Haiku keeps 200K. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` only applies to models Claude Code doesn't recognise, which is why it isn't used.

**Proxy (`lib/proxy/src/`)**: the request path is `server.js` → `translate.js` → `codeium.js` → `proto.js`.
- `server.js`: HTTP routes are `/health`, `/routes` (active routing table, default model, and per-requested-model upstream and request counts since start), `/v1/models`, `/v1/messages` (streaming and non-streaming) and `/v1/messages/count_tokens` (a rough estimate: bytes divided by 8).
  - Upstream failures are retried up to `CCP_MAX_ATTEMPTS` times, except auth, precondition and "prompt is too long" errors.
  - For streaming requests, the proxy buffers upstream events until the first content-bearing one arrives, and only then commits the 200/SSE response. A failure before that point still returns a proper HTTP error and can be retried. A failure after commit is sent as an SSE `error` event.
- `translate.js`: converts between Anthropic messages and the internal "chisel" message shape (roles 1=user, 2=assistant, 4=tool_result) in both directions, including thinking/signature blocks and tool calls.
  - It **replaces Claude Code's entire system prompt** with a short neutral one, keeping only the `# Environment` section, because the upstream content filter rejects phrases in Claude Code's prompt.
  - It also trims tool descriptions (480 chars max) and sanitizes tool_use IDs to `^[a-zA-Z0-9_-]+$` in both directions.
- `codeium.js`: Connect-RPC client for `GetChatMessage`. It impersonates the `devin-cli`/`chisel` client metadata and clamps sampling params into the range upstream accepts.
- `proto.js`: a hand-written protobuf wire codec with no schema. Field numbers are hard-coded in `codeium.js` and `models.js`, so a protocol change means editing those numbers by hand.
- `models.js`: fetches the model catalog live from `GetCliModelConfigs`. If that fails, it falls back to the `models.json` snapshot. The result is cached for the life of the process.
- `config.js`: API key comes from `CCP_API_KEY`, otherwise from `windsurf_api_key` in the Devin CLI's `credentials.toml` (`~/.config/devin/credentials.toml`, overridable via `CCP_CREDENTIALS`). The Devin CLI itself is never run, so it isn't a dependency; `codeium.js` only sends its client name in the request metadata.

There are no install scripts, so `npm i -g` needs no `allow-scripts` approval. `clap --doctor` handles setup: it installs a missing `claude` via `https://claude.ai/install.sh` (or `install.ps1` on Windows) and runs `claude update`, each only after a yes/no question. A `claude` spawn failing with ENOENT tells the user to run it.

**Model routing (`routing.js` + `routes.json`).** `server.js` rewrites the requested model before calling upstream, so Claude Code's own model names end up on SWE models.
- **Defaults:** `claude-opus-*`/`claude-fable-*` → `swe-2-max`, `claude-sonnet-*` → `swe-2-high`, `claude-haiku-*` → `swe-2-medium`, and any other `claude-*` → `swe-2-high`. Non-Claude IDs pass through.
- **Matching:** an exact key beats a glob, and among globs the longest pattern wins. A trailing `[1m]` is stripped. A target of `""` means pass through unchanged.
- **Overrides:** `CCP_ROUTES_FILE` (a JSON file), then `CCP_ROUTES` (inline JSON). `CCP_ROUTING=off` disables routing.
- **What the client sees:** responses echo the *requested* model name, and translate.js no longer copies the upstream's model name into responses. The routed model goes in the `x-ccp-model` response header and in a `[route] a -> b` line in the proxy log, logged once per pair.
- **Model marker:** each answer's first text gets a `[model: <upstream id>]\n` line, via `modelMarker` in translate.js, applied to both streaming and non-streaming responses. `anthropicToChisel` strips it from assistant history, so the upstream never sees it. Turn it off with `CCP_SHOW_MODEL=off`.
- **`max_tokens`:** clamped to the routed model's `maxOutput` from the catalog.
- Every route target must be an upstream catalog ID (`GET /v1/models`). Upstream rejects anything else, including Claude Code's raw names, with 403 `permission_denied`. The tests check route targets against `models.json`.

**Allowlist (`loadPolicy`/`applyPolicy` in routing.js).** This check runs after routing, on the upstream ID.
- **Sources:** `CCP_POLICY_FILE` (JSON `{allowed, reroute_blocked_to}`); if that is unset or missing, the bundled `policy.json` (`swe-2-*` allowed, blocked → `swe-2-high`). Either is overridden by `CCP_ALLOWED_MODELS` (comma-separated IDs or globs) and `CCP_REROUTE_BLOCKED_TO`.
- **Behaviour:** an empty list allows everything (a saved file with `"allowed": []` is how "all" is stored). A blocked model goes to `reroute_blocked_to`; if that is null or `""`, the request gets a 400 `invalid_request_error`, which Claude Code shows verbatim as "API Error: 400 …". The reroute target must itself be allowed, otherwise the proxy refuses to start.
- **Reporting:** `/routes` reports the policy, and `seen[].blocked` holds the model that was blocked.
- **`clap` side:** `loadEnv` always points `CCP_POLICY_FILE` at `$CLAP_CACHE_DIR/models.json`. `--setup-models` writes that file and restarts the proxy, killing whatever listens on the port via `lsof` (Unix only).
- **Scripting:** the setup step reads answers one per line from stdin (see `createPrompter`), so it can be scripted, as test.js does.

**403 `permission_denied` usually comes from the content filter, not the model.** Upstream returns the same error for filtered *content*. Example: WebSearch's "Allows Claude to search the web…" description failed every request that included that tool, whatever the model. To debug, set `CCP_DEBUG=1`, replay the dumped request with curl, and remove tools or lines one at a time. Fixes go in `sanitizeSystem` and `sanitizeToolDesc` in translate.js. The latter now rewrites "Claude" to "the assistant" but leaves "Claude Code" alone.

## Environment variables

| Var | Purpose |
|---|---|
| `CCP_PORT` / `PROXY_PORT` | Proxy port (default 8765) |
| `CCP_API_KEY` / `COGNITION_API_KEY` | Upstream key |
| `CCP_CREDENTIALS` | Path to Devin `credentials.toml` |
| `CCP_UPSTREAM` | Upstream base URL (default `https://server.codeium.com`) |
| `CCP_DEFAULT_MODEL` | Model used when the request has none (default `swe-2-high`) |
| `CCP_ROUTES` / `CCP_ROUTES_FILE` | Extra model routes (inline JSON / JSON file), merged over `routes.json` |
| `CCP_POLICY_FILE` | Allowlist JSON (clap sets `$CLAP_CACHE_DIR/models.json`; falls back to bundled `policy.json`) |
| `CCP_ALLOWED_MODELS` / `CCP_REROUTE_BLOCKED_TO` | Override the allowlist / blocked target (`""` = reject) |
| `CCP_SHOW_MODEL` | `off` stops the `[model: ...]` line before answers |
| `CCP_ROUTING` | `off` disables model routing |
| `CCP_MAX_ATTEMPTS` | Upstream retry cap (default 8) |
| `CCP_DEBUG` | Log requests and dump each request body to `$TMPDIR/ccp-req-*.json` |
| `CCP_DEBUG_SSE` | Write the outgoing SSE stream to `$TMPDIR/ccp-sse-*.log` |
| `CLAP_CACHE_DIR` | Proxy clone and log location (default `~/.clap`) |
| `CLAP_WORKSPACE` | Directory containing `.env.global` |
