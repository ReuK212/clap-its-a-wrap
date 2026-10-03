# clap-its-a-wrap

**CLAP** (Claude + Local Anthropic Proxy) runs Claude Code on SWE-2 models.

`clap` starts a small local proxy and then runs `claude` against it. The proxy
translates Claude Code's Anthropic API calls for the Devin/Codeium backend
(`server.codeium.com`) and reroutes Claude model names to SWE-2 models. Everything
else works like `claude`: same arguments, same interactive UI.

```
$ clap -p "who are you?"
[model: swe-2-max]
I'm an AI coding assistant ...
```

## Installation

```bash
npm install -g clap-its-a-wrap
clap --doctor
```

- **No approvals:** the package runs no install scripts, so npm asks for none.
- **What `--doctor` checks:** Node, `claude`, `git` and your API key.
- **What it can install:** if `claude` is missing, it offers to install it with
  Anthropic's native installer, into `~/.local` with no sudo. If `claude` is already
  there, it offers to update it.

### API key

The proxy needs a key for the Devin/Codeium backend. It looks in these places, in
order:

1. `CCP_API_KEY` or `COGNITION_API_KEY` in your environment.
2. A `.env.global` file of `KEY=VALUE` lines in `$CLAP_WORKSPACE`, which defaults to
   `~/repos/_ai_workspace`. Example: `COGNITION_API_KEY=...`.
3. The Devin CLI login file, `~/.config/devin/credentials.toml`. You can point
   `CCP_CREDENTIALS` at another path.

The Devin CLI itself does not need to be installed: the proxy talks to the backend
directly. Run `clap --doctor` again to confirm the key is found.

### Requirements

- Node.js 18.19 or newer.
- Claude Code (`claude`). `clap --doctor` can install it.
- git, but only for `clap --update`.
- Tested on macOS and Linux. Restarting the proxy from `clap --setup-models` uses
  `lsof`, so it does not work on Windows.

## Usage

```bash
clap                           # interactive Claude Code session, through the proxy
clap -p "Fix the auth bug"     # any claude argument works the same way
clap --model haiku             # Claude model names are rerouted (see below)

clap --doctor                  # check and fix what clap needs
clap --routes                  # show the running proxy's routes, allowlist and traffic
clap --setup-models            # choose allowed models and where blocked requests go
```

All other arguments, including `--help`, are passed straight to `claude`.

### Starting the proxy

- **First run:** `clap` starts the proxy in the background on `127.0.0.1:8765`
  (`CCP_PORT` changes the port). Its log is `~/.clap/proxy.log`.
- **Later runs:** the proxy keeps running after `claude` exits, and later runs reuse
  it.
- **After changing settings:** restart the proxy by killing it and running `clap`
  again. `clap --setup-models` offers to restart it for you.

## Model routing

Claude Code keeps asking for Claude models. The proxy sends them to SWE-2 models
instead (`lib/proxy/src/routes.json`):

| Claude Code asks for | Sent upstream as |
|---|---|
| `claude-opus-*`, `claude-fable-*` | `swe-2-max` |
| `claude-sonnet-*` | `swe-2-high` |
| `claude-haiku-*` (background tasks) | `swe-2-medium` |
| any other `claude-*` | `swe-2-high` |

Other model IDs pass through unchanged, but the allowlist below then applies to
them. To change a route, pass it at startup:

```bash
CCP_ROUTES='{"claude-opus-*":"swe-2-high"}' clap   # change a route
CCP_ROUTING=off clap                               # no rerouting
```

These settings are read when the proxy starts, so restart it first. Route targets
must be IDs from `curl http://127.0.0.1:8765/v1/models`.

- **Seeing which model answered:** every answer starts with a `[model: <id>]` line.
  The proxy removes that line from the history before sending it upstream. Turn it
  off with `CCP_SHOW_MODEL=off`.
- **Context window:** Claude Code thinks it has a Claude model, with up to a
  1M-token window, but SWE-2 has 262K. So `clap` sets
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=262000`, which makes automatic summarising of
  long conversations start in time. Set the variable yourself to override this.

## Restricting models

By default only `swe-2-*` models are allowed. A request for any other model, for
example `--model glm-5-2`, is answered by `swe-2-high`. The default lives in
`lib/proxy/src/policy.json`.

To change it, run `clap --setup-models`. It asks three things:

1. **Allowed models:** upstream IDs or globs, separated by commas
   (`swe-2-high,swe-1-*`). `?` lists the catalog, `? swe` searches it, and `all`
   removes the limit.
2. **Blocked requests:** reroute them to one of the allowed models, or reject them
   with an error.
3. **Apply:** restart the running proxy so the new list takes effect.

Your answers are saved to `~/.clap/models.json`, which replaces the default:

```json
{ "allowed": ["swe-2-high", "swe-2-medium"], "reroute_blocked_to": "swe-2-high" }
```

- **What the check covers:** it applies to the upstream model after routing, so it
  catches `--model`, background Haiku calls, subagents and anything else that
  reaches the proxy.
- **One-off override:** set `CCP_ALLOWED_MODELS` and/or `CCP_REROUTE_BLOCKED_TO`
  (`""` means reject), then restart the proxy.
- **Claude Code's own picker:** to limit what `/model` offers as well, add
  `availableModels` and `enforceAvailableModels: true` to `~/.claude/settings.json`.

## Environment variables

| Variable | Purpose |
|---|---|
| `CCP_PORT` | Proxy port (default 8765) |
| `CCP_API_KEY` / `COGNITION_API_KEY` | Upstream API key |
| `CCP_CREDENTIALS` | Path to the Devin CLI's `credentials.toml` |
| `CCP_ROUTES` / `CCP_ROUTES_FILE` | Extra routes (inline JSON or a JSON file) |
| `CCP_ROUTING` | `off` disables rerouting |
| `CCP_ALLOWED_MODELS` / `CCP_REROUTE_BLOCKED_TO` | Override the allowlist |
| `CCP_SHOW_MODEL` | `off` removes the `[model: ...]` line |
| `CCP_DEBUG` | Log requests and dump each one to `$TMPDIR`. The dumps contain your prompts. |
| `CLAP_CACHE_DIR` | Where clap keeps its log and settings (default `~/.clap`) |
| `CLAP_WORKSPACE` | Directory containing `.env.global` |

## Advanced: using another proxy

- **`clap --proxy DIR`:** runs the proxy from `DIR`, which must contain
  `src/server.js`.
- **`clap --update`:** clones the original `cognition-claude-proxy` into
  `~/.clap/cognition-claude-proxy`, and from then on every `clap` run uses that clone
  instead of the bundled proxy.

The original proxy has no model routing and no allowlist. To go back to the bundled
proxy, delete `~/.clap/cognition-claude-proxy`.

## Structure

```
bin/clap                  # launcher: env, proxy lifecycle, --doctor/--routes/--setup-models
lib/proxy/src/
  server.js               # HTTP server: /v1/messages, /v1/models, /routes, /health
  translate.js            # Anthropic <-> upstream message translation
  codeium.js, proto.js    # Connect-RPC client and protobuf codec
  routing.js              # model routing and allowlist
  routes.json             # default routes
  policy.json             # default allowlist
  models.js, models.json  # model catalog (live, with a bundled snapshot)
  config.js               # API key lookup
test.js                   # npm test (not published)
```

## Development

```bash
npm test          # 48 checks; starts throwaway proxies on random ports
npm link          # use this checkout as the global clap
```

### Releasing

```bash
npm version <major|minor|patch>    # bumps package.json, commits and tags vX.Y.Z
npm publish
```

## License

MIT. See [LICENSE](LICENSE).
