// One-shot credential-protection handoff between the Electron main process
// and the backend child. Main wraps a random 32-byte data-encryption key with
// safeStorage (OS-protected at rest) and passes the unwrapped key exactly
// once through a user-private temp file that the child deletes on read.
// The child turns it into an AES-256-GCM vault cipher. There is no plaintext
// fallback: a backend started without the handoff reports credential storage
// unavailable.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const KEY_HEX = /^[0-9a-f]{64}$/;

// Main side: the file lives in the user's own temp directory with 0600
// permissions where the platform supports them, and is consumed at once.
export function writeKeyHandoffFile(file, handoff) {
  writeFileSync(file, JSON.stringify(handoff) + '\n', { encoding: 'utf8', mode: 0o600 });
}

// Child side: read the single line, then delete the carrier file even on
// failure, so the working key never outlives boot.
export function readKeyHandoffFile(file) {
  try {
    const handoff = JSON.parse(readFileSync(file, 'utf8'));
    if (handoff.dek === null) return handoff;
    if (typeof handoff.dek !== 'string' || !KEY_HEX.test(handoff.dek)) {
      throw new Error('malformed key handoff');
    }
    return handoff;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // Nothing may read it later anyway: the key file is deleted or the
      // removal failure is surfaced by the caller's error handling.
    }
  }
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
