// Credential-protection bridge between the Electron main process and the
// backend child, plus the key custody main performs with safeStorage.
//
// Main wraps a random 32-byte data-encryption key with safeStorage
// (OS-protected at rest) and passes the unwrapped key exactly once over an
// inherited spawn channel: a single JSON line on the child's stdin, written
// by deliverKeyHandoff() and read by readKeyHandoffStream(). No file,
// argument, or environment variable ever carries the raw key, so an
// interrupted boot leaves nothing behind for a later run to sweep.
//
// A weak or absent OS protection fails closed: the child reports credential
// storage unavailable, refuses secret writes, and prior settings survive.
// There is no plaintext fallback and no test bypass flag; headless
// verification injects an explicit cipher through startServer's module API.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY_HEX = /^[0-9a-f]{64}$/;
const HANDOFF_LINE_LIMIT = 4096;

// Main side: serialize the one-shot handoff as a single newline-terminated
// line. The caller owns the channel; nothing here touches the filesystem.
export function encodeKeyHandoff(handoff) {
  if (!handoff || typeof handoff !== 'object') throw new TypeError('key handoff must be an object');
  const dek = handoff.dek;
  if (dek !== null && !(Buffer.isBuffer(dek) && dek.length === 32)) {
    throw new TypeError('key handoff dek must be a 32-byte buffer or null');
  }
  if (handoff.reason !== undefined && typeof handoff.reason !== 'string') {
    throw new TypeError('key handoff reason must be a string');
  }
  return JSON.stringify({
    dek: dek === null ? null : dek.toString('hex'),
    ...(handoff.reason ? { reason: handoff.reason } : {}),
  }) + '\n';
}

// Main side: deliver the handoff over the child's stdin and close it.
// Delivery errors (a child that died before reading) must not crash main.
export function deliverKeyHandoff(child, handoff) {
  child.stdin.on('error', () => {});
  child.stdin.end(encodeKeyHandoff(handoff));
}

// Child side: read exactly one line from the channel. Resolves (never
// rejects) with { dek: Buffer|null, reason?: string }: a malformed or
// undelivered handoff resolves with a null dek and a reason, so the child
// fails closed instead of crashing or falling back to plaintext.
// A stream that neither delivers a line nor ends (an interactive terminal)
// resolves with the timeout reason; the caller's boot never blocks on it.
export function readKeyHandoffStream(stream, timeoutMs = 1000) {
  return new Promise(resolve => {
    let text = '';
    let done = false;
    const finish = handoff => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onEnd);
      stream.pause();
      resolve(handoff);
    };
    const absent = reason => finish({ dek: null, reason });
    const consume = () => {
      const newline = text.indexOf('\n');
      if (newline === -1) {
        if (text.length > HANDOFF_LINE_LIMIT) absent('The key handoff line was malformed.');
        return;
      }
      try {
        finish(decodeKeyHandoff(text.slice(0, newline)));
      } catch {
        absent('The key handoff line was malformed.');
      }
    };
    const onData = chunk => {
      text += chunk;
      consume();
    };
    const onEnd = () => {
      // A pipe closed without a complete line: whatever arrived is consumed
      // once, then the child decides from the parsed result.
      if (text.trim().length === 0) return absent('The desktop shell did not deliver a key handoff.');
      text += '\n';
      consume();
    };
    const onError = () => absent('The key handoff channel could not be read.');
    const timer = setTimeout(() => absent('The desktop shell did not deliver a key handoff.'), timeoutMs);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onError);
  });
}

// Strict, payload-blind decoding: failures throw a reason without the line.
export function decodeKeyHandoff(line) {
  const handoff = JSON.parse(line);
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) {
    throw new Error('malformed key handoff');
  }
  if (handoff.dek === null) {
    if (handoff.reason !== undefined && typeof handoff.reason !== 'string') {
      throw new Error('malformed key handoff');
    }
    return { dek: null, ...(typeof handoff.reason === 'string' ? { reason: handoff.reason } : {}) };
  }
  if (typeof handoff.dek !== 'string' || !KEY_HEX.test(handoff.dek)) {
    throw new Error('malformed key handoff');
  }
  if (handoff.reason !== undefined && typeof handoff.reason !== 'string') {
    throw new Error('malformed key handoff');
  }
  return {
    dek: Buffer.from(handoff.dek, 'hex'),
    ...(handoff.reason ? { reason: handoff.reason } : {}),
  };
}

// Main-process key custody: a random DEK wrapped with safeStorage's async
// API at rest, unwrapped only here and delivered once over the channel.
// safeStorage is injected so the decision logic is testable without
// Electron; platform is injected for the same reason.
export async function ensureVaultKey({ safeStorage, dataDir, platform = process.platform, randomBytes = defaultRandomBytes }) {
  if (typeof safeStorage !== 'object' || safeStorage === null) throw new TypeError('ensureVaultKey requires safeStorage');
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('ensureVaultKey requires a dataDir');
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    return { dek: null, reason: 'OS credential protection (safeStorage) is unavailable, so API keys cannot be stored in this installation.' };
  }
  if (platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    // Linux fell back to the documented unencrypted backend; storing key
    // material under it would only look protected. Fail closed instead.
    return { dek: null, reason: 'Linux credential protection fell back to unencrypted basic_text storage, so API keys cannot be stored safely in this installation.' };
  }
  const wrap = async dek => (await safeStorage.encryptStringAsync(dek.toString('hex'))).toString('base64');
  const keyFile = join(dataDir, 'vault-key.json');
  let wrapped;
  if (existsSync(keyFile)) {
    try {
      wrapped = JSON.parse(readFileSync(keyFile, 'utf8')).wrapped;
    } catch {
      wrapped = undefined;
    }
  }
  let dek;
  if (typeof wrapped === 'string') {
    try {
      const unwrapped = await safeStorage.decryptStringAsync(Buffer.from(wrapped, 'base64'));
      if (KEY_HEX.test(unwrapped.result)) {
        dek = Buffer.from(unwrapped.result, 'hex');
        if (unwrapped.shouldReEncrypt) {
          // The OS rotated its key; re-wrap so the next boot decrypts cleanly.
          writeVaultKeyFile(keyFile, await wrap(dek));
        }
      }
    } catch {
      dek = undefined;
    }
  }
  if (Buffer.isBuffer(dek) && dek.length === 32) return { dek };
  dek = randomBytes(32);
  writeVaultKeyFile(keyFile, await wrap(dek));
  return { dek };
}

function writeVaultKeyFile(file, wrappedBase64) {
  mkdirSync(join(file, '..'), { recursive: true });
  const temp = `${file}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(temp, JSON.stringify({ wrapped: wrappedBase64 }));
  renameSync(temp, file);
}

function defaultRandomBytes(size) {
  return randomBytes(size);
}

// Blob layout: base64(iv(12) | ciphertext | gcm-tag(16)).
export function createAesGcmCipher(dekHex) {
  const key = Buffer.from(dekHex, 'hex');
  return {
    available: true,
    async encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      return Buffer.concat([iv, sealed]).toString('base64');
    },
    async decrypt(blob) {
      const sealed = Buffer.from(blob, 'base64');
      if (sealed.length < 12 + 16) throw new Error('malformed vault blob');
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString('utf8');
    },
  };
}

export function absentCipher(reason) {
  return {
    available: false,
    reason,
    async encrypt() {
      throw new Error('credential protection is unavailable');
    },
    async decrypt() {
      throw new Error('credential protection is unavailable');
    },
  };
}
