// ngrok tunnel manager.
//
// We need a publicly reachable URL so Cursor's cloud backend can call the
// bridge (Cursor BYOK with a custom base URL only consults the URL from
// server-side, not the client). ngrok's free tier issues an ephemeral
// https://*.ngrok-free.app domain that points at our local port; we spawn
// ngrok and read the URL out of its local admin API at :4040.

import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';

export function whichNgrok() {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, 'ngrok');
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

export function ngrokAuthtokenPresent() {
  // `ngrok config check` exits 0 if there's a valid config (which requires an
  // authtoken on current versions). We swallow stderr because the message
  // varies between versions.
  const r = spawnSync('ngrok', ['config', 'check'], { encoding: 'utf8' });
  return r.status === 0;
}

async function fetchTunnelUrl(maxMs = 15000) {
  const deadline = Date.now() + maxMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(NGROK_API);
      if (res.ok) {
        const j = await res.json();
        const t = (j.tunnels || []).find((x) => x.public_url && x.public_url.startsWith('https://'));
        if (t) return t.public_url;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `timed out waiting for ngrok public URL at ${NGROK_API}${lastErr ? `: ${lastErr.message}` : ''}`,
  );
}

/**
 * Start an ngrok tunnel to `port` on localhost. Returns the public https URL
 * and a `stop()` function that kills the child process.
 *
 * Throws if ngrok isn't installed, has no authtoken, or never publishes a URL.
 */
export async function startNgrokTunnel({ port, log = () => {} } = {}) {
  if (!whichNgrok()) {
    const err = new Error('ngrok not installed');
    err.code = 'NGROK_NOT_FOUND';
    throw err;
  }
  if (!ngrokAuthtokenPresent()) {
    const err = new Error('ngrok authtoken not configured');
    err.code = 'NGROK_NO_AUTHTOKEN';
    throw err;
  }
  // --log=stdout keeps ngrok's output out of our terminal but available for
  // diagnostics; --log-format=json makes it easy to parse if we ever need to.
  const child = spawn(
    'ngrok',
    ['http', String(port), '--log=stdout', '--log-format=json'],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: false },
  );
  let earlyExit = null;
  child.on('exit', (code, signal) => {
    earlyExit = { code, signal };
    log(`ngrok exited (code=${code}, signal=${signal})`);
  });
  // Drain stdout/stderr so the pipe buffer doesn't fill and pause ngrok.
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  let url;
  try {
    url = await fetchTunnelUrl();
  } catch (e) {
    try {
      child.kill('SIGTERM');
    } catch {}
    if (earlyExit) {
      const err = new Error(`ngrok exited before opening a tunnel (code=${earlyExit.code})`);
      err.code = 'NGROK_EXITED';
      throw err;
    }
    throw e;
  }

  return {
    url,
    stop() {
      try {
        child.kill('SIGTERM');
      } catch {}
    },
  };
}
