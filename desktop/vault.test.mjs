// Unit checks for the credential vault and the key handoff: cipher
// round trips, durability, refusal without a cipher, and rollback on failed
// durable writes. No real credentials and no OS keychain are involved.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault } from './vault.mjs';
import { absentCipher, createAesGcmCipher, readKeyHandoffFile, writeKeyHandoffFile } from './keyhandoff.mjs';
import { OperationalError, ValidationError } from './errors.mjs';

function freshDir() {
  const dir = join(mkdtempSync(join(tmpdir(), 'verity-vault-')), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Deterministic, reversible cipher: byte equality of blobs is meaningful.
const deterministicCipher = () => ({
  available: true,
  async encrypt(plain) {
    return Buffer.from([...plain].reverse().join(''), 'utf8').toString('base64');
  },
  async decrypt(blob) {
    return [...Buffer.from(blob, 'base64').toString('utf8')].reverse().join('');
  },
});

const vaultFile = dataDir => join(dataDir, 'credentials.vault.json');

describe('credential vault with an injected cipher', () => {
  let dataDir;
  beforeEach(() => { dataDir = freshDir(); });

  test('secrets round trip through the cipher and never appear on disk', async () => {
    const vault = createVault({ dataDir, cipher: deterministicCipher() });
    await vault.set('prov-1', 'sk-plain-secret-value');
    assert.equal(await vault.get('prov-1'), 'sk-plain-secret-value');
    assert.ok(!readFileSync(vaultFile(dataDir), 'utf8').includes('sk-plain-secret-value'));
  });

  test('entries survive a reload from disk', async () => {
    const first = createVault({ dataDir, cipher: deterministicCipher() });
    await first.set('prov-1', 'sk-one');
    await first.set('prov-2', 'sk-two');
    const second = createVault({ dataDir, cipher: deterministicCipher() });
    assert.deepEqual(second.ids(), ['prov-1', 'prov-2']);
    assert.equal(await second.get('prov-1'), 'sk-one');
    assert.equal(await second.get('prov-2'), 'sk-two');
  });

  test('an unreadable blob surfaces as absent, never as key material', async () => {
    writeFileSync(vaultFile(dataDir), JSON.stringify({ version: 1, entries: { prov: 'not-a-real-blob' } }));
    const vault = createVault({ dataDir, cipher: createAesGcmCipher('ef'.repeat(32)) });
    assert.equal(await vault.get('prov'), undefined);
    assert.equal(vault.has('prov'), true);
  });

  test('retain drops only stale entries and persists exactly one file', async () => {
    const vault = createVault({ dataDir, cipher: deterministicCipher() });
    await vault.set('keep-a', 'sk-a');
    await vault.set('stale', 'sk-stale');
    await vault.retain(['keep-a']);
    assert.deepEqual(vault.ids(), ['keep-a']);
    assert.equal(await vault.get('keep-a'), 'sk-a');
    const leftovers = readdirSync(dataDir).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'atomic writes leave no temp files behind');
  });

  test('interleaved mutations serialize and converge to a consistent state', async () => {
    const vault = createVault({ dataDir, cipher: deterministicCipher() });
    await Promise.all([
      vault.set('a', 'sk-a'),
      vault.set('b', 'sk-b'),
      vault.remove('a'),
      vault.set('c', 'sk-c'),
    ]);
    assert.deepEqual(vault.ids(), ['b', 'c']);
    const reloaded = createVault({ dataDir, cipher: deterministicCipher() });
    assert.deepEqual(reloaded.ids(), ['b', 'c']);
  });

  test('invalid ids and values are rejected without touching storage', async () => {
    const vault = createVault({ dataDir, cipher: deterministicCipher() });
    await assert.rejects(vault.set('../escape', 'sk-x'), ValidationError);
    await assert.rejects(vault.set('ok', ''), ValidationError);
    await assert.rejects(vault.set('ok', 'bad\u0000key'), ValidationError);
    assert.deepEqual(vault.ids(), []);
  });

  test('a failed durable write rolls back in-memory state', async () => {
    const vault = createVault({ dataDir, cipher: deterministicCipher() });
    await vault.set('a', 'sk-a');
    // Make persistence impossible after a successful load: occupy the vault
    // file path with a directory.
    rmSync(vaultFile(dataDir));
    mkdirSync(vaultFile(dataDir));
    await assert.rejects(vault.set('b', 'sk-b'));
    // In-memory rollback: the failed entry is absent even though set ran.
    assert.equal(vault.has('b'), false);
    assert.deepEqual(vault.ids(), ['a']);
    // And the blocked path was not overwritten with a file.
    assert.ok(readdirSync(vaultFile(dataDir)).length === 0);
  });
});

describe('vault without credential protection', () => {
  let dataDir;
  beforeEach(() => { dataDir = freshDir(); });

  test('secret writes are refused clearly and prior state is untouched', async () => {
    const vault = createVault({ dataDir, cipher: absentCipher('no protection here') });
    await assert.rejects(vault.set('prov', 'sk-real'), error => {
      assert.ok(error instanceof OperationalError);
      assert.match(error.message, /credential storage is unavailable/);
      assert.match(error.message, /no protection here/);
      return true;
    });
    assert.equal(vault.has('prov'), false);
    assert.deepEqual(vault.status(), { available: false, reason: 'no protection here' });
  });

  test('removal still works without a cipher (it only drops secrets)', async () => {
    writeFileSync(vaultFile(dataDir), JSON.stringify({ version: 1, entries: { old: 'blob' } }));
    const vault = createVault({ dataDir, cipher: absentCipher('no protection here') });
    await vault.remove('old');
    assert.deepEqual(vault.ids(), []);
  });
});

describe('one-shot key handoff and AES-GCM cipher', () => {
  test('handoff round trips through a consumed-on-read file', () => {
    const dir = freshDir();
    const file = join(dir, 'dek.handoff');
    writeKeyHandoffFile(file, { dek: 'ab'.repeat(32) });
    const handoff = readKeyHandoffFile(file);
    assert.equal(handoff.dek, 'ab'.repeat(32));
    assert.ok(!existsSync(file), 'the carrier file is deleted on read');
  });

  test('a null dek handoff carries the unavailability reason and is deleted', () => {
    const dir = freshDir();
    const file = join(dir, 'dek.handoff');
    writeKeyHandoffFile(file, { dek: null, reason: 'safeStorage unavailable' });
    const handoff = readKeyHandoffFile(file);
    assert.deepEqual(handoff, { dek: null, reason: 'safeStorage unavailable' });
    assert.ok(!existsSync(file));
  });

  test('a malformed handoff fails loudly and the carrier file is still deleted', () => {
    const dir = freshDir();
    const file = join(dir, 'dek.handoff');
    writeFileSync(file, '{"dek":"ab"');
    assert.throws(() => readKeyHandoffFile(file));
    assert.ok(!existsSync(file));
  });

  test('AES-GCM cipher round trips and detects tampering', async () => {
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
});
