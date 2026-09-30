import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, generateKey } from '../electron/security/crypto';
import { redact } from '../electron/security/redact';

describe('AES-256-GCM', () => {
  it('round-trips', () => { const k = generateKey(); expect(decrypt(encrypt('secret', k), k)).toBe('secret'); });
  it('rejects tampering', () => {
    const k = generateKey(); const b = Buffer.from(encrypt('secret', k), 'base64'); b[b.length - 1] ^= 1;
    expect(() => decrypt(b.toString('base64'), k)).toThrow();
  });
});
describe('redact', () => { it('masks passwords', () => expect(redact({ user: 'a', password: 'x' })).toEqual({ user: 'a', password: '[REDACTED]' })); });
