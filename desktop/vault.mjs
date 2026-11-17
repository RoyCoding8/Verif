// Credential vault: provider API keys live here as opaque blobs keyed by
// provider id. The cipher is injected by the host process (Electron main via
// a one-shot wrapped-DEK handoff, or an explicit test cipher for headless
// verification). There is no plaintext fallback: without a cipher the vault
// refuses secret writes and reports why, and prior settings survive.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OperationalError, ValidationError } from './errors.mjs';

const VAULT_FILE = 'credentials.vault.json';

export function createVault({ dataDir, cipher }) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('vault requires a dataDir');
  if (!cipher || typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function'
    || typeof cipher.available !== 'boolean') {
    throw new TypeError('vault requires a cipher with available/encrypt/decrypt');
  }
  const file = join(dataDir, VAULT_FILE);
  const entries = readEntries(file);

  function persist() {
    mkdirSync(dataDir, { recursive: true });
    const temp = join(dataDir, `.${VAULT_FILE}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    writeFileSync(temp, JSON.stringify({ version: 1, entries }));
    renameSync(temp, file);
  }

  let queue = Promise.resolve();
  const serialized = operation => {
    const run = queue.then(operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  // Mutations snapshot the entry map and roll it back when the durable write
  // fails, so in-memory state never diverges from what a reload would see.
  const withRollback = mutate => {
    const snapshot = { ...entries };
    try {
      mutate();
      persist();
    } catch (error) {
      for (const key of Object.keys(entries)) delete entries[key];
      Object.assign(entries, snapshot);
      throw error;
    }
  };

  return {
    status() {
      return cipher.available ? { available: true } : { available: false, reason: cipher.reason };
    },
    ids() {
      return Object.keys(entries).sort();
    },
    has(id) {
      return Object.prototype.hasOwnProperty.call(entries, id);
    },
    // Unreadable blobs surface as absent: never as an error carrying material.
    get(id) {
      return serialized(async () => {
        const blob = entries[id];
        if (typeof blob !== 'string') return undefined;
        try {
          return await cipher.decrypt(blob);
        } catch {
          return undefined;
        }
      });
    },
    set(id, plain) {
      return serialized(async () => {
        if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
          throw new ValidationError('credential id must be 1-64 chars of letters, digits, dot, dash or underscore');
        }
        if (typeof plain !== 'string' || plain.length === 0 || plain.length > 4096
          || /[\u0000-\u001f\u007f]/.test(plain)) {
          throw new ValidationError('credential value must be a string of at most 4096 chars without control characters');
        }
        if (!cipher.available) {
          throw new OperationalError(`credential storage is unavailable, so the key for ${id} cannot be saved: ${cipher.reason}`);
        }
        const blob = await cipher.encrypt(plain);
        withRollback(() => { entries[id] = blob; });
      });
    },
    remove(id) {
      return serialized(async () => {
        if (!Object.prototype.hasOwnProperty.call(entries, id)) return;
        withRollback(() => { delete entries[id]; });
      });
    },
    retain(ids) {
      return serialized(async () => {
        const keep = new Set(ids);
        const stale = Object.keys(entries).filter(id => !keep.has(id));
        if (stale.length === 0) return;
        withRollback(() => {
          for (const id of stale) delete entries[id];
        });
      });
    },
  };
}

// Unreadable-blob and cipher failures are surfaced by get() as absent; only
// write refusals and durable-write failures propagate as errors.

function readEntries(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.version === 1
      && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)) {
      return { ...raw.entries };
    }
  } catch {
    // An absent or unreadable vault starts empty. The file is only rewritten
    // on a successful credential mutation; nothing is destroyed on boot.
  }
  return {};
}
