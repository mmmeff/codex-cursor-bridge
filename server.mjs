#!/usr/bin/env node
// codex-cursor-bridge
// Expose a ChatGPT-Pro/Plus-backed Codex Responses API as an OpenAI-compatible
// chat-completions endpoint, so tools like Cursor can use it for "Bring Your
// Own Key" without paying for separate OpenAI API credits.
//
// Reads ~/.codex/auth.json for the Codex CLI's ChatGPT access token + account
// id. On 401, attempts an OAuth refresh against auth.openai.com using the
// stored refresh_token. Requests go to https://chatgpt.com/backend-api/codex
// — the same backend the Codex CLI uses — and are billed to the user's
// ChatGPT subscription.

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  loadState,
  saveState,
  runSetupWizard,
  printStartupCard,
  shouldRunWizard,
  repoDirOf,
  copyToClipboard,
  openCursor,
} from './lib/setup.mjs';
import { startNgrokTunnel } from './lib/tunnel.mjs';
import { applyCursorConfig, isCursorRunning, cursorStateDbExists } from './lib/cursor-config.mjs';

// ---------- logging helpers ----------
//
// Hoisted up here so the top-level Cursor-auto-config block (and anything
// else above the route handlers) can use ANSI/tint without hitting a TDZ.

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};
const LOG_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const tint = (k, s) => (LOG_COLOR ? `${ANSI[k]}${s}${ANSI.reset}` : s);

function nowHMS() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function statusColor(s) {
  if (s >= 500) return 'red';
  if (s >= 400) return 'yellow';
  if (s >= 300) return 'cyan';
  return 'green';
}

function logRequest({ method, path: p, status, ms, extra = '' }) {
  const tag = tint(statusColor(status), String(status));
  const dur = `${ms.toFixed(0)}ms`;
  process.stdout.write(
    `${tint('dim', nowHMS())} ${method.padEnd(4)} ${p.padEnd(22)} → ${tag} ${tint('dim', dur)}${extra ? ' ' + extra : ''}\n`,
  );
}

function logEvent(color, message) {
  process.stdout.write(`${tint('dim', nowHMS())} ${tint(color, message)}\n`);
}

const PKG_VERSION = await loadPackageVersion();

const args = parseCli(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.version) {
  console.log(PKG_VERSION);
  process.exit(0);
}

const PORT = Number(args.port ?? process.env.CODEX_BRIDGE_PORT ?? 7711);
const HOST = args.host ?? process.env.CODEX_BRIDGE_HOST ?? '127.0.0.1';
const AUTH_PATH = args['auth-path'] ?? process.env.CODEX_AUTH_PATH ?? path.join(os.homedir(), '.codex', 'auth.json');
const UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses';
const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = process.env.CODEX_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';
const CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION || '0.131.0';
const ORIGINATOR = process.env.CODEX_ORIGINATOR || 'codex_cli_rs';

// The bridge namespace. Every supported client-facing model uses the
// `bridge-` prefix and maps to one of the four models the ChatGPT-Pro Codex
// backend currently accepts.
//
// We deliberately avoid embedding the upstream model id (especially
// `gpt-5.5`) inside the alias. Cursor's cloud appears to do a substring
// match on model names: anything containing `gpt-5.5` gets premium-routed
// through Cursor's managed service and never reaches our BYOK URL, which
// surfaces as a misleading "User Provided API Key Rate Limit Exceeded".
// Names like `bridge-pro` etc. are opaque to Cursor and pass through
// cleanly to BYOK.
//
// Unknown model names are REJECTED with 400 instead of silently rewritten.
// Per-alias upstream metadata. `reasoning` and `fast` are baked into the
// alias name so users can pick a depth/speed tradeoff straight from Cursor's
// model picker without parameter UI.
//
// `reasoning.effort` accepts low/medium/high/xhigh (probed empirically).
// `fast` maps to `service_tier: priority` on the wire — upstream accepts
// it for ChatGPT-Pro accounts but appears to normalize back to "auto" in
// the response, so treat fast as a best-effort hint rather than a guarantee.
const BRIDGE_MODEL_MAP = {
  // gpt-5.5 (flagship) — six reasoning × fast combinations.
  'bridge-pro-medium':       { upstream: 'gpt-5.5',       reasoning: 'medium', tagline: 'medium reasoning' },
  'bridge-pro-high':         { upstream: 'gpt-5.5',       reasoning: 'high',   tagline: 'high reasoning (recommended)' },
  'bridge-pro-xhigh':        { upstream: 'gpt-5.5',       reasoning: 'xhigh',  tagline: 'extra-high reasoning' },
  'bridge-pro-medium-fast':  { upstream: 'gpt-5.5',       reasoning: 'medium', fast: true, tagline: 'medium reasoning · fast (best-effort)' },
  'bridge-pro-high-fast':    { upstream: 'gpt-5.5',       reasoning: 'high',   fast: true, tagline: 'high reasoning · fast (best-effort)' },
  'bridge-pro-xhigh-fast':   { upstream: 'gpt-5.5',       reasoning: 'xhigh',  fast: true, tagline: 'extra-high reasoning · fast (best-effort)' },
  // Other ChatGPT-Pro Codex models keep their single-alias form. Reasoning
  // defaults to whatever upstream chooses (typically `medium`) unless the
  // caller passes a `reasoning` field directly.
  'bridge-fast':             { upstream: 'gpt-5.4',         tagline: 'quicker, slightly smaller' },
  'bridge-codex':            { upstream: 'gpt-5.3-codex',   tagline: 'Codex-tuned variant' },
  'bridge-mini':             { upstream: 'gpt-5.2',         tagline: 'cheapest / fastest' },
};
const BRIDGE_MODELS = Object.keys(BRIDGE_MODEL_MAP);

// Returns the full upstream descriptor for a client-facing alias, or null if
// the caller sent something we don't support. Callers should respond 400 on
// null. Use `.upstream` for the model name; `.reasoning` / `.fast` for the
// optional knobs to inject.
function resolveUpstreamModel(requested) {
  if (typeof requested !== 'string') return null;
  return BRIDGE_MODEL_MAP[requested] ?? null;
}

function unsupportedModelMessage(requested) {
  const prefix =
    requested == null || requested === ''
      ? 'missing required "model" field'
      : `unsupported model "${requested}"`;
  return (
    `${prefix}. Supported aliases: ${BRIDGE_MODELS.join(', ')}. ` +
    `See https://github.com/mmmeff/codex-cursor-bridge#model-aliases for why bridge-* is required.`
  );
}

const UA = `${ORIGINATOR}/${CLIENT_VERSION} (${platformLabel()}) bridge`;

// First-run setup wizard. The wizard may persist a tunnel preference + an
// auth_token to state.json; we read it back after.
const initialState = await loadState();
const wizardRanThisInvocation = shouldRunWizard({
  state: initialState,
  forceSetup: args.setup,
  noSetup: args['no-setup'],
});
if (wizardRanThisInvocation) {
  await runSetupWizard({
    port: PORT,
    host: HOST,
    authPath: AUTH_PATH,
    bridgeModels: BRIDGE_MODELS,
    bridgeModelMap: BRIDGE_MODEL_MAP,
    version: PKG_VERSION,
    repoDir: repoDirOf(import.meta.url),
  });
}
const state = await loadState();

// Tunnel mode: spawn ngrok and use the public URL as the public-facing base
// URL we print in the startup card. CLI flag wins over state; state wins over
// the off-by-default.
const tunnelOn = args.tunnel === true || (!args['no-tunnel'] && state.tunnel === true);

// Auth token: required ONLY when tunnel mode is on (we don't want to break
// existing localhost-only users). Stored in state.json so Cursor doesn't need
// re-pasting on every restart.
const AUTH_TOKEN = tunnelOn ? await ensureAuthToken(state) : null;

let tunnel = null;
if (tunnelOn) {
  try {
    tunnel = await startNgrokTunnel({ port: PORT });
    process.on('SIGTERM', () => tunnel?.stop());
    process.on('SIGINT', () => {
      tunnel?.stop();
      process.exit(0);
    });
  } catch (e) {
    process.stderr.write(`\nFailed to start ngrok tunnel: ${e.message}\n`);
    if (e.code === 'NGROK_NOT_FOUND') {
      process.stderr.write('Install ngrok: https://ngrok.com/download (or `brew install --cask ngrok`)\n');
    } else if (e.code === 'NGROK_NO_AUTHTOKEN') {
      process.stderr.write('Configure your ngrok authtoken: `ngrok config add-authtoken <YOUR_TOKEN>`\n');
      process.stderr.write('Get one (free) at https://dashboard.ngrok.com/get-started/your-authtoken\n');
    }
    process.exit(1);
  }
}

printStartupCard({
  port: PORT,
  host: HOST,
  authPath: AUTH_PATH,
  bridgeModelMap: BRIDGE_MODEL_MAP,
  version: PKG_VERSION,
  publicUrl: tunnel?.url,
  authToken: AUTH_TOKEN,
});

// When tunnel mode is on, sync Cursor's on-device settings store so the user
// doesn't have to re-paste a fresh ngrok URL or add each bridge-* model by
// hand. Best-effort — failures are logged but never fatal.
//
// IMPORTANT: Cursor overwrites userAddedModels with its in-memory copy on
// every refresh. If Cursor is running while we write, our changes are
// silently undone within seconds. We warn loudly and refuse to silently
// proceed; the user has to fully quit Cursor and re-run.
//
// Stale aliases from earlier releases get cleaned up so they don't pile up
// in Cursor's picker:
//   - `bridge-gpt-*` (pre-1.0 substring-hijacked names)
//   - `bridge-pro`   (1.0/1.0.1 flagship; now split into 6 reasoning/fast
//                     variants in 2.0)
const LEGACY_BRIDGE_NAMES = [
  'bridge-gpt-5.5',
  'bridge-gpt-5.4',
  'bridge-gpt-5.3-codex',
  'bridge-gpt-5.2',
  'bridge-pro',
];
if (tunnel?.url && cursorStateDbExists()) {
  const baseUrl = `${tunnel.url}/v1`;
  const cursorAlive = isCursorRunning();
  if (cursorAlive) {
    process.stdout.write(
      `\n${ANSI.yellow}!! Cursor is currently running — skipping settings sync. !!${ANSI.reset}\n` +
        `   Cursor wipes user-added BYOK models within seconds of any disk write\n` +
        `   while it's open. To auto-register the bridge-* aliases:\n` +
        `     1. Quit Cursor fully (Cmd+Q — not just close the window)\n` +
        `     2. Restart this bridge (Ctrl+C, then re-run the same command)\n` +
        `     3. Launch Cursor again; the models will be in "Add Model" already\n` +
        `   In the meantime add them by hand: Settings → Models → "Add Model" →\n` +
        `   ${BRIDGE_MODELS.join(', ')}\n`,
    );
  } else {
    const result = applyCursorConfig({
      openAIBaseUrl: baseUrl,
      addUserAddedModels: BRIDGE_MODELS,
      removeUserAddedModels: LEGACY_BRIDGE_NAMES.filter((n) => !BRIDGE_MODELS.includes(n)),
    });
    if (result.ok && result.changes.length) {
      process.stdout.write(`\nUpdated Cursor settings: ${result.changes.join(' · ')}\n`);
    } else if (result.ok) {
      process.stdout.write('\nCursor settings already up to date.\n');
    } else {
      process.stdout.write(`\nCould not auto-update Cursor settings: ${result.reason}\n`);
      process.stdout.write('Configure manually using the BYOK card above.\n');
    }
  }
}

// Right after the wizard, if tunnel mode was just enabled, do the human
// nudges: copy the public URL to clipboard, open Cursor.
if (wizardRanThisInvocation && tunnel?.url) {
  if (copyToClipboard(tunnel.url)) {
    process.stdout.write(`Copied ${tunnel.url} to clipboard.\n`);
  }
  if (openCursor()) {
    process.stdout.write('Opened Cursor.\n');
  }
}

async function ensureAuthToken(currentState) {
  if (currentState.auth_token) return currentState.auth_token;
  const token = 'sk-bridge-' + crypto.randomBytes(20).toString('hex');
  await saveState({ ...currentState, auth_token: token });
  return token;
}

function parseCli(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        'auth-path': { type: 'string', short: 'a' },
        model: { type: 'string', short: 'm' },
        setup: { type: 'boolean' },
        'no-setup': { type: 'boolean' },
        tunnel: { type: 'boolean' },
        'no-tunnel': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      allowPositionals: false,
      strict: true,
    });
    return values;
  } catch (e) {
    console.error(`error: ${e.message}\n`);
    printHelp(process.stderr);
    process.exit(2);
  }
}

function printHelp(stream = process.stdout) {
  stream.write(`codex-cursor-bridge v${PKG_VERSION}

Run a localhost OpenAI-compatible proxy backed by your ChatGPT subscription
(via the Codex CLI's auth at ~/.codex/auth.json).

Usage:
  codex-cursor-bridge [options]
  npx codex-cursor-bridge [options]

Options:
  -p, --port <port>          Port to listen on (default: 7711)
      --host <host>          Bind address (default: 127.0.0.1)
  -a, --auth-path <path>     Codex auth file (default: ~/.codex/auth.json)
  -m, --model <id>           Upstream model id (default: gpt-5.5)
      --tunnel               Expose the bridge through an ngrok tunnel so
                             Cursor's cloud backend can reach it (required
                             for Cursor BYOK to actually route through here)
      --no-tunnel            Force localhost-only even if the wizard saved a
                             tunnel preference
      --setup                Re-run the first-run setup wizard
      --no-setup             Skip the wizard even on first run (for daemons)
  -h, --help                 Show this help
  -v, --version              Show version

Environment overrides (CLI flags take precedence):
  CODEX_BRIDGE_PORT, CODEX_BRIDGE_HOST, CODEX_AUTH_PATH, CODEX_MODEL,
  CODEX_CLIENT_VERSION, CODEX_ORIGINATOR, CODEX_CLIENT_ID

Endpoints once running:
  GET  /healthz
  GET  /v1/models
  POST /v1/chat/completions
  POST /v1/responses

Prerequisites:
  - A ChatGPT Pro or Plus subscription
  - The Codex CLI installed and logged in (\`codex login\`)
  - Node.js 20+

Docs: https://github.com/mmmeff/codex-cursor-bridge
`);
}

async function loadPackageVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await fs.readFile(path.join(here, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function platformLabel() {
  const plat = process.platform === 'darwin' ? 'Macintosh; macOS' : process.platform === 'linux' ? 'Linux' : process.platform;
  return `${plat} ${os.release()}; ${process.arch}`;
}

async function readAuth() {
  let raw;
  try {
    raw = await fs.readFile(AUTH_PATH, 'utf8');
  } catch (e) {
    throw new Error(`could not read ${AUTH_PATH} (${e.code}). Install Codex and run 'codex login' first.`);
  }
  const a = JSON.parse(raw);
  if (!a.tokens?.access_token) throw new Error(`no access_token in ${AUTH_PATH} — run 'codex login'`);
  return a;
}

async function writeAuth(auth) {
  // Atomic write + restrictive mode so we don't downgrade Codex's 0600 file
  // or leave a half-written file behind if we get killed mid-write.
  const tmp = `${AUTH_PATH}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  await fs.rename(tmp, AUTH_PATH);
}

// Coalesce concurrent 401s into a single refresh attempt. Without this, N
// in-flight requests that all hit a stale token would each fire their own
// refresh and race to write auth.json.
let inflightRefresh = null;
async function refreshAuth(auth) {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const refresh_token = auth.tokens?.refresh_token;
    if (!refresh_token) throw new Error("no refresh_token; run 'codex login'");
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token,
      scope: 'openid profile email offline_access',
    });
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const errText = (await res.text().catch(() => '')).slice(0, 200);
      logEvent('red', `token refresh failed: ${res.status}`);
      throw new Error(`refresh failed: ${res.status} ${errText}`);
    }
    const j = await res.json();
    auth.tokens.access_token = j.access_token || auth.tokens.access_token;
    if (j.refresh_token) auth.tokens.refresh_token = j.refresh_token;
    if (j.id_token) auth.tokens.id_token = j.id_token;
    auth.last_refresh = new Date().toISOString();
    await writeAuth(auth);
    logEvent('cyan', 'refreshed access token via auth.openai.com');
    return auth;
  })().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

function upstreamHeaders(auth) {
  return {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    'chatgpt-account-id': auth.tokens.account_id,
    'OpenAI-Beta': 'responses=experimental',
    'User-Agent': UA,
    originator: ORIGINATOR,
    version: CLIENT_VERSION,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
}

// ---------- chat/completions <-> responses translators ----------

// The Codex Responses API is strict about content-part types:
//   role: 'user'      → 'input_text' / 'input_image'
//   role: 'assistant' → 'output_text' / 'refusal'
// Sending the wrong one produces 400s like
//   "Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'."
function normalizeContentByRole(content, role) {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  const parts = Array.isArray(content) ? content : [content];
  return parts.map((p) => {
    if (typeof p === 'string') return { type: textType, text: p };
    if (p == null) return { type: textType, text: '' };
    if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') {
      return { type: textType, text: p.text ?? '' };
    }
    if (p.type === 'refusal') return p;
    if (p.type === 'image_url') {
      return { type: 'input_image', image_url: p.image_url?.url ?? p.image_url };
    }
    if (p.type === 'input_image' || p.type === 'output_image') return p;
    return { type: textType, text: typeof p === 'object' ? JSON.stringify(p) : String(p) };
  });
}

function chatToResponses(req, modelSpec) {
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const sys = [];
  const input = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      sys.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      for (const tc of m.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments ?? '',
        });
      }
      if (m.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: normalizeContentByRole(m.content, 'assistant'),
        });
      }
      continue;
    }
    const role = m.role === 'user' ? 'user' : 'assistant';
    input.push({
      type: 'message',
      role,
      content: normalizeContentByRole(m.content, role),
    });
  }
  const out = {
    model: modelSpec.upstream,
    instructions: sys.length ? sys.join('\n\n') : 'You are a helpful assistant.',
    input,
    stream: true,
    store: false,
  };
  if (modelSpec.reasoning) out.reasoning = { effort: modelSpec.reasoning };
  if (modelSpec.fast) out.service_tier = 'priority';
  if (Array.isArray(req.tools) && req.tools.length) {
    out.tools = req.tools.map((t) => {
      if (t.type === 'function' && t.function) {
        return { type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters };
      }
      return t;
    });
  }
  if (req.tool_choice) out.tool_choice = req.tool_choice;
  if (req.parallel_tool_calls != null) out.parallel_tool_calls = req.parallel_tool_calls;
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  // Intentionally NOT forwarding max_tokens / max_completion_tokens / max_output_tokens.
  // The ChatGPT-plan Codex backend rejects them with "Unsupported parameter" 400s.
  return out;
}

// Body the caller already wrote in Responses-API shape (`input` array of
// role/content items). Sanitize for the upstream Codex Responses endpoint:
//   - System / developer items get pulled into top-level `instructions`
//     (the only place upstream accepts a system prompt for ChatGPT-plan auth).
//   - Function-call and function-call-output items pass through.
//   - Tools, tool_choice, temperature, top_p, parallel_tool_calls, user are
//     forwarded as-is. max_tokens et al. are still stripped (upstream rejects).
function responsesShapeToUpstream(body, modelSpec) {
  const items = Array.isArray(body.input) ? body.input : [];
  const sys = [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'function_call' || it.type === 'function_call_output') {
      out.push(it);
      continue;
    }
    if (it.role === 'system' || it.role === 'developer') {
      sys.push(typeof it.content === 'string' ? it.content : JSON.stringify(it.content));
      continue;
    }
    // Normalize content-part types per role. Cursor sometimes sends prior
    // assistant turns with `input_text` parts which upstream rejects.
    const role = it.role === 'user' ? 'user' : 'assistant';
    out.push({
      ...it,
      type: it.type ?? 'message',
      role,
      content: normalizeContentByRole(it.content, role),
    });
  }
  const upstream = {
    model: modelSpec.upstream,
    instructions:
      typeof body.instructions === 'string' && body.instructions.length
        ? body.instructions + (sys.length ? '\n\n' + sys.join('\n\n') : '')
        : sys.length
          ? sys.join('\n\n')
          : 'You are a helpful assistant.',
    input: out,
    stream: true,
    store: false,
  };
  if (modelSpec.reasoning) upstream.reasoning = { effort: modelSpec.reasoning };
  if (modelSpec.fast) upstream.service_tier = 'priority';
  if (Array.isArray(body.tools)) upstream.tools = body.tools;
  if (body.tool_choice) upstream.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls != null) upstream.parallel_tool_calls = body.parallel_tool_calls;
  if (body.temperature != null) upstream.temperature = body.temperature;
  if (body.top_p != null) upstream.top_p = body.top_p;
  // Intentionally dropped: `user`, `max_tokens`, `max_output_tokens`,
  // `metadata`, `stream_options`. The ChatGPT-plan Codex backend rejects
  // these with `"Unsupported parameter: ..."` 400s.
  return upstream;
}

// ---------- SSE plumbing ----------

async function* iterSSE(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseEvent(raw);
      if (ev) yield ev;
    }
  }
}

function parseEvent(block) {
  let event = 'message';
  const datas = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) datas.push(line.slice(5).trim());
  }
  if (!datas.length) return null;
  const data = datas.join('\n');
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data };
  }
}

function chunk(id, model, delta, finish_reason = null) {
  return (
    'data: ' +
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason }],
    }) +
    '\n\n'
  );
}

// ---------- core handler ----------

async function callUpstream(reqBody, auth) {
  return fetch(UPSTREAM, {
    method: 'POST',
    headers: upstreamHeaders(auth),
    body: JSON.stringify(reqBody),
  });
}

async function callUpstreamWithRefresh(reqBody) {
  let auth = await readAuth();
  let up = await callUpstream(reqBody, auth);
  if (up.status === 401) {
    auth = await refreshAuth(auth);
    up = await callUpstream(reqBody, auth);
  }
  return up;
}

async function handleChatCompletions(req, res) {
  const body = await readJSON(req);
  if (process.env.CODEX_BRIDGE_DEBUG) {
    process.stdout.write(
      `${tint('dim', nowHMS())} ${tint('magenta', 'DEBUG chat/completions in:')} ${JSON.stringify(body).slice(0, 800)}\n`,
    );
  }
  const wantStream = body.stream !== false; // default to streaming
  // Reject unknown models with a clear 400 — the bridge namespace is a
  // strict whitelist, no silent rewrites.
  const modelSpec = resolveUpstreamModel(body.model);
  if (!modelSpec) {
    respondError(res, 400, unsupportedModelMessage(body.model));
    return;
  }
  // Cursor (and likely future OpenAI SDKs) sends a Responses-API-shaped body
  // — an `input` array of role/content items, no top-level `messages` — to
  // the chat/completions URL. Detect that shape and route it without
  // re-translating from messages we don't have.
  const isResponsesShape = Array.isArray(body.input) && !Array.isArray(body.messages);
  const upstreamBody = isResponsesShape
    ? responsesShapeToUpstream(body, modelSpec)
    : chatToResponses(body, modelSpec);
  upstreamBody.stream = true;
  const requestedModel = body.model;
  const msgCount = isResponsesShape
    ? body.input.length
    : Array.isArray(body.messages)
      ? body.messages.length
      : 0;
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  // Per-request metadata stashed on `req` so the outer router can log it.
  req._cbMeta = {
    model: requestedModel,
    msgs: msgCount,
    tools: toolCount,
    mode: wantStream ? 'stream' : 'single',
    chunks: 0,
    bytes: 0,
  };

  let up;
  try {
    up = await callUpstreamWithRefresh(upstreamBody);
  } catch (e) {
    respondError(res, 401, `upstream auth failed: ${e.message}`);
    return;
  }

  if (!up.ok || !up.body) {
    const text = await up.text().catch(() => '');
    if (process.env.CODEX_BRIDGE_DEBUG) {
      process.stdout.write(
        `${tint('dim', nowHMS())} ${tint('red', `upstream ${up.status}`)} forwarded body: ${JSON.stringify(upstreamBody).slice(0, 600)}\n`,
      );
      process.stdout.write(`${tint('dim', '   upstream said:')} ${text.slice(0, 500)}\n`);
    }
    respondError(res, up.status || 500, text || 'upstream error');
    return;
  }

  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
    });
    res.write(chunk(id, requestedModel, { role: 'assistant' }));
    let finish = 'stop';
    const toolCalls = new Map();
    let toolIdx = 0;

    for await (const ev of iterSSE(up.body)) {
      const d = ev.data;
      if (!d || typeof d !== 'object') continue;
      const t = d.type;
      if (t === 'response.output_text.delta') {
        if (d.delta) {
          res.write(chunk(id, requestedModel, { content: d.delta }));
          req._cbMeta.chunks += 1;
          req._cbMeta.bytes += Buffer.byteLength(d.delta);
        }
      } else if (t === 'response.output_item.added' && d.item?.type === 'function_call') {
        const itemId = d.item.id;
        const entry = { index: toolIdx++, id: d.item.call_id || itemId, name: d.item.name || '', args: '' };
        toolCalls.set(itemId, entry);
        res.write(
          chunk(id, requestedModel, {
            tool_calls: [
              {
                index: entry.index,
                id: entry.id,
                type: 'function',
                function: { name: entry.name, arguments: '' },
              },
            ],
          }),
        );
      } else if (t === 'response.function_call_arguments.delta') {
        const entry = toolCalls.get(d.item_id);
        if (entry && d.delta != null) {
          entry.args += d.delta;
          res.write(
            chunk(id, requestedModel, {
              tool_calls: [
                {
                  index: entry.index,
                  function: { arguments: d.delta },
                },
              ],
            }),
          );
          req._cbMeta.chunks += 1;
          req._cbMeta.bytes += Buffer.byteLength(d.delta);
        }
      } else if (t === 'response.completed') {
        const reason = d.response?.incomplete_details?.reason;
        if (toolCalls.size) finish = 'tool_calls';
        else if (reason === 'max_output_tokens') finish = 'length';
        else finish = 'stop';
      } else if (t === 'response.failed' || t === 'error') {
        const msg = d.response?.error?.message || d.error?.message || 'upstream failed';
        res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
        finish = 'stop';
      }
    }
    res.write(chunk(id, requestedModel, {}, finish));
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // non-streaming
  let content = '';
  let finish = 'stop';
  const toolCallsArr = [];
  const tcMap = new Map();
  for await (const ev of iterSSE(up.body)) {
    const d = ev.data;
    if (!d || typeof d !== 'object') continue;
    const t = d.type;
    if (t === 'response.output_text.delta' && d.delta) content += d.delta;
    else if (t === 'response.output_item.added' && d.item?.type === 'function_call') {
      const entry = { id: d.item.call_id || d.item.id, type: 'function', function: { name: d.item.name || '', arguments: '' } };
      tcMap.set(d.item.id, entry);
      toolCallsArr.push(entry);
    } else if (t === 'response.function_call_arguments.delta') {
      const entry = tcMap.get(d.item_id);
      if (entry && d.delta != null) entry.function.arguments += d.delta;
    } else if (t === 'response.completed') {
      if (toolCallsArr.length) finish = 'tool_calls';
    }
  }
  const out = {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || null,
          ...(toolCallsArr.length ? { tool_calls: toolCallsArr } : {}),
        },
        finish_reason: finish,
      },
    ],
  };
  const payload = JSON.stringify(out);
  req._cbMeta.bytes = Buffer.byteLength(payload);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function handleResponsesPassthrough(req, res) {
  const body = await readJSON(req);
  if (process.env.CODEX_BRIDGE_DEBUG) {
    process.stdout.write(
      `${tint('dim', nowHMS())} ${tint('magenta', 'DEBUG /v1/responses in:')} ${JSON.stringify(body).slice(0, 800)}\n`,
    );
  }
  const modelSpec = resolveUpstreamModel(body.model);
  if (!modelSpec) {
    respondError(res, 400, unsupportedModelMessage(body.model));
    return;
  }
  body.model = modelSpec.upstream;
  if (modelSpec.reasoning) body.reasoning = { effort: modelSpec.reasoning };
  if (modelSpec.fast) body.service_tier = 'priority';
  if (!body.instructions) body.instructions = 'You are a helpful assistant.';
  body.stream = true;
  let up;
  try {
    up = await callUpstreamWithRefresh(body);
  } catch (e) {
    respondError(res, 401, `upstream auth failed: ${e.message}`);
    return;
  }
  if (!up.ok || !up.body) {
    const t = await up.text().catch(() => '');
    if (process.env.CODEX_BRIDGE_DEBUG) {
      process.stdout.write(
        `${tint('dim', nowHMS())} ${tint('red', `upstream ${up.status}`)} forwarded body: ${JSON.stringify(body).slice(0, 600)}\n`,
      );
      process.stdout.write(`${tint('dim', '   upstream said:')} ${t.slice(0, 500)}\n`);
    }
    respondError(res, up.status || 500, t);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
  });
  const reader = up.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

function modelsResponse() {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: BRIDGE_MODELS.map((id) => ({
      id,
      object: 'model',
      created: now,
      owned_by: 'codex-cursor-bridge',
    })),
  };
}

// ---------- HTTP plumbing ----------

const MAX_REQUEST_BYTES = 8 * 1024 * 1024; // 8 MiB — generous for Cursor's largest payloads

function readJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_REQUEST_BYTES) {
        req.destroy();
        reject(new Error(`request body exceeds ${MAX_REQUEST_BYTES} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8') || '{}';
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function respondError(res, status, message) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'codex_bridge_error' } }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname.replace(/\/+$/, '');
  const start = performance.now();
  // /healthz is the LaunchAgent/monit-style poll target; logging it would
  // drown out everything else.
  const silent = p === '/healthz';

  // Auth gate. When AUTH_TOKEN is set (tunnel mode), require
  // `Authorization: Bearer <token>` on /v1/* routes. /healthz stays open so
  // ngrok and monitors can probe liveness without the secret.
  if (AUTH_TOKEN && p.startsWith('/v1/')) {
    const hdr = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(hdr);
    if (!m || m[1] !== AUTH_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid or missing bearer token', type: 'codex_bridge_unauthorized' } }));
      if (!silent) logRequest({ method: req.method, path: p || '/', status: 401, ms: performance.now() - start, extra: 'auth' });
      return;
    }
  }

  try {
    if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(modelsResponse()));
      return;
    }
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
      await handleChatCompletions(req, res);
      return;
    }
    if (req.method === 'POST' && (p === '/v1/responses' || p === '/responses')) {
      await handleResponsesPassthrough(req, res);
      return;
    }
    if (silent) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  } catch (e) {
    console.error('handler error:', e);
    respondError(res, 500, e.message || String(e));
  } finally {
    if (!silent) {
      const ms = performance.now() - start;
      const meta = req._cbMeta;
      let extra = '';
      if (meta) {
        const parts = [meta.model, `msgs=${meta.msgs}`];
        if (meta.tools) parts.push(`tools=${meta.tools}`);
        if (meta.mode === 'stream') parts.push(`stream chunks=${meta.chunks}`);
        if (meta.bytes) parts.push(fmtBytes(meta.bytes));
        extra = parts.join(' ');
      }
      logRequest({ method: req.method, path: p || '/', status: res.statusCode, ms, extra });
    }
  }
});

server.listen(PORT, HOST);
