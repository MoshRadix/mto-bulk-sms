import { describe, it, expect } from 'vitest';
import { decrypt, deriveMachineKey, encrypt, generateKey } from '../electron/security/crypto';
import { redact } from '../electron/security/redact';

// Cover both confidentiality/integrity behavior and secret masking before audit output.
describe('AES-256-GCM', () => {
  it('round-trips', () => { const k = generateKey(); expect(decrypt(encrypt('secret', k), k)).toBe('secret'); });
  it('rejects tampering', () => {
    const k = generateKey(); const b = Buffer.from(encrypt('secret', k), 'base64'); b[b.length - 1] ^= 1;
    // Flipping a ciphertext byte must fail GCM authentication during decryption.
    expect(() => decrypt(b.toString('base64'), k)).toThrow();
  });
});
describe('machine-bound keys', () => {
  it('derives a stable key for one machine and a different key for another', () => {
    const masterKey = generateKey();
    expect(deriveMachineKey(masterKey, 'machine-a')).toEqual(deriveMachineKey(masterKey, 'machine-a'));
    expect(deriveMachineKey(masterKey, 'machine-a')).not.toEqual(deriveMachineKey(masterKey, 'machine-b'));
  });

  it('rejects ciphertext when decrypted with another machine identity', () => {
    const masterKey = generateKey();
    const ciphertext = encrypt('database password', deriveMachineKey(masterKey, 'machine-a'));
    expect(() => decrypt(ciphertext, deriveMachineKey(masterKey, 'machine-b'))).toThrow();
  });
});
describe('redact', () => { it('masks passwords', () => expect(redact({ user: 'a', password: 'x' })).toEqual({ user: 'a', password: '[REDACTED]' })); });
