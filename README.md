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
   Cursor cloud / Aider /         codex-cursor-bridge               ChatGPT-Pro
   any OpenAI client              (localhost:7711 + optional         Codex backend
                                   ngrok tunnel for Cursor)
       │                                │                              │
       │  POST /v1/chat/completions     │  POST /codex/responses       │
       │  Bearer <bridge token>         │  Bearer <codex access token> │
       │  model: bridge-fast            │  model: gpt-5.4              │
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
- A strict `bridge-*` model namespace mapping to the four real models the
  ChatGPT-Pro Codex backend currently accepts: `bridge-pro`,
  `bridge-fast`, `bridge-codex`, `bridge-mini`. See
  [Model aliases](#model-aliases) below.
- Optional `--tunnel` mode that runs an ngrok tunnel so Cursor's cloud can
  reach the bridge (Cursor BYOK proxies through Cursor's servers, not from
  your editor — see [Cursor specifics](#cursor-specifics)), with bearer-token
  auth on the public endpoint.
- On-device Cursor settings sync: when tunnel mode is on the bridge writes
  the current ngrok URL and the `bridge-*` model names into Cursor's settings
  store so you don't have to add them manually.

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

The **first** time you run it you'll see an interactive setup wizard that:

1. Checks prerequisites — Node version, the Codex CLI, `~/.codex/auth.json`,
   your ChatGPT plan, and an actual upstream probe.
2. Offers to install a LaunchAgent (macOS) so the proxy auto-starts at login.
3. Offers to wire it into Cursor — copies the base URL to your clipboard,
   opens Cursor, and prints the exact fields to paste.

Every subsequent start prints a compact "Cursor BYOK setup" card with the
URL and a 5-step checklist, so you never have to remember the magic string.

Re-run the wizard at any time with `--setup`; daemons skip it automatically
(no TTY → no prompts) and you can force-skip with `--no-setup`.

```bash
# smoke test once it's running
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
      --tunnel               Expose the bridge through ngrok so Cursor's
                             cloud can reach it (required for Cursor BYOK)
      --no-tunnel            Force localhost-only mode
      --setup                Re-run the first-run setup wizard
      --no-setup             Skip the wizard even on first run (for daemons)
  -h, --help                 Show help
  -v, --version              Show version
```

Setup state lives at `~/.codex-cursor-bridge/state.json`. Delete it (or run
`--setup`) to walk through the wizard again.

Flags take precedence over environment variables. Example: bind on a different
port temporarily:

```bash
npx codex-cursor-bridge --port 8088
```

## Model aliases

The bridge exposes a strict whitelist of model names — sending any other
name (e.g. `gpt-4o`, `gpt-3.5-turbo`, plain `gpt-5.5`) gets a `400` with the
supported list. The four aliases map 1:1 to the four model names the
ChatGPT-Pro Codex backend currently accepts:

| Bridge alias    | Upstream model    | Use when…                              |
| --------------- | ----------------- | -------------------------------------- |
| `bridge-pro`    | `gpt-5.5`         | flagship — best for hard tasks         |
| `bridge-fast`   | `gpt-5.4`         | quicker, slightly smaller              |
| `bridge-codex`  | `gpt-5.3-codex`   | the Codex-tuned variant                |
| `bridge-mini`   | `gpt-5.2`         | cheapest / fastest                     |

**Why opaque names instead of `bridge-gpt-5.5` etc.?** Cursor's cloud does
a substring match on model names — anything containing `gpt-5.5` is treated
as their premium SKU and routed through their managed service regardless
of your BYOK URL (the request never reaches this bridge; you see "User
Provided API Key Rate Limit Exceeded"). Opaque names like `bridge-pro`
don't match any of Cursor's reserved patterns, so they pass cleanly through
to BYOK. See [Cursor specifics](#cursor-specifics) for the full mechanics.

> Earlier releases used `bridge-gpt-5.5` etc. Those are no longer accepted.
> The wizard's auto-config cleans the old names out of Cursor's settings
> store automatically. If you don't use the wizard, remove them from
> Cursor → Settings → Models → "Add Model".

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

## Cursor specifics

Cursor BYOK does **not** dial your base URL from the editor. The request is
sent to Cursor's cloud, which then forwards it on to whatever URL you set.
That has two consequences:

- **A localhost base URL is unreachable.** Cursor's cloud cannot route to
  `http://127.0.0.1:...` on your machine. You need a public URL — `--tunnel`
  spins up an ngrok tunnel for exactly this.
- **Cursor cherry-picks which model names go through BYOK.** Its branded
  premium SKUs (`gpt-5.5`, the Composer family, Claude, etc.) bypass BYOK
  and use Cursor's own routing — you'll see a "User Provided API Key Rate
  Limit Exceeded" error if you try them. The routing decision uses
  substring matching: even `bridge-gpt-5.5` would be premium-hijacked
  because it contains `gpt-5.5`. The bridge's opaque aliases
  (`bridge-pro`, `bridge-fast`, `bridge-codex`, `bridge-mini`) sidestep
  this entirely.

### One-time setup

```bash
# 1. install ngrok and authenticate it (free account is fine):
brew install --cask ngrok       # or: https://ngrok.com/download
ngrok config add-authtoken <YOUR_TOKEN>

# 2. launch the bridge with the wizard — say YES to tunnel mode:
npx codex-cursor-bridge --setup
```

The wizard will:

1. Verify your Codex CLI auth.
2. Start an ngrok tunnel, generate a `sk-bridge-<…>` bearer token, persist it.
3. Patch your Cursor settings on-device: set the OpenAI base URL to the
   tunnel URL and add the four `bridge-*` model aliases to Cursor's "Add
   Model" list.
4. Open Cursor and copy the tunnel URL to your clipboard.

Then in Cursor:

1. `Cmd+,` → **Cursor Settings** → **Models** tab.
2. **OpenAI API Key**: paste the `sk-bridge-…` token from the startup card.
   (We can't write secrets to Cursor's keychain — this is the one thing
   that stays manual.)
3. Click **Verify**.
4. Pick `bridge-pro` (or any other `bridge-*` alias) in the model picker.

**If you fully quit and reopen Cursor after running the wizard**, the auto-
configured settings show up. If Cursor was running while the wizard ran, it
may overwrite our changes with its in-memory copy on next save — fully
quit (`Cmd+Q`, not just close the window) and reopen.

### Daily operation

Each restart of the bridge spawns a new ngrok URL (free tier rotates the
domain). The bridge auto-patches Cursor's settings with the new URL every
time, so you don't have to touch the BYOK config again as long as Cursor
isn't running when the bridge restarts.

For a stable URL, configure an ngrok reserved domain (paid plan) or use a
different tunneling provider (cloudflared, Tailscale Funnel — adapter would
welcome a PR).

> **Note:** Cursor's autonomous Composer agent uses Cursor's own models —
> BYOK only feeds the chat panel and the manual model selector. This proxy
> replaces the *OpenAI* bill, not Cursor's subscription.

## Configuration

CLI flags (above) cover the common knobs. Everything else is via env vars,
which is also how the LaunchAgent / systemd unit set values:

| Variable                | CLI flag         | Default                         | Meaning                                     |
| ----------------------- | ---------------- | ------------------------------- | ------------------------------------------- |
| `CODEX_BRIDGE_PORT`     | `--port`         | `7711`                          | TCP port to listen on                       |
| `CODEX_BRIDGE_HOST`     | `--host`         | `127.0.0.1`                     | Bind address                                |
| `CODEX_AUTH_PATH`       | `--auth-path`    | `~/.codex/auth.json`            | Path to the Codex auth file                 |
| `CODEX_CLIENT_VERSION`  | _(none)_         | `0.131.0`                       | `version` header sent upstream              |
| `CODEX_ORIGINATOR`      | _(none)_         | `codex_cli_rs`                  | `originator` header sent upstream           |
| `CODEX_CLIENT_ID`       | _(none)_         | `app_EMoamEEZ73f0CkXaXp7hrann`  | OAuth client_id used during token refresh   |
| `CODEX_BRIDGE_DEBUG`    | _(none)_         | _unset_                         | Set to `1` to log incoming request bodies   |

## Endpoints

| Method | Path                    | Notes                                       |
| ------ | ----------------------- | ------------------------------------------- |
| `GET`  | `/healthz`              | Liveness probe                              |
| `GET`  | `/v1/models`            | OpenAI-style model list (aliases)           |
| `POST` | `/v1/chat/completions`  | OpenAI Chat Completions, translated         |
| `POST` | `/v1/responses`         | Raw Responses API passthrough               |

## How it works

1. **Model resolution.** Incoming `model` is checked against the
   [`bridge-*` whitelist](#model-aliases). Unknown names get a `400`; known
   ones are mapped to the upstream-accepted name (e.g. `bridge-fast` →
   `gpt-5.4`).
2. **Auth lookup.** On each request the proxy reads `~/.codex/auth.json`:
   - `tokens.access_token` — short-lived JWT, `chatgpt_plan_type=pro`/`plus`.
   - `tokens.account_id` — sent as `chatgpt-account-id` header.
3. **Body translation.**
   - `messages` → `input` (with `input_text`/`input_image` parts).
   - Cursor-style `input` arrays pass through.
   - `system`/`developer` messages → top-level `instructions`.
   - `tools` → Responses-API-shaped function tools.
   - Tool call results (`role: "tool"`) → `function_call_output` items.
   - `max_tokens`/`user` are dropped (upstream rejects them).
4. **Forward.** `POST https://chatgpt.com/backend-api/codex/responses` with
   the Codex-flavoured headers (`originator`, `version`, `User-Agent`,
   `OpenAI-Beta: responses=experimental`).
5. **Response translation.** The upstream SSE stream is re-emitted as
   `chat.completion.chunk` events
   (`response.output_text.delta` → `delta.content`,
   `response.function_call_arguments.delta` → `delta.tool_calls[].function.arguments`).
6. **Refresh on 401.** Concurrent 401s are coalesced into a single OAuth
   refresh against `auth.openai.com`; the new token is atomically written
   back to `auth.json` with `0600`.
7. **Tunnel + auth.** With `--tunnel`, an ngrok subprocess is spawned, the
   public URL is read from ngrok's local admin API at `:4040`, and
   `Authorization: Bearer <sk-bridge-…>` is required on `/v1/*`.
8. **Cursor sync.** With tunnel mode on, the bridge writes the new ngrok URL
   and the `bridge-*` model names into Cursor's settings DB at
   `<appdata>/Cursor/User/globalStorage/state.vscdb` so the user doesn't have
   to add them by hand on each restart.

## Use it from other clients

Anything that speaks OpenAI works:

**OpenAI SDK (Node):**

```js
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://127.0.0.1:7711/v1',
  apiKey: 'sk-bridge', // any non-empty value when no --tunnel; else the generated token
});
const r = await client.chat.completions.create({
  model: 'bridge-fast',
  messages: [{ role: 'user', content: 'hi' }],
});
```

**Aider / Continue / Open Interpreter / etc.** — set their OpenAI base URL
to `http://127.0.0.1:7711/v1`, model to one of the `bridge-*` aliases, and
API key to any non-empty value (or the bridge token when running with
`--tunnel`).

## Limitations & known gotchas

- **Four models only.** The ChatGPT-subscription Codex backend currently
  accepts `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.2`. No Claude, no
  o-series, no fine-tuned models. Use the `bridge-*` aliases.
- **No quota dashboard.** ChatGPT Pro has soft Codex limits; exceed them
  and upstream will return 429s. There's no programmatic way to inspect
  remaining quota.
- **Cursor's agent.** Cursor's Composer agent uses Cursor's own models —
  BYOK only feeds the chat panel and the manual model selector.
- **Cursor BYOK URL ≠ localhost.** Cursor's cloud forwards BYOK calls, so
  the bridge needs a public URL (see `--tunnel`). The free ngrok tier
  rotates the URL each restart.
- **Cursor reserves the bare `gpt-5.5` name** (and substring-matches it,
  so `bridge-gpt-5.5` also gets premium-hijacked). Use `bridge-pro`.
- **Public exposure with `--tunnel`.** Anyone who learns both the ngrok URL
  and the bridge token can spend your quota. The bridge generates a random
  per-install token, but treat the pair as sensitive.
- **Token expiry.** The Codex access token typically lasts ~10 days.
  Refresh is automatic against `auth.openai.com`; if the refresh token
  itself expires, run `codex login`.

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
