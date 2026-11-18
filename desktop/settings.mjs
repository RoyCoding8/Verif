// Provider settings and credential storage: one durable record, one atomic
// write. The record holds provider metadata and the encrypted credential
// blobs together, so a multi-provider save that fails mid-encryption, or a
// persistence failure, leaves both the previous configuration and the
// previous keys fully intact in memory and on disk. Blobs are ciphertext
// produced by the injected cipher (OS-protected key material via the
// desktop shell); views never echo key material.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationError, OperationalError } from './errors.mjs';

const STORE_FILE = 'settings.json';
const LEGACY_VAULT_FILE = 'credentials.vault.json';
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const MAX_PROVIDERS = 64;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function createSettingsStore({ dataDir, cipher }) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('settings store requires a dataDir');
  if (!cipher || typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function'
    || typeof cipher.available !== 'boolean') {
    throw new TypeError('settings store requires a cipher with available/encrypt/decrypt');
  }
  const file = join(dataDir, STORE_FILE);
  let state = load(file, join(dataDir, LEGACY_VAULT_FILE));

  let queue = Promise.resolve();
  const serialized = operation => {
    const run = queue.then(operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  function persist(next) {
    mkdirSync(dataDir, { recursive: true });
    const temp = join(dataDir, `.${STORE_FILE}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    writeFileSync(temp, JSON.stringify({ version: 2, ...next }, null, 2));
    renameSync(temp, file);
  }

  return {
    status() {
      return cipher.available ? { available: true } : { available: false, reason: cipher.reason };
    },

    // Fully redacted view: ids and key presence only, never key material.
    view() {
      return {
        providers: state.providers.map(provider => ({
          id: provider.id,
          label: provider.label,
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          modelId: provider.modelId,
          hasApiKey: hasCredential(provider.id),
        })),
        defaultProviderId: state.defaultProviderId,
        costCeilingUsd: state.costCeilingUsd,
        credentialStorage: this.status(),
      };
    },

    // Selected route for readiness and runs, or null when nothing is saved.
    async routeConfig() {
      if (!state.defaultProviderId) return null;
      const provider = state.providers.find(entry => entry.id === state.defaultProviderId);
      if (!provider) return null;
      return {
        ...provider,
        apiKey: await readCredential(provider.id),
        keyStored: hasCredential(provider.id),
        ceilingUsd: state.costCeilingUsd,
      };
    },

    // The next state is computed and encrypted in memory first; only a fully
    // encrypted state reaches the single atomic write. Any failure before
    // that write leaves state (memory and disk) exactly as it was.
    update(input) {
      return serialized(async () => {
        const next = validate(input); // throws ValidationError before anything changes
        const keep = new Set(next.providers.map(provider => provider.id));
        const credentials = { ...state.credentials };
        for (const provider of next.providers) {
          if (provider.apiKey !== undefined) {
            if (!cipher.available) {
              throw new OperationalError(
                `credential storage is unavailable, so the key for ${provider.id} cannot be saved: ${cipher.reason}`);
            }
            credentials[provider.id] = await cipher.encrypt(provider.apiKey);
          }
        }
        for (const id of Object.keys(credentials)) {
          if (!keep.has(id)) delete credentials[id]; // full-list replacement
        }
        const nextState = {
          providers: next.providers.map(({ apiKey, ...rest }) => rest),
          defaultProviderId: next.defaultProviderId,
          costCeilingUsd: next.costCeilingUsd,
          credentials,
        };
        persist(nextState);
        state = nextState;
        return this.view();
      });
    },
  };

  function hasCredential(id) {
    return typeof state.credentials[id] === 'string';
  }

  // Unreadable blobs surface as absent: never as an error carrying material.
  async function readCredential(id) {
    const blob = state.credentials[id];
    if (typeof blob !== 'string') return undefined;
    try {
      return await cipher.decrypt(blob);
    } catch {
      return undefined;
    }
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function validate(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('settings must be a JSON object');
  }
  const { providers, defaultProviderId, costCeilingUsd } = input;
  if (!Array.isArray(providers)) throw new ValidationError('providers must be an array');
  if (providers.length > MAX_PROVIDERS) throw new ValidationError(`at most ${MAX_PROVIDERS} providers are supported`);
  const seen = new Set();
  const clean = providers.map((provider, index) => {
    const where = `providers[${index}]`;
    if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) {
      throw new ValidationError(`${where} must be an object`);
    }
    const { id, label, protocol, baseUrl, modelId, apiKey } = provider;
    if (typeof id !== 'string' || !PROVIDER_ID.test(id)) {
      throw new ValidationError(`${where}.id must be 1-64 chars of letters, digits, dot, dash or underscore, starting with a letter or digit`);
    }
    if (seen.has(id)) throw new ValidationError(`${where}.id is duplicated`);
    seen.add(id);
    if (typeof label !== 'string' || label.trim().length === 0 || label.length > 200) {
      throw new ValidationError(`${where}.label must be a non-empty string of at most 200 chars`);
    }
    if (!PROTOCOLS.includes(protocol)) {
      throw new ValidationError(`${where}.protocol must be one of ${PROTOCOLS.join(', ')}`);
    }
    if (typeof baseUrl !== 'string' || baseUrl.length === 0 || baseUrl.length > 2048 || !isHttpUrl(baseUrl)) {
      throw new ValidationError(`${where}.baseUrl must be an http(s) URL`);
    }
    if (typeof modelId !== 'string' || modelId.length === 0 || modelId.length > 200
      || /[\u0000-\u001f\u007f]/.test(modelId)) {
      throw new ValidationError(`${where}.modelId must be a non-empty string of at most 200 chars`);
    }
    // An omitted, null, or empty apiKey preserves the stored key for this id.
    if (apiKey === undefined || apiKey === null || apiKey === '') return { id, label, protocol, baseUrl, modelId };
    if (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) {
      throw new ValidationError(`${where}.apiKey must be a string of at most 4096 chars without control characters`);
    }
    return { id, label, protocol, baseUrl, modelId, apiKey };
  });
  if (defaultProviderId !== undefined && defaultProviderId !== null
    && (typeof defaultProviderId !== 'string' || !seen.has(defaultProviderId))) {
    throw new ValidationError('defaultProviderId must reference a provider in this list or be null');
  }
  if (costCeilingUsd !== undefined && costCeilingUsd !== null
    && !(typeof costCeilingUsd === 'number' && Number.isFinite(costCeilingUsd) && costCeilingUsd > 0)) {
    throw new ValidationError('costCeilingUsd must be a positive finite number or null');
  }
  return {
    providers: clean,
    defaultProviderId: typeof defaultProviderId === 'string' ? defaultProviderId : null,
    costCeilingUsd: costCeilingUsd ?? null,
  };
}

// Loading is conservative: a version-2 record wins outright; a legacy
// version-1 record adopts matching entries from the untouched legacy vault
// file (same DEK) and both legacy files stay on disk until the first
// successful update writes version 2. Nothing is ever deleted on load.
function load(file, legacyVaultFile) {
  let metadata;
  let credentials = {};
  let sawRecord = false;
  let isVersion2 = false;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      sawRecord = true;
      metadata = sanitize(raw);
      isVersion2 = raw.version === 2;
      if (isVersion2 && raw.credentials && typeof raw.credentials === 'object'
        && !Array.isArray(raw.credentials)) {
        for (const [id, blob] of Object.entries(raw.credentials)) {
          if (typeof blob === 'string') credentials[id] = blob;
        }
      }
    }
  } catch {
    // An absent or unreadable store starts empty; it is only rewritten on a
    // successful update, so a corrupt file is never silently destroyed.
  }
  if (!sawRecord || !isVersion2) {
    // Legacy layout: credentials live in the separate vault file.
    credentials = { ...readLegacyEntries(legacyVaultFile, metadata), ...credentials };
  }
  return {
    providers: metadata?.providers ?? [],
    defaultProviderId: metadata?.defaultProviderId ?? null,
    costCeilingUsd: metadata?.costCeilingUsd ?? null,
    credentials,
  };
}

function readLegacyEntries(file, metadata) {
  if (!metadata || metadata.providers.length === 0 || !existsSync(file)) return {};
  const known = new Set(metadata.providers.map(provider => provider.id));
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.entries : null;
    if (!entries || typeof entries !== 'object') return {};
    const adopted = {};
    for (const [id, blob] of Object.entries(entries)) {
      if (known.has(id) && typeof blob === 'string') adopted[id] = blob;
    }
    return adopted;
  } catch {
    // An unreadable legacy vault is left exactly as it is on disk.
    return {};
  }
}

function sanitize(raw) {
  const providers = (Array.isArray(raw?.providers) ? raw.providers : [])
    .filter(provider => provider && typeof provider === 'object' && !Array.isArray(provider)
      && typeof provider.id === 'string' && PROVIDER_ID.test(provider.id)
      && typeof provider.label === 'string' && provider.label.length > 0 && provider.label.length <= 200
      && PROTOCOLS.includes(provider.protocol)
      && typeof provider.baseUrl === 'string' && isHttpUrl(provider.baseUrl)
      && typeof provider.modelId === 'string' && provider.modelId.length > 0 && provider.modelId.length <= 200)
    .map(({ id, label, protocol, baseUrl, modelId }) => ({ id, label, protocol, baseUrl, modelId }));
  const ids = new Set(providers.map(provider => provider.id));
  return {
    providers,
    defaultProviderId: typeof raw?.defaultProviderId === 'string' && ids.has(raw.defaultProviderId)
      ? raw.defaultProviderId
      : null,
    costCeilingUsd: typeof raw?.costCeilingUsd === 'number' && Number.isFinite(raw.costCeilingUsd) && raw.costCeilingUsd > 0
      ? raw.costCeilingUsd
      : null,
  };
}
