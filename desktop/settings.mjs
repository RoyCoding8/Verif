// Settings store: non-secret provider routing preferences with full-list
// replacement semantics. Key material lives only in the vault; settings.json
// never contains it. Updates validate the whole next state, then change
// credentials first and settings second, so a failed update leaves the
// previous provider configuration and keys intact.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationError } from './errors.mjs';

const SETTINGS_FILE = 'settings.json';
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const MAX_PROVIDERS = 64;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function createSettingsStore({ dataDir, vault }) {
  if (!vault || typeof vault.has !== 'function') throw new TypeError('settings store requires a vault');
  const file = join(dataDir, SETTINGS_FILE);
  let state = load(file);

  let queue = Promise.resolve();
  const serialized = operation => {
    const run = queue.then(operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  function persist() {
    mkdirSync(dataDir, { recursive: true });
    const temp = join(dataDir, `.${SETTINGS_FILE}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    writeFileSync(temp, JSON.stringify({ version: 1, ...state }, null, 2));
    renameSync(temp, file);
  }

  return {
    view() {
      return {
        providers: state.providers.map(provider => ({
          id: provider.id,
          label: provider.label,
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          modelId: provider.modelId,
          hasApiKey: vault.has(provider.id),
        })),
        defaultProviderId: state.defaultProviderId,
        costCeilingUsd: state.costCeilingUsd,
        credentialStorage: vault.status(),
      };
    },

    // Selected route for readiness and runs, or null when nothing is saved.
    async routeConfig() {
      if (!state.defaultProviderId) return null;
      const provider = state.providers.find(entry => entry.id === state.defaultProviderId);
      if (!provider) return null;
      return {
        ...provider,
        apiKey: await vault.get(provider.id),
        keyStored: vault.has(provider.id),
        ceilingUsd: state.costCeilingUsd,
      };
    },

    update(input) {
      return serialized(async () => {
        const next = validate(input); // throws ValidationError before anything changes
        const keep = new Set(next.providers.map(provider => provider.id));

        // Credential changes first: their failure must not touch settings.
        for (const provider of next.providers) {
          if (provider.apiKey !== undefined) await vault.set(provider.id, provider.apiKey);
        }
        await vault.retain([...keep]); // full-list replacement: drop removed entries' keys
        const state2 = {
          providers: next.providers.map(({ apiKey, ...rest }) => rest),
          defaultProviderId: next.defaultProviderId,
          costCeilingUsd: next.costCeilingUsd,
        };
        state = state2;
        persist();
        return this.view();
      });
    },
  };
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

function load(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return sanitize(raw);
  } catch {
    // Absent or unreadable settings start empty; the file is only written on
    // a successful update, so a corrupt file is never silently destroyed.
    return { providers: [], defaultProviderId: null, costCeilingUsd: null };
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
