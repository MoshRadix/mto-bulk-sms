import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

/** Encrypts UTF-8 text. Output: base64(iv | authTag | ciphertext). Key must be 32 bytes. */
export function encrypt(plain: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('Key must be 32 bytes');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(payload: string, key: Buffer): string {
  // Keep this layout in sync with encrypt(): 12-byte IV, 16-byte GCM tag, then ciphertext.
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const data = buf.subarray(IV_LEN + 16);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Derive an AES key that only matches when both the keychain secret and machine ID match. */
export function deriveMachineKey(key: Buffer, machineId: string): Buffer {
  if (key.length !== 32) throw new Error('Key must be 32 bytes');
  if (!machineId) throw new Error('Machine ID is required');
  return createHmac('sha256', key)
    .update('mto-bulk-sms-machine-bound-v2\0')
    .update(machineId)
    .digest();
}

export const generateKey = (): Buffer => randomBytes(32);
