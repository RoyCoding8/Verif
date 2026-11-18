// In-process checks for the combined provider/credential store: one durable
// record, one atomic write. Named scenarios carry expected verdicts for the
// persistence boundary: a late encryption failure or a persistence failure
// must preserve the previous settings and keys in memory and after a
// restart. All ciphers here are test doubles; no OS keychain and no real
// credentials are involved.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAesGcmCipher, absentCipher } from './keyhandoff.mjs';
import { createSettingsStore } from './settings.mjs';
import { OperationalError, ValidationError } from './errors.mjs';

function freshDir() {
  const dir = join(mkdtempSync(join(tmpdir(), 'verity-store-')), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const storeFile = dataDir => join(dataDir, 'settings.json');
const legacyVaultFile = dataDir => join(dataDir, 'credentials.vault.json');

function deterministicCipher() {
  const aes = createAesGcmCipher('42'.repeat(32));
  return { available: true, failNext: false, async encrypt(plain) {
    if (this.failNext) throw new Error('simulated mid-encryption failure');
    return aes.encrypt(plain);
  }, async decrypt(blob) { return aes.decrypt(blob); } };
}

const provider = (id, overrides = {}) => ({
  id, label: `Label ${id}`, protocol: 'openai-completions',
  baseUrl: `https://${id}.example.com/v1`, modelId: `m-${id}`, ...overrides,
});
const input = (providers, defaultProviderId = null, costCeilingUsd = 5) =>
  ({ providers, defaultProviderId, costCeilingUsd });

describe('combined settings and credential store', () => {
  let dataDir;
  beforeEach(() => { dataDir = freshDir(); });

  test('providers and keys survive a reload from one record', async () => {
    const first = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    await first.update(input([provider('a', { apiKey: 'sk-a' }), provider('b', { apiKey: 'sk-b' })], 'a', 3));
    const second = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    const view = second.view();
    assert.deepEqual(view.providers.map(({ hasApiKey, ...rest }) => rest),
      [provider('a'), provider('b')]);
    assert.deepEqual(view.providers.map(entry => entry.hasApiKey), [true, true]);
    assert.equal(view.defaultProviderId, 'a');
    assert.equal(view.costCeilingUsd, 3);
    assert.equal(await second.routeConfig().then(route => route.apiKey), 'sk-a');
  });

  test('secrets round trip and never appear as plaintext in the record', async () => {
    const store = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    await store.update(input([provider('prov', { apiKey: 'sk-plain-secret-value' })], 'prov'));
    assert.equal(await store.routeConfig().then(route => route.apiKey), 'sk-plain-secret-value');
    assert.ok(!readFileSync(storeFile(dataDir), 'utf8').includes('sk-plain-secret-value'));
  });

  test('an omitted or empty apiKey preserves the stored credential, a new one replaces it', async () => {
    const store = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    await store.update(input([provider('a', { apiKey: 'sk-first' })]));
    const blobBefore = JSON.parse(readFileSync(storeFile(dataDir), 'utf8')).credentials.a;
    await store.update(input([provider('a')]));
    assert.equal(JSON.parse(readFileSync(storeFile(dataDir), 'utf8')).credentials.a, blobBefore);
    await store.update(input([provider('a', { apiKey: 'sk-second' })]));
    assert.notEqual(JSON.parse(readFileSync(storeFile(dataDir), 'utf8')).credentials.a, blobBefore);
    assert.ok(!readFileSync(storeFile(dataDir), 'utf8').includes('sk-second'));
  });

  test('removing an entry deletes its stored credential in the same record', async () => {
    const store = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    await store.update(input([provider('keep', { apiKey: 'sk-k' }), provider('stale', { apiKey: 'sk-s' })], 'keep'));
    await store.update(input([provider('keep', { apiKey: 'sk-k' })], 'keep'));
    const credentials = JSON.parse(readFileSync(storeFile(dataDir), 'utf8')).credentials;
    assert.equal(credentials.stale, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(await store.routeConfig())),
      { ...provider('keep'), apiKey: 'sk-k', keyStored: true, ceilingUsd: 5 });
  });

  test('fail-before/pass-after: a late encryption failure preserves the prior key and settings in memory and after restart', async () => {
    const cipher = deterministicCipher();
    const first = createSettingsStore({ dataDir, cipher });
    await first.update(input([provider('a', { apiKey: 'sk-old-a' })], 'a'));
    const viewBefore = first.view();
    const recordBefore = readFileSync(storeFile(dataDir), 'utf8');

    // Two-provider save where the second encrypt fails mid-update.
    cipher.failNext = true;
    await assert.rejects(first.update(input([
      provider('a', { apiKey: 'sk-new-a' }),
      provider('b', { apiKey: 'sk-b' }),
    ])), /simulated mid-encryption failure/);
    cipher.failNext = false;

    assert.deepEqual(first.view(), viewBefore,
      'the in-memory view must be exactly the prior state after a late failure');
    assert.equal(readFileSync(storeFile(dataDir), 'utf8'), recordBefore,
      'the durable record must be byte-identical after a late failure');
    assert.equal(await first.routeConfig().then(route => route.apiKey), 'sk-old-a');

    const second = createSettingsStore({ dataDir, cipher });
    assert.deepEqual(second.view(), viewBefore, 'the prior state must survive a restart');
    assert.equal(await second.routeConfig().then(route => route.apiKey), 'sk-old-a');
  });

  test('a failed persistence preserves prior state in memory and on disk', async () => {
    const store = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    await store.update(input([provider('a', { apiKey: 'sk-old-a' })], 'a'));
    const viewBefore = store.view();
    const recordBefore = readFileSync(storeFile(dataDir), 'utf8');

    // Make the next durable write impossible: the record file read-only
    // (Windows refuses the rename over it) or the directory read-only
    // (POSIX refuses the temp write). One blocker per platform, same
    // observable behavior: the update fails and nothing changes.
    if (process.platform === 'win32') chmodSync(storeFile(dataDir), 0o444);
    else chmodSync(dataDir, 0o500);
    try {
      await assert.rejects(store.update(input([provider('a', { apiKey: 'sk-new-a' })], 'a')),
        'the persistence failure must surface as an operational error');
    } finally {
      if (process.platform === 'win32') chmodSync(storeFile(dataDir), 0o666);
      else chmodSync(dataDir, 0o700);
    }
    assert.deepEqual(store.view(), viewBefore,
      'in-memory state must stay the prior state when persistence fails');
    assert.equal(await store.routeConfig().then(route => route.apiKey), 'sk-old-a');

    const restarted = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    assert.deepEqual(restarted.view(), viewBefore, 'the prior state must survive the failed save');
    assert.equal(await restarted.routeConfig().then(route => route.apiKey), 'sk-old-a');
  });

  test('interleaved updates serialize and converge to one consistent record', async () => {
    const store = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    await Promise.all([
      store.update(input([provider('a', { apiKey: 'sk-a' })])),
      store.update(input([provider('b', { apiKey: 'sk-b' })])),
      store.update(input([provider('c', { apiKey: 'sk-c' })])),
    ]);
    // Full-list replacement semantics: the last accepted update wins whole,
    // and the durable record always matches exactly one accepted view.
    const credentials = JSON.parse(readFileSync(storeFile(dataDir), 'utf8')).credentials;
    assert.equal(Object.keys(credentials).length, 1);
    assert.deepEqual(store.view().providers.map(entry => entry.id),
      Object.keys(credentials));
  });

  test('a successful update leaves no temp files behind', async () => {
    const store = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    await store.update(input([provider('a', { apiKey: 'sk-a' })]));
    assert.deepEqual(readdirSync(dataDir).filter(name => name.endsWith('.tmp')), []);
  });

  test('invalid input is rejected before any state or bytes change', async () => {
    const store = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    await store.update(input([provider('a', { apiKey: 'sk-a' })], 'a'));
    const recordBefore = readFileSync(storeFile(dataDir), 'utf8');
    await assert.rejects(store.update(input([provider('../escape')])), ValidationError);
    await assert.rejects(store.update(input([provider('a', { apiKey: 'bad\u0000key' })])), ValidationError);
    await assert.rejects(store.update(input([provider('a')], 'ghost')), ValidationError);
    await assert.rejects(store.update(input([], null, 0)), ValidationError);
    assert.equal(readFileSync(storeFile(dataDir), 'utf8'), recordBefore);
    assert.equal(await store.routeConfig().then(route => route.apiKey), 'sk-a');
  });
});

describe('store without credential protection', () => {
  let dataDir;
  beforeEach(() => { dataDir = freshDir(); });

  test('secret writes are refused clearly and prior state is untouched', async () => {
    const store = createSettingsStore({ dataDir, cipher: absentCipher('no protection here') });
    await store.update(input([provider('meta')]));
    await assert.rejects(store.update(input([provider('meta', { apiKey: 'sk-real' })])), error => {
      assert.ok(error instanceof OperationalError);
      assert.match(error.message, /credential storage is unavailable/);
      assert.match(error.message, /no protection here/);
      return true;
    });
    assert.deepEqual(store.view().providers.map(entry => entry.hasApiKey), [false]);
    assert.deepEqual(store.status(), { available: false, reason: 'no protection here' });
  });

  test('metadata-only updates still work without a cipher and drop removed credentials', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(storeFile(dataDir), JSON.stringify({
      version: 1,
      providers: [{ id: 'gone', label: 'G', protocol: 'openai-completions', baseUrl: 'https://g.example.com/v1', modelId: 'm' }],
      defaultProviderId: null,
      costCeilingUsd: null,
    }));
    writeFileSync(legacyVaultFile(dataDir),
      JSON.stringify({ version: 1, entries: { gone: 'legacy-blob' } }));
    const store = createSettingsStore({ dataDir, cipher: absentCipher('no protection here') });
    await store.update(input([provider('meta')]));
    const record = JSON.parse(readFileSync(storeFile(dataDir), 'utf8'));
    assert.equal(record.version, 2);
    assert.equal(record.credentials.gone, undefined,
      'a removed entry leaves no credential behind, even without a cipher');
  });
});

describe('legacy record migration', () => {
  test('a version-1 record adopts matching entries from the untouched legacy vault file', async () => {
    const dataDir = freshDir();
    const aes = createAesGcmCipher('42'.repeat(32));
    const blob = await aes.encrypt('sk-legacy-a');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(storeFile(dataDir), JSON.stringify({
      version: 1,
      providers: [{ id: 'a', label: 'A', protocol: 'openai-completions', baseUrl: 'https://a.example.com/v1', modelId: 'm-a' }],
      defaultProviderId: 'a',
      costCeilingUsd: 2,
    }));
    writeFileSync(legacyVaultFile(dataDir), JSON.stringify({ version: 1, entries: { a: blob, orphan: 'legacy-blob' } }));
    const legacyBefore = readFileSync(legacyVaultFile(dataDir), 'utf8');

    const store = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    assert.equal(await store.routeConfig().then(route => route.apiKey), 'sk-legacy-a',
      'the legacy credential is adopted for its matching provider');
    assert.deepEqual(store.view().providers.map(entry => entry.hasApiKey), [true]);
    assert.equal(store.view().defaultProviderId, 'a');

    // Legacy bytes stay untouched until a successful update writes version 2.
    assert.equal(readFileSync(legacyVaultFile(dataDir), 'utf8'), legacyBefore);
    await store.update(input([provider('a', { apiKey: 'sk-new-a' })], 'a'));
    const record = JSON.parse(readFileSync(storeFile(dataDir), 'utf8'));
    assert.equal(record.version, 2);
    assert.equal(await createSettingsStore({ dataDir, cipher: deterministicCipher() })
      .routeConfig().then(route => route.apiKey), 'sk-new-a');
  });

  test('an unreadable legacy vault is left alone and the metadata still loads', async () => {
    const dataDir = freshDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(storeFile(dataDir), JSON.stringify({
      version: 1,
      providers: [{ id: 'a', label: 'A', protocol: 'openai-completions', baseUrl: 'https://a.example.com/v1', modelId: 'm-a' }],
      defaultProviderId: null,
      costCeilingUsd: null,
    }));
    writeFileSync(legacyVaultFile(dataDir), '{corrupt');
    const store = createSettingsStore({ dataDir, cipher: deterministicCipher() });
    assert.deepEqual(store.view().providers.map(entry => entry.hasApiKey), [false]);
    assert.equal(readFileSync(legacyVaultFile(dataDir), 'utf8'), '{corrupt');
  });
});

describe('AES-GCM cipher', () => {
  test('round trips and detects tampering', async () => {
    const cipher = createAesGcmCipher('cd'.repeat(32));
    const blob = await cipher.encrypt('sk-roundtrip');
    assert.equal(await cipher.decrypt(blob), 'sk-roundtrip');
    const tampered = blob.slice(0, blob.length - 4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await assert.rejects(cipher.decrypt(tampered));
  });

  test('two encryptions of the same secret produce different blobs', async () => {
    const cipher = createAesGcmCipher('cd'.repeat(32));
    assert.notEqual(await cipher.encrypt('sk-same'), await cipher.encrypt('sk-same'));
  });

  test('an unreadable blob surfaces as absent, never as key material', async () => {
    const dataDir = freshDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(storeFile(dataDir), JSON.stringify({
      version: 2,
      providers: [{ id: 'prov', label: 'P', protocol: 'openai-completions', baseUrl: 'https://p.example.com', modelId: 'm' }],
      defaultProviderId: 'prov',
      costCeilingUsd: null,
      credentials: { prov: 'not-a-real-blob' },
    }));
    const store = createSettingsStore({ dataDir, cipher: createAesGcmCipher('ef'.repeat(32)) });
    assert.equal(store.view().providers.map(entry => entry.hasApiKey)[0], true);
    assert.equal(await store.routeConfig().then(route => route.apiKey), undefined,
      'the unreadable blob surfaces as absent, never as key material');
  });
});
