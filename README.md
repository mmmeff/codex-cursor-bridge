# codex-cursor-bridge

> Use your **ChatGPT Pro / Plus** subscription to power **Cursor** (or any
> OpenAI-API-compatible tool), instead of paying separately for OpenAI API
> credits.

A tiny zero-dependency Node proxy. It accepts OpenAI-style
`/v1/chat/completions` requests on `localhost`, translates them to the
**Responses API**, and forwards them to the same backend the official
[`codex` CLI](https://github.com/openai/codex) uses
(`https://chatgpt.com/backend-api/codex/responses`). Authentication is the
ChatGPT-OAuth token that `codex login` already wrote to `~/.codex/auth.json`,
so usage is billed against your ChatGPT subscription rather than the metered
API.

```
   Cursor / curl / any            codex-cursor-bridge                 OpenAI
   OpenAI client                  (localhost:7711)
       │                                │                              │
       │  POST /v1/chat/completions     │  POST /codex/responses       │
       │  Bearer <anything>             │  Bearer <codex access token> │
       ├───────────────────────────────►├─────────────────────────────►│
       │                                │  Authorization: Bearer ...   │
       │                                │  chatgpt-account-id: ...     │
       │                                │                              │
       │◄────  SSE chat.completion.chunk◄─── SSE response.* events ────┤
```

## What it gives you

- A `http://127.0.0.1:7711/v1`-compatible OpenAI endpoint
- Streaming **and** non-streaming `chat/completions`
- Tool / function calling (translated both ways)
- A passthrough `/v1/responses` if a client speaks the Responses API directly
- Automatic OAuth refresh against `auth.openai.com` when the access token expires
- One model: `gpt-5.5` (the only one the ChatGPT-subscription Codex backend allows).
  Common names like `gpt-4o`, `gpt-4`, `gpt-4-turbo`, `gpt-4o-mini`, `gpt-5`
  are aliased to it so existing clients work without code changes.

## Prerequisites

1. **A ChatGPT Pro or Plus subscription.** Free accounts won't work — the
   Codex backend rejects them.
2. **Node.js 20+.** Zero npm dependencies; only the standard library is used.
3. **Codex CLI, logged in.** Install from <https://github.com/openai/codex>
   (or the desktop app at <https://chatgpt.com/codex>) and run `codex login`.
   That writes `~/.codex/auth.json`, which this proxy reads.

Verify the prerequisite:

```bash
test -f ~/.codex/auth.json && echo "auth present" || echo "run: codex login"
```

## Quick start

If you've already run `codex login`, this is the whole thing:

```bash
npx codex-cursor-bridge
```

You should see:

```
codex-cursor-bridge listening at http://127.0.0.1:7711/v1
  auth source: /Users/you/.codex/auth.json
  upstream model: gpt-5.5
```

Smoke test it:

```bash
curl http://127.0.0.1:7711/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"say hi"}],"stream":false}'
```

> **Not on npm yet?** Until the package is published you can pull the CLI
> straight from this repo with the same command shape:
> ```bash
> npx github:mmmeff/codex-cursor-bridge
> ```

## Install

A few other ways to run it:

```bash
# Global install (then just run `codex-cursor-bridge`)
npm install -g codex-cursor-bridge
codex-cursor-bridge

# From a clone
git clone https://github.com/mmmeff/codex-cursor-bridge.git
cd codex-cursor-bridge
node server.mjs
```

### CLI flags

```
codex-cursor-bridge [options]

  -p, --port <port>          Port to listen on (default: 7711)
      --host <host>          Bind address (default: 127.0.0.1)
  -a, --auth-path <path>     Codex auth file (default: ~/.codex/auth.json)
  -m, --model <id>           Upstream model id (default: gpt-5.5)
  -h, --help                 Show help
  -v, --version              Show version
```

Flags take precedence over environment variables. Example: bind on a different
port temporarily:

```bash
npx codex-cursor-bridge --port 8088
```

### Run it on login (macOS)

From a clone of the repo:

```bash
npm run install-launchd        # or: bash scripts/install-launchd.sh
```

This writes `~/Library/LaunchAgents/com.user.codex-cursor-bridge.plist`,
loads it via `launchctl`, and verifies the health endpoint. To uninstall:

```bash
npm run uninstall-launchd
```

### Run it on login (Linux, systemd)

Create `~/.config/systemd/user/codex-cursor-bridge.service`:

```ini
[Unit]
Description=codex-cursor-bridge
After=network-online.target

[Service]
ExecStart=/usr/bin/node /absolute/path/to/codex-cursor-bridge/server.mjs
Environment=CODEX_BRIDGE_PORT=7711
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now codex-cursor-bridge
```

## Wire it into Cursor

1. Open Cursor → `Cmd+,` → **Cursor Settings** → **Models** tab.
2. Scroll to **OpenAI API Key**. Paste anything (e.g. `sk-bridge`). The proxy
   does not validate it.
3. Toggle **Override OpenAI Base URL** on. Set it to:
   ```
   http://127.0.0.1:7711/v1
   ```
4. Click **Verify**. It should succeed.
5. In the model list, enable any OpenAI model (`gpt-4o` is a safe default).
   All of them route to `gpt-5.5` under the hood.

> **Note:** Cursor's autonomous Composer agent uses Cursor's own models — BYOK
> only feeds the chat panel and the manual model selector. This proxy
> replaces the *OpenAI* bill, not Cursor's subscription.

## Configuration

CLI flags (above) cover the common knobs. Everything else is via env vars,
which is also how the LaunchAgent / systemd unit set values:

| Variable                | CLI flag         | Default                         | Meaning                                     |
| ----------------------- | ---------------- | ------------------------------- | ------------------------------------------- |
| `CODEX_BRIDGE_PORT`     | `--port`         | `7711`                          | TCP port to listen on                       |
| `CODEX_BRIDGE_HOST`     | `--host`         | `127.0.0.1`                     | Bind address                                |
| `CODEX_AUTH_PATH`       | `--auth-path`    | `~/.codex/auth.json`            | Path to the Codex auth file                 |
| `CODEX_MODEL`           | `--model`        | `gpt-5.5`                       | Real upstream model                         |
| `CODEX_CLIENT_VERSION`  | _(none)_         | `0.131.0`                       | `version` header sent upstream              |
| `CODEX_ORIGINATOR`      | _(none)_         | `codex_cli_rs`                  | `originator` header sent upstream           |
| `CODEX_CLIENT_ID`       | _(none)_         | `app_EMoamEEZ73f0CkXaXp7hrann`  | OAuth client_id used during token refresh   |

## Endpoints

| Method | Path                    | Notes                                       |
| ------ | ----------------------- | ------------------------------------------- |
| `GET`  | `/healthz`              | Liveness probe                              |
| `GET`  | `/v1/models`            | OpenAI-style model list (aliases)           |
| `POST` | `/v1/chat/completions`  | OpenAI Chat Completions, translated         |
| `POST` | `/v1/responses`         | Raw Responses API passthrough               |

## How it works

1. On each request, the proxy reads `~/.codex/auth.json` and pulls:
   - `tokens.access_token` — a short-lived JWT whose `aud` is
     `https://api.openai.com/v1` and whose claims include
     `chatgpt_plan_type=pro`.
   - `tokens.account_id` — sent as `chatgpt-account-id` header.
2. The request body is translated:
   - `messages` → `input` (with `input_text` / `input_image` parts).
   - `system` / `developer` messages → top-level `instructions`.
   - `tools` → Responses-API-shaped function tools.
   - Tool call results (`role: "tool"`) → `function_call_output` items.
3. The proxy POSTs to `https://chatgpt.com/backend-api/codex/responses` with
   the Codex-flavoured headers (`originator`, `version`, `User-Agent`,
   `OpenAI-Beta: responses=experimental`).
4. The SSE response is parsed and re-emitted as `chat.completion.chunk`
   events, with `response.output_text.delta` → `delta.content` and
   `response.function_call_arguments.delta` → `delta.tool_calls[].function.arguments`.
5. If upstream returns `401`, the proxy refreshes the access token at
   `https://auth.openai.com/oauth/token` using the stored `refresh_token`,
   writes it back to `auth.json`, and retries once.

## Use it from other clients

Anything that speaks OpenAI works:

**OpenAI SDK (Node):**

```js
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://127.0.0.1:7711/v1',
  apiKey: 'sk-bridge', // ignored by the proxy
});
const r = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
});
```

**Aider / Continue / Open Interpreter / etc.** — set their OpenAI base URL
to `http://127.0.0.1:7711/v1` and any non-empty API key.

## Limitations & known gotchas

- **Only one real model.** The ChatGPT-subscription Codex backend only allows
  `gpt-5.5`. No Claude, no o-series, no fine-tuned models.
- **No quota dashboard.** ChatGPT Pro has soft Codex limits; exceed them and
  upstream will return 429s. There is currently no programmatic way to
  inspect remaining quota.
- **Cursor's agent.** Cursor's Composer agent uses Cursor's own models, not
  BYOK. The bridge only powers chat / manual model selection.
- **Single user, localhost.** The proxy binds to `127.0.0.1` by default. Do
  not expose it to a network — anyone who can reach the port can spend your
  ChatGPT quota.
- **Token expiry.** The access token typically lasts ~10 days. Refresh is
  automatic, but if the refresh token itself ever expires you'll need to run
  `codex login` again.

## Terms of service

This is a personal-use workaround. It uses the same auth flow the official
`codex` CLI uses; whether OpenAI considers that fair use from a non-Codex
client is a gray area. If you need formal sanction, use the OpenAI API
instead. Don't run this for other people, and don't expose it beyond
localhost.

## Contributing

Patches welcome — particularly:

- Better error mapping (rate limits, content filters)
- Image / vision input fidelity
- A `claude`-style `messages` adapter for Anthropic-API clients
- Quota / usage observability
- Cross-platform install scripts

## License

[MIT](./LICENSE)
