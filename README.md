# codex-cursor-bridge

> Use your **ChatGPT Pro / Plus** subscription to power **Cursor** (or any
> OpenAI-API-compatible tool), instead of paying separately for OpenAI API
> credits.

A small zero-npm-dependency Node CLI. It accepts OpenAI-style
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
- Tool / function calling (translated both ways), multi-turn conversations
  with correct `input_text`/`output_text` content-part shaping per role
- A passthrough `/v1/responses` if a client speaks the Responses API directly
- Automatic OAuth refresh against `auth.openai.com` (atomic + `0o600`
  on `auth.json`; concurrent 401s are coalesced into one refresh)
- A strict `bridge-*` model namespace covering all four upstream-accepted
  models. The flagship (`gpt-5.5`) splits into six reasoning × routing
  variants (`bridge-pro-medium`, `-high`, `-xhigh`, plus `-fast` siblings)
  so you can pick depth/speed straight from the model picker; the smaller
  three (`bridge-fast`, `bridge-codex`, `bridge-mini`) ship as single
  aliases. See [Model aliases](#model-aliases) below.
- Optional `--tunnel` mode that runs an ngrok tunnel so Cursor's cloud can
  reach the bridge (Cursor BYOK proxies through Cursor's servers, not from
  your editor — see [Cursor specifics](#cursor-specifics)), with bearer-token
  auth on the public endpoint.
- On-device Cursor settings sync: when tunnel mode is on the bridge writes
  the current ngrok URL into `openAIBaseUrl`, registers the four `bridge-*`
  aliases under `aiSettings.userAddedModels`, and **auto-checks them** in
  `aiSettings.modelOverrideEnabled` so they're enabled in the picker on
  next launch.
- An interactive first-run setup wizard with prerequisite checks (Node,
  codex CLI, valid auth, live upstream probe) and an always-on startup
  card that shows the exact alias → upstream-model mapping plus the
  fields to paste into Cursor.

## Status

Published on npm as
[`codex-cursor-bridge`](https://www.npmjs.com/package/codex-cursor-bridge).
First public release is v1.0.0.

## Prerequisites

1. **A ChatGPT Pro or Plus subscription.** Free accounts won't work — the
   Codex backend rejects them.
2. **Node.js 22.5 or newer.** Zero npm dependencies; the bridge uses
   `node:sqlite` (built in since 22.5, stable in 24+) for Cursor's settings
   sync, plus the rest of the Node standard library.
3. **Codex CLI, logged in.** Install from <https://github.com/openai/codex>
   (or the desktop app at <https://chatgpt.com/codex>) and run `codex login`.
   That writes `~/.codex/auth.json`, which this proxy reads.
4. **Only if you're using Cursor:** [ngrok](https://ngrok.com/download)
   installed and an authtoken configured (`ngrok config add-authtoken …`).
   Cursor BYOK can't dial localhost, so the bridge needs a public URL — see
   [Cursor specifics](#cursor-specifics). Skip if you're using Aider /
   Continue / Open Interpreter / the OpenAI SDK directly.

Verify the prerequisites:

```bash
node --version                                          # need v22.5+
test -f ~/.codex/auth.json && echo "auth present" || echo "run: codex login"
command -v ngrok >/dev/null && ngrok config check       # only for Cursor
```

## Quick start

If you've already run `codex login`, this is the whole thing:

```bash
npx codex-cursor-bridge
```

The **first** time you run it you'll see an interactive setup wizard that:

1. Checks prerequisites — Node version, the Codex CLI, `~/.codex/auth.json`,
   your ChatGPT plan, and a live upstream probe.
2. Asks whether to enable [tunnel mode](#cursor-specifics) (required for
   Cursor, optional otherwise) and verifies ngrok.
3. Offers to install a LaunchAgent (macOS) so the proxy auto-starts at login.
4. With tunnel mode on, patches Cursor's on-device settings, copies the
   tunnel URL to your clipboard, and opens Cursor.

Every subsequent start prints a compact card with the live base URL,
generated bearer token (in tunnel mode), and an alias→model table:

```
── Cursor BYOK setup ──────────────────────────────────────
  1. Cmd+, (or Ctrl+,) → Cursor Settings → Models
  2. "OpenAI API Key":  sk-bridge-...
  3. Toggle "Override OpenAI Base URL" on
  4. Base URL:  https://<your-ngrok>.ngrok-free.dev/v1
  5. In the model picker pick one of (alias → real model):
       bridge-pro-medium       →  gpt-5.5         medium reasoning
       bridge-pro-high         →  gpt-5.5         high reasoning (recommended)
       bridge-pro-xhigh        →  gpt-5.5         extra-high reasoning
       bridge-pro-medium-fast  →  gpt-5.5         medium · fast (best-effort)
       bridge-pro-high-fast    →  gpt-5.5         high · fast (best-effort)
       bridge-pro-xhigh-fast   →  gpt-5.5         extra-high · fast (best-effort)
       bridge-fast             →  gpt-5.4         quicker, slightly smaller
       bridge-codex            →  gpt-5.3-codex   Codex-tuned variant
       bridge-mini             →  gpt-5.2         cheapest / fastest
───────────────────────────────────────────────────────────
```

Re-run the wizard at any time with `--setup`; daemons skip it automatically
(no TTY → no prompts) and you can force-skip with `--no-setup`.

Smoke test once it's running:

```bash
curl http://127.0.0.1:7711/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"bridge-fast","messages":[{"role":"user","content":"say hi"}],"stream":false}'
```

> Anything other than the four `bridge-*` aliases gets a `400` with the
> supported list. See [Model aliases](#model-aliases).

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
supported list. The aliases map to the four model names the ChatGPT-Pro
Codex backend currently accepts, with the flagship (`gpt-5.5`) split into
six reasoning × routing variants so you can pick a depth/speed tradeoff
directly from Cursor's model picker:

| Bridge alias                | Upstream model    | Reasoning   | Fast | Notes                              |
| --------------------------- | ----------------- | ----------- | ---- | ---------------------------------- |
| `bridge-pro-medium`         | `gpt-5.5`         | medium      | no   | quick gpt-5.5                      |
| `bridge-pro-high`           | `gpt-5.5`         | high        | no   | **recommended default**            |
| `bridge-pro-xhigh`          | `gpt-5.5`         | xhigh       | no   | deepest reasoning, ~2.5× slower    |
| `bridge-pro-medium-fast`    | `gpt-5.5`         | medium      | yes  | medium + best-effort fast routing  |
| `bridge-pro-high-fast`      | `gpt-5.5`         | high        | yes  | high + best-effort fast routing    |
| `bridge-pro-xhigh-fast`     | `gpt-5.5`         | xhigh       | yes  | xhigh + best-effort fast routing   |
| `bridge-fast`               | `gpt-5.4`         | (default)   | no   | quicker, slightly smaller          |
| `bridge-codex`              | `gpt-5.3-codex`   | (default)   | no   | Codex-tuned variant                |
| `bridge-mini`               | `gpt-5.2`         | (default)   | no   | cheapest / fastest                 |

**About reasoning effort.** The bridge sends `reasoning: { effort: <level> }`
to upstream. Empirically all four levels (`low`/`medium`/`high`/`xhigh`)
are accepted; we don't expose `low`. Higher effort → more reasoning tokens
→ noticeably slower (xhigh was ~2.5× the wall time of high in our probes).

**About `fast`.** The bridge sends `service_tier: priority` on `*-fast`
aliases. The upstream validator accepts it, but for ChatGPT-Pro accounts
the server response echoes `service_tier: auto`, suggesting it may be
normalized back. Treat `fast` as a hint, not a guarantee — if it stops
mattering empirically we'll drop the variants in a future release.

**Why opaque names instead of `bridge-gpt-5.5-xhigh` etc.?** Cursor's cloud
does a substring match on model names — anything containing `gpt-5.5` is
treated as their premium SKU and routed through their managed service
regardless of your BYOK URL (the request never reaches this bridge; you
see "User Provided API Key Rate Limit Exceeded"). Opaque names like
`bridge-pro-high` don't match any of Cursor's reserved patterns, so they
pass cleanly through to BYOK. See
[Cursor specifics](#cursor-specifics) for the full mechanics.

> Earlier releases used `bridge-gpt-5.5` (≤1.0.0) and `bridge-pro` (1.0.x).
> Both are now rejected. The wizard's auto-config cleans the old names out
> of Cursor's settings store automatically. If you don't use the wizard,
> remove them from Cursor → Settings → Models → "Add Model".

## Cursor specifics

Cursor BYOK does **not** dial your base URL from the editor. The request is
sent to Cursor's cloud, which then forwards it on to whatever URL you set.
Three consequences:

- **A localhost base URL is unreachable.** Cursor's cloud cannot route to
  `http://127.0.0.1:...` on your machine. You need a public URL — `--tunnel`
  spins up an ngrok tunnel for exactly this.
- **Cursor cherry-picks which model names go through BYOK.** Its branded
  premium SKUs (`gpt-5.5`, the Composer family, Claude, etc.) bypass BYOK
  and use Cursor's own routing — you'll see a "User Provided API Key Rate
  Limit Exceeded" error if you try them. The routing decision uses
  substring matching: even `bridge-gpt-5.5` or `bridge-gpt-5.5-xhigh`
  would be premium-hijacked because they contain `gpt-5.5`. The bridge's
  opaque aliases (`bridge-pro-*`, `bridge-fast`, `bridge-codex`,
  `bridge-mini`) sidestep this entirely.
- **Cursor's running instance wipes BYOK settings on refresh.** If Cursor
  is open while the bridge writes to its settings store, the changes are
  reverted within seconds when Cursor next syncs its in-memory copy back to
  disk. The bridge detects this and refuses to write — see below.

> ⚠️ **Fully quit Cursor (`Cmd+Q`, not just close the window) before running
> the bridge with `--tunnel`.** Auto-config of `openAIBaseUrl` and the
> `bridge-*` aliases only sticks while Cursor is not running. The bridge
> will print a loud notice if it detects Cursor and skip the sync.

### One-time setup

```bash
# 1. Install ngrok and authenticate (free account is fine):
brew install --cask ngrok       # or: https://ngrok.com/download
ngrok config add-authtoken <YOUR_TOKEN>

# 2. Fully quit Cursor (Cmd+Q).

# 3. Launch the bridge with the wizard — say YES to tunnel mode:
npx codex-cursor-bridge --setup
```

The wizard will:

1. Verify your Codex CLI auth and probe the upstream.
2. Start an ngrok tunnel, generate a `sk-bridge-<…>` bearer token, persist
   it in `~/.codex-cursor-bridge/state.json`.
3. Patch Cursor's settings on-device:
   - Set `openAIBaseUrl` to the current ngrok URL
   - Add the four `bridge-*` aliases to `aiSettings.userAddedModels`
   - Auto-check them in `aiSettings.modelOverrideEnabled`
   - Remove any legacy `bridge-gpt-*` names from earlier releases
4. Copy the tunnel URL to your clipboard and open Cursor.

Then in Cursor:

1. `Cmd+,` → **Cursor Settings** → **Models** tab.
2. **OpenAI API Key**: paste the `sk-bridge-…` token from the startup card.
   This is the one thing we can't auto-fill — Cursor stores it as a secret
   that lives outside the settings DB we patch.
3. Click **Verify**. (URL + aliases are already wired up.)
4. Pick `bridge-pro-high` (recommended default) or any other alias in the
   model picker. It should already be checked thanks to the auto-config.

### Daily operation

Each restart of the bridge spawns a new ngrok URL (free tier rotates the
domain). The bridge auto-patches Cursor's settings with the new URL on
every start — so the workflow is:

1. Cmd+Q Cursor.
2. Restart the bridge (Ctrl+C → re-run, or via the daemon below).
3. Open Cursor; the new URL is already configured.

For a stable URL, configure an ngrok reserved domain (paid plan) or use a
different tunneling provider (cloudflared, Tailscale Funnel — adapter PR
welcome).

> **Note:** Cursor's autonomous Composer agent uses Cursor's own models —
> BYOK only feeds the chat panel and the manual model selector. This proxy
> replaces the *OpenAI* bill, not Cursor's subscription.

## Run it on login

### macOS (LaunchAgent)

From a clone of the repo:

```bash
npm run install-launchd        # or: bash scripts/install-launchd.sh
```

This writes `~/Library/LaunchAgents/com.user.codex-cursor-bridge.plist`,
loads it via `launchctl`, and verifies the health endpoint. The daemon
runs with stdin closed (so the wizard auto-skips) and reads the persisted
state — including whether tunnel mode is on. To uninstall:

```bash
npm run uninstall-launchd
```

If you're running an npm-global install (not a clone), the LaunchAgent
installer refuses to point at the global path because npm may relocate it
on upgrade. Either keep a clone around for the daemon, or write your own
plist pointing at a stable bin path.

### Linux (systemd)

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
   [`bridge-*` whitelist](#model-aliases). Unknown names get a `400` with
   the supported list; known ones are mapped to the upstream-accepted name
   (e.g. `bridge-fast` → `gpt-5.4`).
2. **Auth lookup.** On each request the proxy reads `~/.codex/auth.json`:
   - `tokens.access_token` — short-lived JWT, `chatgpt_plan_type=pro`/`plus`.
   - `tokens.account_id` — sent as `chatgpt-account-id` header.
3. **Body translation.** Either path (chat completions or Responses API)
   normalizes the request into the Codex Responses shape:
   - `messages` → `input` items, or `input` arrays pass through.
   - `system` / `developer` messages → top-level `instructions`.
   - Content parts are reshaped per role:
     `role: 'user'` → `input_text` / `input_image`,
     `role: 'assistant'` → `output_text` / `refusal`.
     (The Codex backend rejects mismatched part types with
     `Invalid value: 'input_text'`, etc.)
   - `tools` → Responses-API-shaped function tools.
   - Tool call results (`role: 'tool'`) → `function_call_output` items.
   - `max_tokens` / `max_completion_tokens` / `max_output_tokens` / `user`
     are dropped — upstream rejects them with "Unsupported parameter".
4. **Forward.** `POST https://chatgpt.com/backend-api/codex/responses` with
   the Codex-flavoured headers (`originator`, `version`, `User-Agent`,
   `OpenAI-Beta: responses=experimental`). Body size is capped at 8 MiB.
5. **Response translation.** The upstream SSE stream is re-emitted as
   `chat.completion.chunk` events:
   - `response.output_text.delta` → `choices[0].delta.content`
   - `response.function_call_arguments.delta` → `choices[0].delta.tool_calls[].function.arguments`
   - `response.completed` → terminal chunk with `finish_reason` +
     `data: [DONE]`
6. **Refresh on 401.** Concurrent 401s are coalesced into a single OAuth
   refresh against `auth.openai.com`; the new token is atomically written
   back to `auth.json` with `0o600` (preserves Codex's own permissions).
7. **Tunnel + auth.** With `--tunnel`, an ngrok subprocess is spawned, the
   public URL is read from ngrok's local admin API at `:4040`, and
   `Authorization: Bearer <sk-bridge-…>` is required on `/v1/*`. The token
   is generated once and persisted in `~/.codex-cursor-bridge/state.json`.
8. **Cursor sync.** When tunnel mode is on AND Cursor is fully quit, the
   bridge opens
   `<appdata>/Cursor/User/globalStorage/state.vscdb` via `node:sqlite` and
   updates three fields inside the
   `…reactivestorage…persistentStorage.applicationUser` blob:
   - `openAIBaseUrl` → current ngrok URL
   - `aiSettings.userAddedModels` ← bridge aliases (deduped, legacy
     `bridge-gpt-*` names removed)
   - `aiSettings.modelOverrideEnabled` ← same aliases, so they're checked
     in the picker on next launch
9. **Per-request logging.** One short line per non-health request with
   method, path, status (colored), latency, model, msg count, tool count,
   and stream chunk count. `/healthz` is silenced.

## Use it from other clients

Anything that speaks OpenAI works. Non-Cursor clients (Aider, Continue,
Cline, Open Interpreter, raw SDKs) talk to the bridge directly and don't
need `--tunnel` — they can hit `http://127.0.0.1:7711/v1` straight from
your machine.

**OpenAI SDK (Node):**

```js
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://127.0.0.1:7711/v1',
  // No --tunnel  → any non-empty string; the bridge doesn't authenticate
  //                localhost callers.
  // With --tunnel → the sk-bridge-… token from ~/.codex-cursor-bridge/state.json
  apiKey: 'sk-anything',
});
const r = await client.chat.completions.create({
  model: 'bridge-fast',
  messages: [{ role: 'user', content: 'hi' }],
});
```

**Aider / Continue / Cline / Open Interpreter / etc.** — set their OpenAI
base URL to `http://127.0.0.1:7711/v1`, model to one of the `bridge-*`
aliases, and API key to anything non-empty. Skip `--tunnel`.

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
  so `bridge-gpt-5.5` also gets premium-hijacked). Use the `bridge-pro-*`
  variants.
- **Public exposure with `--tunnel`.** Anyone who learns both the ngrok URL
  and the bridge token can spend your quota. The bridge generates a random
  per-install token, but treat the pair as sensitive.
- **Localhost mode is unauthenticated.** Without `--tunnel`, any process
  on your machine that can reach `127.0.0.1:7711` can hit the bridge. If
  that matters, use `--tunnel` (which adds bearer auth) or firewall the
  port.
- **Token expiry.** The Codex access token typically lasts ~10 days.
  Refresh is automatic against `auth.openai.com`; if the refresh token
  itself expires, run `codex login`.
- **Node 22.5+ required.** The Cursor settings sync uses `node:sqlite`,
  which is gated on Node 22.5+ (and stable in Node 24). The bridge fails
  to start on Node 20 even if you never use `--tunnel`.

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
