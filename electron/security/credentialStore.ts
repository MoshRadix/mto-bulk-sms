import Store from 'electron-store';
import keytar from 'keytar';
import { machineIdSync } from 'node-machine-id';
import { decrypt, deriveMachineKey, encrypt, generateKey } from './crypto';

const SERVICE = 'MTOBulkSMSManager';
const KEY_ACCOUNT = 'master-key';
const MACHINE_BOUND_PREFIX = 'v2:';

/**
 * Secrets are AES-256-GCM encrypted in electron-store; random key material lives
 * in the OS keychain and is HMAC-derived with the current machine ID. Only used in Main.
 */
const store = new Store<Record<string, string>>({ name: 'secure-config' });

async function masterKey(): Promise<Buffer> {
  const existing = await keytar.getPassword(SERVICE, KEY_ACCOUNT);
  if (existing) return Buffer.from(existing, 'base64');
  const key = generateKey();
  await keytar.setPassword(SERVICE, KEY_ACCOUNT, key.toString('base64'));
  return key;
}

async function machineBoundKey(): Promise<Buffer> {
  return deriveMachineKey(await masterKey(), machineIdSync());
}

export async function saveSecret(name: string, value: string): Promise<void> {
  store.set(name, `${MACHINE_BOUND_PREFIX}${encrypt(value, await machineBoundKey())}`);
}

export async function loadSecret(name: string): Promise<string | null> {
  const raw = store.get(name);
  if (!raw) return null;

  if (raw.startsWith(MACHINE_BOUND_PREFIX)) {
    return decrypt(raw.slice(MACHINE_BOUND_PREFIX.length), await machineBoundKey());
  }

  // Re-encrypt legacy values on read; the keychain master key remains unchanged for migration.
  const legacyValue = decrypt(raw, await masterKey());
  await saveSecret(name, legacyValue);
  return legacyValue;
}

export const hasSecret = (name: string): boolean => store.has(name);
