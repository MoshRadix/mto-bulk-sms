import Store from 'electron-store';
import keytar from 'keytar';
import { decrypt, encrypt, generateKey } from './crypto';

const SERVICE = 'MTOBulkSMSManager';
const KEY_ACCOUNT = 'master-key';

/**
 * Secrets are AES-256-GCM encrypted in electron-store; the master key lives
 * in the OS keychain via keytar. Only ever used from the Main process.
 */
const store = new Store<Record<string, string>>({ name: 'secure-config' });

async function masterKey(): Promise<Buffer> {
  const existing = await keytar.getPassword(SERVICE, KEY_ACCOUNT);
  if (existing) return Buffer.from(existing, 'base64');
  const key = generateKey();
  await keytar.setPassword(SERVICE, KEY_ACCOUNT, key.toString('base64'));
  return key;
}

export async function saveSecret(name: string, value: string): Promise<void> {
  store.set(name, encrypt(value, await masterKey()));
}

export async function loadSecret(name: string): Promise<string | null> {
  const raw = store.get(name);
  return raw ? decrypt(raw, await masterKey()) : null;
}

export const hasSecret = (name: string): boolean => store.has(name);
