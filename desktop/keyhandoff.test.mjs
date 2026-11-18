// Unit checks for the credential-protection bridge: the one-shot stdin
// handoff (encode/deliver/read), and the main-process key custody decision
// with an injected fake safeStorage. No OS keychain, no Electron runtime,
// and no real credentials are involved.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { decodeKeyHandoff, deliverKeyHandoff, encodeKeyHandoff, ensureVaultKey, readKeyHandoffStream } from './keyhandoff.mjs';

function fakeChild() {
  const stdin = new PassThrough();
  const chunks = [];
  stdin.on('data', chunk => chunks.push(chunk));
  return { child: { stdin }, written: () => Buffer.concat(chunks).toString('utf8') };
}

describe('key handoff channel encoding', () => {
  test('a DEK handoff round trips as one line and never as a file', () => {
    const dek = Buffer.from('ab'.repeat(32), 'hex');
    const line = encodeKeyHandoff({ dek });
    assert.ok(line.endsWith('\n'));
    assert.equal(line.split('\n').length, 2, 'exactly one line');
    const decoded = decodeKeyHandoff(line.slice(0, -1));
    assert.ok(Buffer.isBuffer(decoded.dek));
    assert.equal(decoded.dek.toString('hex'), 'ab'.repeat(32));
  });

  test('a null DEK handoff carries the unavailability reason', () => {
    const decoded = decodeKeyHandoff(encodeKeyHandoff({ dek: null, reason: 'safeStorage unavailable' }).trim());
    assert.equal(decoded.dek, null);
    assert.equal(decoded.reason, 'safeStorage unavailable');
  });

  test('malformed handoffs throw a reason without echoing the payload', () => {
    assert.throws(() => decodeKeyHandoff('{"dek":"ab"'), Error);
    assert.throws(() => decodeKeyHandoff('{"dek":"zz"}'), /malformed/);
    assert.throws(() => decodeKeyHandoff('[]'), /malformed/);
    assert.throws(() => decodeKeyHandoff('{"dek":"sk-plain-text-key"}'), /malformed/);
    assert.throws(() => decodeKeyHandoff('{"dek":null,"reason":42}'), /malformed/);
    assert.throws(() => encodeKeyHandoff({ dek: 'sk-not-a-buffer' }), TypeError);
  });

  test('deliverKeyHandoff writes exactly one line and closes the pipe', { timeout: 2000 }, async () => {
    const { child, written } = fakeChild();
    const ended = once(child.stdin, 'end');
    deliverKeyHandoff(child, { dek: Buffer.from('cd'.repeat(32), 'hex') });
    await ended;
    assert.equal(written(), JSON.stringify({ dek: 'cd'.repeat(32) }) + '\n', 'exactly one line');
  });
});

describe('key handoff channel reading', () => {
  function stream() {
    const source = new PassThrough();
    const result = readKeyHandoffStream(source, 200);
    return { source, result };
  }

  test('a delivered line resolves with the DEK buffer', async () => {
    const { source, result } = stream();
    source.write(encodeKeyHandoff({ dek: Buffer.from('ef'.repeat(32), 'hex') }));
    const handoff = await result;
    assert.equal(handoff.dek.toString('hex'), 'ef'.repeat(32));
  });

  test('a line split across chunks resolves once complete', async () => {
    const { source, result } = stream();
    const line = encodeKeyHandoff({ dek: Buffer.from('01'.repeat(32), 'hex') });
    source.write(line.slice(0, 10));
    source.write(line.slice(10));
    const handoff = await result;
    assert.equal(handoff.dek.toString('hex'), '01'.repeat(32));
  });

  test('an EOF without a line resolves unavailable, never plaintext', async () => {
    const { source, result } = stream();
    source.end();
    const handoff = await result;
    assert.equal(handoff.dek, null);
    assert.match(handoff.reason, /did not deliver/);
  });

  test('an EOF with a partial line resolves unavailable', async () => {
    const { source, result } = stream();
    source.end('{"dek":"ef');
    const handoff = await result;
    assert.equal(handoff.dek, null);
    assert.match(handoff.reason, /malformed|did not deliver/);
  });

  test('an oversize line without a newline resolves unavailable', async () => {
    const { source, result } = stream();
    source.write('x'.repeat(5000));
    const handoff = await result;
    assert.equal(handoff.dek, null);
    assert.match(handoff.reason, /malformed/);
  });

  test('a stream that never answers hits the timeout and resolves unavailable', async () => {
    const source = new PassThrough();
    const result = readKeyHandoffStream(source, 50);
    const handoff = await result;
    assert.equal(handoff.dek, null);
    assert.match(handoff.reason, /did not deliver/);
    source.end();
  });

  test('a stream error resolves unavailable', async () => {
    const source = new PassThrough();
    const result = readKeyHandoffStream(source, 5000);
    source.destroy(new Error('boom'));
    const handoff = await result;
    assert.equal(handoff.dek, null);
    assert.match(handoff.reason, /could not be read/);
  });
});

describe('main-process key custody with an injected safeStorage', () => {
  function fakeSafeStorage({ asyncAvailable = true, backend = undefined } = {}) {
    const state = { shouldReEncrypt: false, tag: 0 };
    return {
      state,
      async isAsyncEncryptionAvailable() { return asyncAvailable; },
      getSelectedStorageBackend() { return backend; },
      async encryptStringAsync(plain) {
        return Buffer.from(`enc:${state.tag++}:${plain}`);
      },
      async decryptStringAsync(blob) {
        const match = /^enc:([^:]+):(.*)$/.exec(blob.toString('utf8'));
        if (!match) throw new Error('not decryptable');
        return { result: match[2], shouldReEncrypt: state.shouldReEncrypt };
      },
    };
  }

  function keyFileOf(dataDir) {
    return join(dataDir, 'vault-key.json');
  }

  test('unavailable OS protection fails closed with a reason and writes nothing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'verity-custody-'));
    const boot = await ensureVaultKey({ safeStorage: fakeSafeStorage({ asyncAvailable: false }), dataDir });
    assert.equal(boot.dek, null);
    assert.match(boot.reason, /safeStorage.*unavailable/s);
    assert.ok(!existsSync(keyFileOf(dataDir)));
  });

  test('Linux basic_text fallback is rejected, a real backend is accepted', async () => {
    const weak = await ensureVaultKey({
      safeStorage: fakeSafeStorage({ backend: 'basic_text' }),
      dataDir: mkdtempSync(join(tmpdir(), 'verity-custody-')),
      platform: 'linux',
    });
    assert.equal(weak.dek, null);
    assert.match(weak.reason, /basic_text/);

    const strong = await ensureVaultKey({
      safeStorage: fakeSafeStorage({ backend: 'gnome_libsecret' }),
      dataDir: mkdtempSync(join(tmpdir(), 'verity-custody-')),
      platform: 'linux',
    });
    assert.equal(strong.dek.length, 32);
  });

  test('a fresh key is wrapped into the key file, never as plaintext hex', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'verity-custody-')), 'data');
    const boot = await ensureVaultKey({ safeStorage: fakeSafeStorage(), dataDir });
    assert.equal(boot.dek.length, 32);
    const raw = readFileSync(keyFileOf(dataDir), 'utf8');
    assert.ok(!raw.includes(boot.dek.toString('hex')), 'the raw DEK must never be written');
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['wrapped']);
  });

  test('an existing key is unwrapped and preserved; a rotated OS key is rewrapped in place', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'verity-custody-')), 'data');
    mkdirSync(dataDir, { recursive: true });
    const custody = fakeSafeStorage();
    const first = await ensureVaultKey({ safeStorage: custody, dataDir });
    const before = readFileSync(keyFileOf(dataDir), 'utf8');
    const second = await ensureVaultKey({ safeStorage: custody, dataDir });
    assert.equal(second.dek.toString('hex'), first.dek.toString('hex'));
    assert.equal(readFileSync(keyFileOf(dataDir), 'utf8'), before, 'no rewrite when the OS key did not rotate');

    // The OS rotated its key: the next unwrap asks for a re-wrap, the wrap
    // is refreshed in place for the same DEK, and the next boot converges.
    custody.state.shouldReEncrypt = true;
    custody.state.tag = 100;
    const rotated = await ensureVaultKey({ safeStorage: custody, dataDir });
    assert.equal(rotated.dek.toString('hex'), first.dek.toString('hex'), 'the same DEK survives the rotation');
    const after = readFileSync(keyFileOf(dataDir), 'utf8');
    assert.notEqual(after, before, 'the wrap is refreshed');
    assert.deepEqual(readdirSync(dataDir).filter(name => name.endsWith('.tmp')), [],
      'the rewrap leaves no temp files');

    custody.state.shouldReEncrypt = false;
    const third = await ensureVaultKey({ safeStorage: custody, dataDir });
    assert.equal(third.dek.toString('hex'), first.dek.toString('hex'));
    assert.equal(readFileSync(keyFileOf(dataDir), 'utf8'), after, 'a settled wrap is not rewritten again');
  });

  test('an unwrappable key file is replaced with a fresh key', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'verity-custody-')), 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(keyFileOf(dataDir), JSON.stringify({ wrapped: 'not-decryptable' }));
    const boot = await ensureVaultKey({ safeStorage: fakeSafeStorage(), dataDir });
    assert.equal(boot.dek.length, 32);
    const raw = readFileSync(keyFileOf(dataDir), 'utf8');
    assert.ok(!raw.includes('not-decryptable'));
    assert.ok(!raw.includes(boot.dek.toString('hex')));
  });

  test('a corrupt key file is replaced with a fresh key', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'verity-custody-')), 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(keyFileOf(dataDir), '{corrupt');
    const boot = await ensureVaultKey({ safeStorage: fakeSafeStorage(), dataDir });
    assert.equal(boot.dek.length, 32);
    const raw = readFileSync(keyFileOf(dataDir), 'utf8');
    assert.equal(typeof JSON.parse(raw).wrapped, 'string',
      'a fresh wrapped key replaces the corrupt bytes');
    assert.ok(!raw.includes(boot.dek.toString('hex')));
  });
});

// Spawn-level proof that the delivered line is one-shot and consumed: the
// child below is a plain Node process, the same shape main spawns.
test('a real spawned child reads exactly one line from the channel', async () => {
  const child = spawn(process.execPath, ['-e', `
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => {
      const line = Buffer.concat(chunks).toString('utf8').split('\\n')[0];
      process.stdout.write('CHILD_LINE_LEN:' + line.length);
    });
  `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  deliverKeyHandoff(child, { dek: Buffer.from('12'.repeat(32), 'hex') });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  await new Promise(done => child.on('exit', done));
  assert.equal(out, 'CHILD_LINE_LEN:' + JSON.stringify({ dek: '12'.repeat(32) }).length,
    'exactly the one handoff line arrived');
});
