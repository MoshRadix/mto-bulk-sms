import mongoose from 'mongoose';
import { loadSecret } from '../security/credentialStore';

/** Builds the URI at runtime from encrypted storage; never hardcoded, never sent to the renderer. */
export async function connectDatabase(): Promise<void> {
  const user = await loadSecret('db.username');
  const pass = await loadSecret('db.password');
  const host = (await loadSecret('db.host')) ?? 'bulksms.3ryba3t.mongodb.net';
  if (!user || !pass) throw new Error('Database credentials not configured');
  const uri = `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}/?appName=BulkSMS`;
  await mongoose.connect(uri, { dbName: 'mto_bulk_sms', serverSelectionTimeoutMS: 8000 });
}

export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  try { await connectDatabase(); return { ok: true }; }
  catch (e) { return { ok: false, error: (e as Error).message.replace(/:[^@/]+@/, ':***@') }; }
}

export async function initializeCollections(): Promise<void> {
  const { models } = await import('./models');
  for (const m of Object.values(models)) { await m.createCollection().catch(() => undefined); await m.syncIndexes(); }
}
