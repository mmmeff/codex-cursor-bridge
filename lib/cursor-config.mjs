// On-device tweaks to Cursor's own settings store.
//
// Cursor persists BYOK settings in
//   <appdata>/Cursor/User/globalStorage/state.vscdb
// inside a single big JSON blob keyed by
//   src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser
//
// We only touch two fields of that blob:
//   - openAIBaseUrl                  : string  — toggle + value for "Override OpenAI Base URL"
//   - aiSettings.userAddedModels     : string[] — Cursor's "Add Model" list
//
// We do NOT touch the API key (Cursor stores it as a secret elsewhere) or
// any other field. Writes are best-effort and reversible from the Cursor UI
// at any time.

// Static imports are hoisted to module load, so the "SQLite is experimental"
// warning would fire before any suppression we install. Install the filter
// FIRST, then load node:sqlite via dynamic import.
const _origEmit = process.emit;
process.emit = function (event, ...args) {
  if (
    event === 'warning' &&
    args[0] &&
    args[0].name === 'ExperimentalWarning' &&
    /SQLite/i.test(args[0].message || '')
  ) {
    return false;
  }
  return _origEmit.apply(this, [event, ...args]);
};

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { DatabaseSync } = await import('node:sqlite');

const STORAGE_KEY =
  'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

const STATE_DB_PATHS = {
  darwin: path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'globalStorage',
    'state.vscdb',
  ),
  linux: path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  win32: path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
};

export function cursorStateDbPath() {
  return STATE_DB_PATHS[process.platform] ?? null;
}

export function cursorStateDbExists() {
  const p = cursorStateDbPath();
  if (!p) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isCursorRunning() {
  if (process.platform === 'darwin') {
    return spawnSync('pgrep', ['-x', 'Cursor']).status === 0;
  }
  if (process.platform === 'linux') {
    return spawnSync('pgrep', ['-x', 'cursor']).status === 0;
  }
  return false;
}

/**
 * Apply a small set of BYOK-related updates to Cursor's settings store.
 *
 * @param {object} opts
 * @param {string} [opts.openAIBaseUrl] - New base URL to set (e.g. the ngrok URL).
 *                                        Passing `null` clears it (disables the
 *                                        override toggle).
 * @param {string[]} [opts.addUserAddedModels] - Bridge model names to append to
 *                                               aiSettings.userAddedModels (deduped).
 * @param {string[]} [opts.removeUserAddedModels] - Bridge model names to remove
 *                                                  from aiSettings.userAddedModels
 *                                                  AND modelOverrideEnabled (useful
 *                                                  when an alias was renamed).
 * @returns {{ ok: boolean, dbPath: string, changes: string[], reason?: string }}
 */
export function applyCursorConfig({ openAIBaseUrl, addUserAddedModels, removeUserAddedModels } = {}) {
  const dbPath = cursorStateDbPath();
  if (!dbPath) {
    return { ok: false, dbPath: '', changes: [], reason: `unsupported platform ${process.platform}` };
  }
  if (!cursorStateDbExists()) {
    return { ok: false, dbPath, changes: [], reason: 'Cursor state DB not found — launch Cursor at least once first' };
  }

  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (e) {
    return { ok: false, dbPath, changes: [], reason: `could not open state DB: ${e.message}` };
  }

  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(STORAGE_KEY);
    if (!row || !row.value) {
      return { ok: false, dbPath, changes: [], reason: 'applicationUser blob missing from state DB' };
    }
    const data = JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8'));
    const changes = [];

    if (openAIBaseUrl !== undefined) {
      if (data.openAIBaseUrl !== openAIBaseUrl) {
        data.openAIBaseUrl = openAIBaseUrl;
        changes.push(openAIBaseUrl == null ? 'cleared openAIBaseUrl' : `openAIBaseUrl → ${openAIBaseUrl}`);
      }
    }

    if (!data.aiSettings || typeof data.aiSettings !== 'object') data.aiSettings = {};

    if (Array.isArray(removeUserAddedModels) && removeUserAddedModels.length) {
      const toDrop = new Set(removeUserAddedModels);
      const existing = Array.isArray(data.aiSettings.userAddedModels) ? data.aiSettings.userAddedModels : [];
      const remaining = existing.filter((m) => !toDrop.has(m));
      const removed = existing.filter((m) => toDrop.has(m));
      if (removed.length) {
        data.aiSettings.userAddedModels = remaining;
        changes.push(`removed stale userAddedModels: ${removed.join(', ')}`);
      }
      // Also clear them from modelOverrideEnabled/Disabled so they vanish from the picker.
      for (const field of ['modelOverrideEnabled', 'modelOverrideDisabled']) {
        const arr = data.aiSettings[field];
        if (Array.isArray(arr)) {
          const filtered = arr.filter((m) => !toDrop.has(m));
          if (filtered.length !== arr.length) data.aiSettings[field] = filtered;
        }
      }
    }

    if (Array.isArray(addUserAddedModels) && addUserAddedModels.length) {
      const existing = Array.isArray(data.aiSettings.userAddedModels) ? data.aiSettings.userAddedModels : [];
      const merged = [...existing];
      const newlyAdded = [];
      for (const m of addUserAddedModels) {
        if (!merged.includes(m)) {
          merged.push(m);
          newlyAdded.push(m);
        }
      }
      if (newlyAdded.length) {
        data.aiSettings.userAddedModels = merged;
        changes.push(`added userAddedModels: ${newlyAdded.join(', ')}`);
      }
    }

    if (changes.length === 0) {
      return { ok: true, dbPath, changes: [], reason: 'already up to date' };
    }

    db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(JSON.stringify(data), STORAGE_KEY);
    return { ok: true, dbPath, changes };
  } catch (e) {
    return { ok: false, dbPath, changes: [], reason: `write failed: ${e.message}` };
  } finally {
    db.close();
  }
}
