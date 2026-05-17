// First-run setup wizard for codex-cursor-bridge.
// Lives in its own module so server.mjs stays focused on serving HTTP.
//
// Responsibilities:
//   - Persist setup state at ~/.codex-cursor-bridge/state.json
//   - Validate prerequisites (node, codex CLI, auth.json, upstream creds)
//   - Optionally install the LaunchAgent / show systemd snippet
//   - Optionally help the user wire the proxy into Cursor (clipboard + deeplink)
//   - Print a startup card with the Cursor BYOK settings to paste

import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const STATE_DIR = path.join(os.homedir(), '.codex-cursor-bridge');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const useColor = stdout.isTTY && !process.env.NO_COLOR;
const paint = (color, text) => (useColor ? `${c[color]}${text}${c.reset}` : text);

export async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- prerequisite checks ----------

async function checkNode() {
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  if (major < 20) return { ok: false, detail: `Node ${v} — need 20+` };
  return { ok: true, detail: `Node v${v}` };
}

async function checkCodexCLI() {
  const found = which('codex');
  if (found) return { ok: true, detail: `codex CLI at ${found}` };
  const macApp = '/Applications/Codex.app/Contents/Resources/codex';
  try {
    await fs.access(macApp);
    return { ok: true, detail: `codex bundled with Codex.app (${macApp})` };
  } catch {}
  return {
    ok: false,
    detail: 'codex CLI not found',
    hint: 'Install Codex from https://github.com/openai/codex or the desktop app at https://chatgpt.com/codex',
  };
}

function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, cmd);
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

async function checkAuthFile(authPath) {
  try {
    const raw = await fs.readFile(authPath, 'utf8');
    const auth = JSON.parse(raw);
    if (!auth?.tokens?.access_token) {
      return { ok: false, detail: `${authPath} has no access_token`, hint: 'Run: codex login' };
    }
    const claims = decodeJwt(auth.tokens.access_token);
    const exp = claims?.exp ? new Date(claims.exp * 1000) : null;
    const plan = claims?.['https://api.openai.com/auth']?.chatgpt_plan_type;
    const email = claims?.['https://api.openai.com/profile']?.email;
    if (!plan || (plan !== 'pro' && plan !== 'plus' && plan !== 'team' && plan !== 'enterprise')) {
      return {
        ok: false,
        detail: `auth file present but plan is "${plan ?? 'unknown'}"`,
        hint: 'ChatGPT Pro/Plus is required. Free accounts cannot use the Codex backend.',
      };
    }
    if (exp && exp < new Date()) {
      return { ok: false, detail: `access token expired at ${exp.toISOString()}`, hint: 'Run: codex login (or just `codex` once)' };
    }
    return {
      ok: true,
      detail: `ChatGPT ${plan}${email ? ` (${email})` : ''}${exp ? `, token valid through ${exp.toISOString().slice(0, 10)}` : ''}`,
      auth,
    };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { ok: false, detail: `no auth file at ${authPath}`, hint: 'Run: codex login' };
    }
    return { ok: false, detail: `could not read ${authPath}: ${e.message}` };
  }
}

function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function verifyUpstreamCreds(auth, headers) {
  const body = {
    model: 'gpt-5.5',
    instructions: 'You are a connectivity probe. Reply with only: OK',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    stream: true,
    store: false,
  };
  try {
    const res = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.tokens.access_token}`,
        'chatgpt-account-id': auth.tokens.account_id,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, detail: `upstream ${res.status}`, hint: text.slice(0, 200) };
    }
    // We don't need to drain the whole stream; reading any bytes proves the connection works.
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel().catch(() => {});
    const bytes = value ? value.byteLength : 0;
    return { ok: true, detail: `upstream accepted request (received ${bytes}B of SSE)` };
  } catch (e) {
    return { ok: false, detail: `network error: ${e.message}` };
  }
}

// ---------- prompting ----------
//
// Tiny hand-rolled line reader. node:readline/promises misbehaves when stdin
// is a closed pipe with pre-buffered lines (Node 24 surfaces this as an
// "unsettled top-level await" warning). This implementation queues buffered
// lines, queues waiters when none are ready, and resolves remaining waiters
// with null on EOF so callers can fall back to the default answer.

function makeLinePrompter() {
  const queue = [];
  const waiters = [];
  let ended = false;
  let pending = '';

  stdin.setEncoding('utf8');
  const onData = (chunk) => {
    pending += chunk;
    let i;
    while ((i = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, i).replace(/\r$/, '');
      pending = pending.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
      else queue.push(line);
    }
  };
  const onEnd = () => {
    ended = true;
    if (pending) {
      const line = pending.replace(/\r$/, '');
      pending = '';
      const w = waiters.shift();
      if (w) w(line);
      else queue.push(line);
    }
    while (waiters.length) waiters.shift()(null);
  };
  stdin.on('data', onData);
  stdin.on('end', onEnd);

  return {
    ask(prompt) {
      stdout.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((res) => waiters.push(res));
    },
    close() {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.unref();
    },
  };
}

async function promptYesNo(rl, question, defaultYes = true) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const raw = await rl.ask(`${question} [${hint}] `);
  if (raw == null) {
    // EOF: treat as default and echo so the transcript is readable.
    stdout.write(`(EOF; defaulting to ${defaultYes ? 'yes' : 'no'})\n`);
    return defaultYes;
  }
  const answer = raw.trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}

// ---------- daemon install ----------

// npm puts npx packages in a transient cache (~/.npm/_npx/<hash>/...) that
// gets garbage-collected. A LaunchAgent that points there will silently break
// later. Refuse to install in that case and tell the user how to make it
// durable.
function isTransientNpxPath(p) {
  return p.includes(`${path.sep}_npx${path.sep}`);
}

async function offerDaemonInstall(rl, repoDir) {
  if (process.platform === 'darwin') {
    if (isTransientNpxPath(repoDir)) {
      stdout.write(
        paint('yellow', '  ! Skipping daemon install — this is running from an npx cache.\n') +
          paint('dim', `    (Path: ${repoDir})\n`) +
          paint('dim', '    npm garbage-collects that directory periodically, which would break the LaunchAgent.\n') +
          paint('dim', '    To run as a daemon, install globally first:\n') +
          paint('bold', '      npm install -g codex-cursor-bridge\n') +
          paint('dim', '    then re-run with `codex-cursor-bridge --setup`.\n'),
      );
      return { installed: false };
    }
    const yes = await promptYesNo(rl, 'Install as a macOS LaunchAgent so it auto-starts on login?', false);
    if (!yes) return { installed: false };
    const installer = path.join(repoDir, 'scripts', 'install-launchd.sh');
    try {
      await fs.access(installer);
    } catch {
      stdout.write(paint('yellow', `  ! install-launchd.sh not found at ${installer}\n`));
      return { installed: false };
    }
    const r = spawnSync('bash', [installer], { stdio: 'inherit', cwd: repoDir });
    if (r.status === 0) {
      stdout.write(paint('green', '  ✓ LaunchAgent installed. The bridge will keep running after you close this terminal.\n'));
      stdout.write(paint('dim', '    Uninstall any time with: bash scripts/uninstall-launchd.sh\n'));
      return { installed: true };
    }
    stdout.write(paint('red', '  ✗ Installer exited non-zero — leaving as foreground for now.\n'));
    return { installed: false };
  }
  if (process.platform === 'linux') {
    stdout.write(
      paint(
        'dim',
        `  systemd template (save to ~/.config/systemd/user/codex-cursor-bridge.service, then enable):
    [Unit]
    Description=codex-cursor-bridge
    After=network-online.target

    [Service]
    ExecStart=$(command -v node) ${path.join(repoDir, 'server.mjs')}
    Environment=CODEX_BRIDGE_PORT=7711
    Restart=always
    RestartSec=2

    [Install]
    WantedBy=default.target

  Then: systemctl --user daemon-reload && systemctl --user enable --now codex-cursor-bridge
`,
      ),
    );
    return { installed: false };
  }
  stdout.write(paint('dim', `  no daemon installer for ${process.platform}; leaving as foreground.\n`));
  return { installed: false };
}

// ---------- Cursor wiring ----------

const CURSOR_SETTINGS_PATHS = {
  darwin: path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'),
  linux: path.join(os.homedir(), '.config', 'Cursor', 'User', 'settings.json'),
  win32: path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'settings.json'),
};

function cursorAppPresent() {
  if (process.platform === 'darwin') {
    for (const p of ['/Applications/Cursor.app', path.join(os.homedir(), 'Applications/Cursor.app')]) {
      try {
        if (statSync(p).isDirectory()) return true;
      } catch {}
    }
    return false;
  }
  return which('cursor') != null;
}

function copyToClipboard(text) {
  if (process.platform === 'darwin') {
    const r = spawnSync('pbcopy', { input: text });
    return r.status === 0;
  }
  if (process.platform === 'linux') {
    if (which('wl-copy')) return spawnSync('wl-copy', { input: text }).status === 0;
    if (which('xclip')) return spawnSync('xclip', ['-selection', 'clipboard'], { input: text }).status === 0;
  }
  return false;
}

function openCursor() {
  if (process.platform === 'darwin') {
    return spawn('open', ['-a', 'Cursor'], { detached: true, stdio: 'ignore' }).pid != null;
  }
  if (process.platform === 'linux') {
    return spawn('xdg-open', ['cursor://'], { detached: true, stdio: 'ignore' }).pid != null;
  }
  return false;
}

async function offerCursorConfig(rl, baseUrl) {
  const settingsPath = CURSOR_SETTINGS_PATHS[process.platform];
  const cursorHere = cursorAppPresent() || (settingsPath && (await fileExists(settingsPath)));
  if (!cursorHere) {
    stdout.write(paint('dim', '  Cursor not detected — skipping. Wire it up manually using the card printed at startup.\n'));
    return { configured: false };
  }
  const yes = await promptYesNo(
    rl,
    'Help configure Cursor now? (copies the base URL to your clipboard and opens Cursor)',
    true,
  );
  if (!yes) return { configured: false };

  const copied = copyToClipboard(baseUrl);
  if (copied) {
    stdout.write(paint('green', `  ✓ Copied ${baseUrl} to clipboard.\n`));
  } else {
    stdout.write(paint('yellow', `  ! Could not access clipboard; copy this manually: ${baseUrl}\n`));
  }

  const opened = openCursor();
  if (opened) stdout.write(paint('green', '  ✓ Opened Cursor.\n'));

  stdout.write(
    paint(
      'cyan',
      `
  Inside Cursor:
    1. Cmd+, (or Ctrl+,) → Cursor Settings → Models tab
    2. Scroll to "OpenAI API Key" — paste anything, e.g. sk-bridge
    3. Toggle "Override OpenAI Base URL" on
    4. Paste the URL from your clipboard: ${baseUrl}
    5. Click Verify, then enable any gpt-* model
`,
    ),
  );
  return { configured: true };
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- public API ----------

export function shouldRunWizard({ state, forceSetup, noSetup }) {
  if (noSetup) return false;
  if (forceSetup) return true;
  if (!stdin.isTTY) return false;
  return !state.setup_complete;
}

export async function runSetupWizard({ port, host, authPath, version, repoDir }) {
  const baseUrl = `http://${host}:${port}/v1`;
  stdout.write('\n');
  stdout.write(paint('bold', `codex-cursor-bridge v${version} — first-run setup\n`));
  stdout.write(paint('dim', '(re-run any time with `--setup`; skip with `--no-setup`)\n\n'));

  // Step 1: prereq checks
  stdout.write(paint('bold', '[1/3] Checking prerequisites...\n'));
  const checks = [
    ['node runtime', await checkNode()],
    ['codex CLI', await checkCodexCLI()],
    ['codex auth', await checkAuthFile(authPath)],
  ];
  let blocking = false;
  let authResult = null;
  for (const [name, r] of checks) {
    if (r.ok) {
      stdout.write(paint('green', `  ✓ ${name}`) + ` — ${r.detail}\n`);
    } else {
      blocking = true;
      stdout.write(paint('red', `  ✗ ${name}`) + ` — ${r.detail}\n`);
      if (r.hint) stdout.write(paint('dim', `      → ${r.hint}\n`));
    }
    if (name === 'codex auth' && r.ok) authResult = r;
  }
  if (blocking) {
    stdout.write(paint('red', '\nFix the items above and re-run. Exiting.\n'));
    process.exit(1);
  }

  // Live upstream probe
  stdout.write(paint('dim', '  ...probing upstream...\r'));
  const upstream = await verifyUpstreamCreds(authResult.auth, {
    'OpenAI-Beta': 'responses=experimental',
    'User-Agent': `codex-cursor-bridge/${version}`,
    originator: 'codex_cli_rs',
    version: '0.131.0',
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  });
  if (upstream.ok) {
    stdout.write(paint('green', `  ✓ upstream credentials`) + ` — ${upstream.detail}\n`);
  } else {
    stdout.write(paint('red', `  ✗ upstream credentials`) + ` — ${upstream.detail}\n`);
    if (upstream.hint) stdout.write(paint('dim', `      → ${upstream.hint}\n`));
    stdout.write(paint('red', '\nUpstream rejected the test call. Try running `codex` once to refresh the token, then re-run setup.\n'));
    process.exit(1);
  }

  const rl = makeLinePrompter();
  try {
    // Step 2: daemon install
    stdout.write(paint('bold', '\n[2/3] Run on every login?\n'));
    await offerDaemonInstall(rl, repoDir);

    // Step 3: Cursor wiring
    stdout.write(paint('bold', '\n[3/3] Wire it into Cursor?\n'));
    await offerCursorConfig(rl, baseUrl);
  } finally {
    rl.close();
  }

  await saveState({ setup_complete: true, completed_at: new Date().toISOString(), version });
  stdout.write(paint('dim', '\nSetup complete. Starting the bridge...\n\n'));
}

// ---------- startup card ----------

export function printStartupCard({ port, host, authPath, model, version }) {
  const baseUrl = `http://${host}:${port}/v1`;
  const lines = [
    paint('bold', `codex-cursor-bridge v${version}`),
    paint('dim', `listening on ${baseUrl}  ·  auth: ${shortenHome(authPath)}  ·  upstream: ${model}`),
    '',
    paint('cyan', '── Cursor BYOK setup ' + '─'.repeat(Math.max(0, 50))),
    `  1. ${paint('bold', 'Cmd+,')} (or Ctrl+,) → ${paint('bold', 'Cursor Settings → Models')}`,
    `  2. "OpenAI API Key": paste anything, e.g. ${paint('bold', 'sk-bridge')}`,
    `  3. Toggle ${paint('bold', '"Override OpenAI Base URL"')} on`,
    `  4. Base URL:  ${paint('bold', baseUrl)}`,
    `  5. Enable any ${paint('bold', 'gpt-*')} model in the list`,
    paint('cyan', '─'.repeat(70)),
    '',
  ];
  stdout.write(lines.join('\n'));
}

function shortenHome(p) {
  const h = os.homedir();
  return p.startsWith(h) ? '~' + p.slice(h.length) : p;
}

// Returns the directory containing the calling module. server.mjs is at the
// package root, so passing `import.meta.url` from there yields the repo dir
// (which is what install-launchd.sh expects).
export function repoDirOf(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}
