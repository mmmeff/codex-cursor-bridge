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

const PORT = Number(process.env.CODEX_BRIDGE_PORT || 7711);
const HOST = process.env.CODEX_BRIDGE_HOST || '127.0.0.1';
const AUTH_PATH = process.env.CODEX_AUTH_PATH || path.join(os.homedir(), '.codex', 'auth.json');
const UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses';
const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = process.env.CODEX_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';
const CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION || '0.131.0';
const ORIGINATOR = process.env.CODEX_ORIGINATOR || 'codex_cli_rs';

// "gpt-5.5" is the only model the ChatGPT-subscription Codex backend
// currently accepts. The bridge aliases popular OpenAI model names to it so
// existing clients that hard-code "gpt-4o" etc. still work.
const ALLOWED_MODEL = process.env.CODEX_MODEL || 'gpt-5.5';
const MODEL_ALIASES = ['gpt-5.5', 'gpt-5', 'gpt-5-codex', 'gpt-4o', 'gpt-4', 'gpt-4-turbo', 'gpt-4o-mini'];

const UA = `${ORIGINATOR}/${CLIENT_VERSION} (${platformLabel()}) bridge`;

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
  await fs.writeFile(AUTH_PATH, JSON.stringify(auth, null, 2));
}

async function refreshAuth(auth) {
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
  if (!res.ok) throw new Error(`refresh failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  auth.tokens.access_token = j.access_token || auth.tokens.access_token;
  if (j.refresh_token) auth.tokens.refresh_token = j.refresh_token;
  if (j.id_token) auth.tokens.id_token = j.id_token;
  auth.last_refresh = new Date().toISOString();
  await writeAuth(auth);
  return auth;
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

function chatToResponses(req) {
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
          content: [{ type: 'output_text', text: stringOf(m.content) }],
        });
      }
      continue;
    }
    const contentParts = Array.isArray(m.content)
      ? m.content.map((p) => {
          if (typeof p === 'string') return { type: 'input_text', text: p };
          if (p.type === 'text') return { type: 'input_text', text: p.text };
          if (p.type === 'image_url') return { type: 'input_image', image_url: p.image_url?.url ?? p.image_url };
          return { type: 'input_text', text: JSON.stringify(p) };
        })
      : [{ type: 'input_text', text: stringOf(m.content) }];
    input.push({
      type: 'message',
      role: m.role === 'user' ? 'user' : 'assistant',
      content: contentParts,
    });
  }
  const out = {
    model: ALLOWED_MODEL,
    instructions: sys.length ? sys.join('\n\n') : 'You are a helpful assistant.',
    input,
    stream: true,
    store: false,
  };
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
  if (req.max_tokens != null) out.max_output_tokens = req.max_tokens;
  if (req.max_completion_tokens != null) out.max_output_tokens = req.max_completion_tokens;
  return out;
}

function stringOf(c) {
  return typeof c === 'string' ? c : c == null ? '' : JSON.stringify(c);
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
  const wantStream = body.stream !== false; // default to streaming
  const upstreamBody = chatToResponses(body);
  upstreamBody.stream = true;
  const requestedModel = body.model || ALLOWED_MODEL;

  let up;
  try {
    up = await callUpstreamWithRefresh(upstreamBody);
  } catch (e) {
    respondError(res, 401, `upstream auth failed: ${e.message}`);
    return;
  }

  if (!up.ok || !up.body) {
    const text = await up.text().catch(() => '');
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
        if (d.delta) res.write(chunk(id, requestedModel, { content: d.delta }));
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
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(out));
}

async function handleResponsesPassthrough(req, res) {
  const body = await readJSON(req);
  body.model = ALLOWED_MODEL;
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
    data: MODEL_ALIASES.map((id) => ({
      id,
      object: 'model',
      created: now,
      owned_by: 'openai-chatgpt-subscription',
    })),
  };
}

// ---------- HTTP plumbing ----------

function readJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
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
    if (req.method === 'GET' && p === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  } catch (e) {
    console.error('handler error:', e);
    respondError(res, 500, e.message || String(e));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`codex-cursor-bridge listening at http://${HOST}:${PORT}/v1`);
  console.log(`  auth source: ${AUTH_PATH}`);
  console.log(`  upstream model: ${ALLOWED_MODEL}`);
});
