import { ipcMain } from 'electron';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { loadSecret, saveSecret } from '../security/credentialStore';
import { connectDatabase, initializeCollections, testConnection } from '../db/connection';

/** Main-process boundary for validated database, authentication, contact/group, user, and SMS operations. */
const DbCreds = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  host: z.string().trim().optional().transform((value) => (value && value.trim() ? value.trim() : undefined)),
});
const SetupBootstrapInput = z.object({
  name: z.string().trim().min(1),
  username: z.string().trim().min(1).toLowerCase(),
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(8),
});
const SmsConfig = z.object({
  username: z.string().trim().min(1).optional(),
  user: z.string().trim().min(1).optional(),
  password: z.string().min(1).optional(),
  sender: z.string().trim().min(1).optional(),
});
const LoginInput = z.object({ username: z.string().trim().min(1), password: z.string().min(1) });
const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
type AuthenticatedUser = { id: string; role: 'administrator' | 'user' };
const authenticatedUsers = new Map<number, AuthenticatedUser>();

function getAuthenticatedUser(senderId: number): AuthenticatedUser {
  // Sessions are tied to the renderer's WebContents ID and removed when that renderer is destroyed.
  const user = authenticatedUsers.get(senderId);
  if (!user) throw new Error('Sign in before managing groups.');
  return user;
}

function requireAdministrator(senderId: number): AuthenticatedUser {
  // UI visibility is not authorization; privileged IPC handlers must enforce the role here.
  const user = getAuthenticatedUser(senderId);
  if (user.role !== 'administrator') throw new Error('Administrator access is required for this action.');
  return user;
}

const ContactInput = z.object({
  name: z.string().trim().min(1),
  mobile: z.string().trim().min(1),
  department: z.string().trim().optional().default(''),
  designation: z.string().trim().optional().default(''),
  notes: z.string().trim().optional().default(''),
  groupId: z.string().trim().min(1),
});
const ContactUpdateInput = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  mobile: z.string().trim().min(1).optional(),
  department: z.string().trim().optional().default(''),
  designation: z.string().trim().optional().default(''),
  notes: z.string().trim().optional().default(''),
  groupId: z.string().trim().min(1).optional(),
}).refine((value) => Boolean(value.name || value.mobile || value.department || value.designation || value.notes || value.groupId), {
  message: 'At least one field is required to update a contact.',
});
const ContactImportRow = z.object({
  name: z.string().trim().min(1),
  mobile: z.string().trim().min(1),
  department: z.string().trim().optional().default(''),
  designation: z.string().trim().optional().default(''),
  notes: z.string().trim().optional().default(''),
  groupName: z.string().trim().optional().default(''),
  groupId: z.string().trim().optional().default(''),
});
const GroupInput = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional().default(''),
  members: z.array(z.string().min(1)).optional().default([]),
});
const GroupUpdateInput = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().optional().default(''),
  members: z.array(z.string().trim().min(1)).optional(),
}).refine((value) => Boolean(value.name || value.description || value.members), {
  message: 'At least one field is required to update a group.',
});
const SmsInput = z.object({
  to: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  message: z.string().min(1).refine((value) => value.trim().length > 0, { message: 'Message text is required.' }),
  groupId: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
}).refine((value) => Boolean(value.groupId || value.to), {
  message: 'Either a direct recipient or a group selection is required.',
});
const SmsListInput = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  ownOnly: z.boolean().default(false),
  sentOnly: z.boolean().default(false),
  cursor: z.object({
    createdAt: z.string().datetime(),
    id: z.string().regex(/^[a-f\d]{24}$/i),
  }).optional(),
});
const UserInput = z.object({
  name: z.string().trim().min(1),
  username: z.string().trim().min(1),
  email: z.string().trim().email(),
  password: z.string().trim().min(8).optional(),
  role: z.enum(['administrator', 'user']).default('user'),
});
const UserUpdateInput = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  username: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  password: z.string().trim().min(8).optional(),
  role: z.enum(['administrator', 'user']).optional(),
}).refine((value) => Boolean(value.name || value.username || value.email || value.password || value.role), {
  message: 'At least one field is required to update a user.',
});

function normalizeMvNumber(input: string): string {
  const n = input.replace(/[\s\-()+]/g, '').replace(/^00/, '');
  if (/^[79]\d{6}$/.test(n)) return `960${n}`;
  return n;
}

function isValidMvMobile(input: string): boolean {
  return /^960(?:7[1-9]|9[1-9])\d{5}$/.test(normalizeMvNumber(input));
}

function parseDirectSmsRecipients(input: string): string[] {
  const cleanInput = input.trim();
  if (!cleanInput) return [];

  const entries = cleanInput.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => !entry)) throw new Error('Remove empty entries from the recipient list.');

  // Normalize before deduplication so local and international spellings queue only one SMS per number.
  const numbers = entries.map(normalizeMvNumber);
  const invalidNumbers = [...new Set(numbers.filter((number) => !isValidMvMobile(number)))];
  if (invalidNumbers.length) {
    throw new Error(`Invalid Maldives mobile number${invalidNumbers.length === 1 ? '' : 's'}: ${invalidNumbers.join(', ')}`);
  }
  return [...new Set(numbers)];
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

export function getGroupMemberCount(groupMembers: unknown[] = [], actualMemberIds: unknown[] = []): number {
  // Contact assignments are authoritative when the legacy Group.members array is stale.
  if (actualMemberIds.length > 0) return actualMemberIds.length;
  return Array.isArray(groupMembers) ? groupMembers.length : 0;
}

async function syncGroupMemberships(models: any, groupId: string | undefined, contactId: string) {
  if (!groupId || !contactId) return;
  await models.Group.findByIdAndUpdate(groupId, { $addToSet: { members: contactId } });
}

async function removeContactFromGroup(models: any, groupId: string | undefined, contactId: string) {
  if (!groupId || !contactId) return;
  await models.Group.findByIdAndUpdate(groupId, { $pull: { members: contactId } });
}

async function saveGroupMembers(models: any, groupId: string, memberIds: string[], createdBy?: unknown): Promise<number> {
  // Membership is represented by group-scoped contact records; removal soft-deletes only those records.
  const selectedIds = new Set(memberIds);
  const [currentMembers, selectedContacts] = await Promise.all([
    models.Contact.find({ groupId, deletedAt: null }).lean(),
    models.Contact.find({ _id: { $in: memberIds }, deletedAt: null }).lean(),
  ]);
  const removedMembers = currentMembers.filter((contact: any) => !selectedIds.has(String(contact._id)));
  const keptMembers = currentMembers.filter((contact: any) => selectedIds.has(String(contact._id)));

  if (removedMembers.length) {
    const removedIds = removedMembers.map((contact: any) => contact._id);
    await models.Contact.updateMany({ _id: { $in: removedIds } }, { $set: { deletedAt: new Date() } });
    await models.Group.updateOne({ _id: groupId }, { $pull: { members: { $in: removedIds } } });
  }

  const memberNumbers = new Set(keptMembers.map((contact: any) => contact.mobile));
  const savedMemberIds = keptMembers.map((contact: any) => contact._id);
  for (const contact of selectedContacts) {
    if (String(contact.groupId) === groupId || memberNumbers.has(contact.mobile)) continue;

    try {
      const copy = await models.Contact.create({
        name: contact.name,
        mobile: contact.mobile,
        department: contact.department ?? '',
        designation: contact.designation ?? '',
        notes: contact.notes ?? '',
        groupId,
        createdBy: createdBy ?? contact.createdBy,
      });
      memberNumbers.add(copy.mobile);
      savedMemberIds.push(copy._id);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  await models.Group.updateOne({ _id: groupId }, { $set: { members: savedMemberIds } });
  return savedMemberIds.length;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildDhiraaguXmlVariants({ username, password, sender, to, text }: { username: string; password: string; sender: string; to: string; text: string }): string[] {
  // Try the documented telemessage shape first, followed by provider-compatible legacy payload shapes.
  const safeUser = escapeXml(username);
  const safePassword = escapeXml(password);
  const safeSender = escapeXml(sender);
  const safeTo = escapeXml(to);
  const safeText = escapeXml(text);

  const exactFormat = `<?xml version="1.0" encoding="UTF-8" ?>
<TELEMESSAGE>
    <TELEMESSAGE_CONTENT>
        <MESSAGE>
            <MESSAGE_INFORMATION>
                <SUBJECT>${safeSender}</SUBJECT>
            </MESSAGE_INFORMATION>
            <USER_FROM>
                <CIML>
                    <NAML>
                        <LOGIN_DETAILS>
                            <USER_NAME>${safeUser}</USER_NAME>
                            <PASSWORD>${safePassword}</PASSWORD>
                        </LOGIN_DETAILS>
                    </NAML>
                </CIML>
            </USER_FROM>
            <MESSAGE_CONTENT>
                <TEXT_MESSAGE>
                    <MESSAGE_INDEX>0</MESSAGE_INDEX>
                    <TEXT>${safeText}</TEXT>
                </TEXT_MESSAGE>
            </MESSAGE_CONTENT>
            <USER_TO>
                <CIML>
                    <DEVICE_INFORMATION>
                        <DEVICE_TYPE DEVICE_TYPE="SMS"/>
                        <DEVICE_VALUE>${safeTo}</DEVICE_VALUE>
                    </DEVICE_INFORMATION>
                </CIML>
            </USER_TO>
        </MESSAGE>
    </TELEMESSAGE_CONTENT>
    <VERSION>1.6</VERSION>
</TELEMESSAGE>`;

  return [
    exactFormat,
    `<?xml version="1.0" encoding="UTF-8"?>
<MESSAGE>
  <USER>${safeUser}</USER>
  <PASSWORD>${safePassword}</PASSWORD>
  <SMS UDH="0" CODING="1" TEXT="${safeText}">
    <ADDRESS FROM="${safeSender}" TO="${safeTo}"/>
  </SMS>
</MESSAGE>`,
    `<?xml version="1.0" encoding="UTF-8"?>
<MESSAGE>
  <USER>${safeUser}</USER>
  <PASSWORD>${safePassword}</PASSWORD>
  <SMS>
    <ADDRESS FROM="${safeSender}" TO="${safeTo}"/>
    <TEXT>${safeText}</TEXT>
  </SMS>
</MESSAGE>`,
  ];
}

export function parseDhiraaguStatus(xml: string): { messageId: string; messageKey: string } {
  // Accept the provider's documented casing/separator variants but require both IDs for tracking.
  const regex = /<(?:message[_-]?id|MESSAGE[_-]?ID|MESSAGEID|id)>(.*?)<\/(?:message[_-]?id|MESSAGE[_-]?ID|MESSAGEID|id)>/is;
  const keyRegex = /<(?:message[_-]?key|MESSAGE[_-]?KEY|MESSAGEKEY|key)>(.*?)<\/(?:message[_-]?key|MESSAGE[_-]?KEY|MESSAGEKEY|key)>/is;

  const messageId = xml.match(regex)?.[1]?.trim();
  const messageKey = xml.match(keyRegex)?.[1]?.trim();
  if (!messageId || !messageKey) {
    const preview = xml.replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Dhiraagu API returned an unexpected response: ${preview}`);
  }
  return { messageId, messageKey };
}

async function ensureDbReady() {
  // This helper only connects; administrator creation belongs to the guarded setup bootstrap below.
  await connectDatabase();
}

async function usesLegacyDefaultAdminPassword(admin: { username?: string; passwordHash?: string } | null): Promise<boolean> {
  // Existing installs are forced to replace the historical public default during setup.
  return Boolean(
    admin?.username === 'admin'
    && admin.passwordHash
    && await bcrypt.compare('admin123', admin.passwordHash),
  );
}

async function getDhiraaguAuthRecord() {
  await ensureDbReady();
  const { models } = await import('../db/models');
  return models.DhiraaguAuth.findOne({}).lean() as Promise<{ user?: string; password?: string } | null>;
}

export async function getSetupStatus(): Promise<{ configured: boolean; databaseConnected: boolean; ready: boolean; message: string }> {
  const username = await loadSecret('db.username');
  const password = await loadSecret('db.password');
  const configured = Boolean(username && password);

  if (!configured) {
    return { configured: false, databaseConnected: false, ready: false, message: 'Database credentials are not configured yet.' };
  }

  try {
    await connectDatabase();
    const { models } = await import('../db/models');
    const admin = await models.User.findOne({ role: 'administrator', active: true, deletedAt: null })
      .select('username passwordHash')
      .lean();
    const requiresCredentialReset = await usesLegacyDefaultAdminPassword(admin);
    const adminExists = Boolean(admin) && !requiresCredentialReset;
    return {
      configured: true,
      databaseConnected: true,
      ready: adminExists,
      message: requiresCredentialReset
        ? 'The default administrator password must be replaced before continuing.'
        : adminExists
          ? 'Database and administrator account are ready.'
          : 'Create the first administrator account to continue.',
    };
  } catch (error) {
    return {
      configured: true,
      databaseConnected: false,
      ready: false,
      message: error instanceof Error ? error.message : 'Unable to connect to the configured database.',
    };
  }
}

export function registerSetupIpc() {
  // Setup routes are callable before login; auth:login establishes the sender context used by protected handlers.
  ipcMain.handle('setup:status', async () => getSetupStatus());

  ipcMain.handle('setup:save-db', async (_e, raw) => {
    const c = DbCreds.parse(raw);
    await saveSecret('db.username', c.username);
    await saveSecret('db.password', c.password);
    if (c.host) await saveSecret('db.host', c.host);
    return { ok: true };
  });
  ipcMain.handle('setup:test-db', () => testConnection());
  ipcMain.handle('setup:init-db', async () => { await initializeCollections(); return { ok: true }; });
  ipcMain.handle('setup:bootstrap', async (_e, raw) => {
    const administrator = SetupBootstrapInput.parse(raw);
    await initializeCollections();
    await connectDatabase();
    const { models } = await import('../db/models');
    const existingAdmin = await models.User.findOne({ role: 'administrator', active: true, deletedAt: null });
    if (existingAdmin && !(await usesLegacyDefaultAdminPassword(existingAdmin))) {
      throw new Error('An administrator account already exists. Sign in instead of running first-time setup again.');
    }
    const secureAdmin = {
      name: administrator.name,
      username: administrator.username,
      email: administrator.email,
      passwordHash: await bcrypt.hash(administrator.password, 12),
      role: 'administrator',
      active: true,
    };
    if (existingAdmin) {
      await models.User.updateOne({ _id: existingAdmin._id }, { $set: secureAdmin });
    } else {
      // Bootstrap creates an administrator only from explicit credentials, never a public default password.
      await models.User.create(secureAdmin);
    }
    return { ok: true };
  });

  // The provider password is write-only from the renderer; settings reads return only the username.
  ipcMain.handle('settings:get-sms-provider', async () => {
    const auth = await getDhiraaguAuthRecord();
    return {
      username: auth?.user ?? '',
      password: '',
      sender: 'MTO',
    };
  });

  ipcMain.handle('settings:save-sms-provider', async (_e, raw) => {
    const cfg = SmsConfig.parse((raw ?? {}) as Record<string, unknown>);
    const user = (cfg.user ?? cfg.username ?? '').trim();
    const password = cfg.password?.trim();
    if (!user || !password) return { ok: true };

    const { models } = await import('../db/models');
    await ensureDbReady();
    await models.DhiraaguAuth.findOneAndUpdate(
      {},
      { $set: { user, password } },
      { upsert: true, new: true },
    );
    return { ok: true };
  });

  ipcMain.handle('auth:login', async (event, raw) => {
    const { username, password } = LoginInput.parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const user = await models.User.findOne({ username: username.toLowerCase() });
    if (!user || !user.active) throw new Error('Invalid username or password');
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) throw new Error('Invalid username or password');
    const authenticatedUser: AuthenticatedUser = {
      id: String(user._id),
      role: user.role === 'administrator' ? 'administrator' : 'user',
    };
    const senderId = event.sender.id;
    // Store only the minimum authorization context needed by later IPC requests.
    authenticatedUsers.set(senderId, authenticatedUser);
    event.sender.once('destroyed', () => authenticatedUsers.delete(senderId));
    return {
      id: authenticatedUser.id,
      name: user.name,
      username: user.username,
      role: authenticatedUser.role,
    };
  });

  ipcMain.handle('auth:change-password', async (event, raw) => {
    const { currentPassword, newPassword } = ChangePasswordInput.parse(raw);
    const sessionUser = getAuthenticatedUser(event.sender.id);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const user = await models.User.findOne({ _id: sessionUser.id, active: true, deletedAt: null });
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new Error('Current password is incorrect.');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new Error('Choose a new password that differs from your current password.');
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    await user.save();
    return { ok: true };
  });

  // Contact CRUD and CSV import keep validation and persistence in the main process.
  ipcMain.handle('contacts:list', async () => {
    await ensureDbReady();
    const { models } = await import('../db/models');
    const items = await models.Contact.find({ deletedAt: null }).sort({ name: 1 }).lean();
    const groups = await models.Group.find({ deletedAt: null }).select('_id name').lean();
    const groupMap = new Map(groups.map((group) => [String(group._id), group.name]));
    return items.map((item) => ({
      id: String(item._id),
      name: item.name,
      mobile: item.mobile,
      department: item.department ?? '',
      designation: item.designation ?? '',
      notes: item.notes ?? '',
      groupId: item.groupId ? String(item.groupId) : '',
      groupName: item.groupId ? groupMap.get(String(item.groupId)) ?? 'Unknown group' : 'No group',
    }));
  });

  ipcMain.handle('contacts:create', async (_e, raw) => {
    const c = ContactInput.parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const mobile = normalizeMvNumber(c.mobile);
    if (!isValidMvMobile(mobile)) throw new Error('Invalid Maldives mobile number');

    const group = await models.Group.findById(c.groupId).lean();
    if (!group) throw new Error('Selected group was not found.');
    if (await models.Contact.exists({ mobile, groupId: group._id, deletedAt: null })) {
      throw new Error('This mobile number already exists in the selected group.');
    }

    const adminUser = await models.User.findOne({ username: 'admin' });
    let doc;
    try {
      doc = await models.Contact.create({
        name: c.name,
        mobile,
        department: c.department,
        designation: c.designation,
        notes: c.notes,
        groupId: group._id,
        createdBy: adminUser?._id,
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new Error('This mobile number already exists in the selected group.');
      throw error;
    }

    await syncGroupMemberships(models, String(group._id), String(doc._id));

    return { id: String(doc._id), name: doc.name, mobile: doc.mobile, department: doc.department ?? '', groupId: String(doc.groupId) };
  });

  ipcMain.handle('contacts:update', async (_e, raw) => {
    const c = ContactUpdateInput.parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const existing = await models.Contact.findById(c.id).lean();
    if (!existing) throw new Error('Contact not found.');

    const mobile = c.mobile ? normalizeMvNumber(c.mobile) : existing.mobile;
    if (!isValidMvMobile(mobile)) throw new Error('Invalid Maldives mobile number');

    const groupId = c.groupId ? c.groupId : existing.groupId ? String(existing.groupId) : '';
    const group = groupId ? await models.Group.findById(groupId).lean() : null;
    if (!group) throw new Error('Selected group was not found.');
    if (await models.Contact.exists({ _id: { $ne: existing._id }, mobile, groupId: group._id, deletedAt: null })) {
      throw new Error('This mobile number already exists in the selected group.');
    }

    let doc;
    try {
      doc = await models.Contact.findByIdAndUpdate(c.id, {
        $set: {
          name: c.name ?? existing.name,
          mobile,
          department: c.department ?? existing.department ?? '',
          designation: c.designation ?? existing.designation ?? '',
          notes: c.notes ?? existing.notes ?? '',
          groupId: group._id,
        },
      }, { new: true }).lean();
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new Error('This mobile number already exists in the selected group.');
      throw error;
    }

    if (!doc) throw new Error('Contact not found.');

    const previousGroupId = existing.groupId ? String(existing.groupId) : undefined;
    if (previousGroupId && previousGroupId !== String(group._id)) {
      await removeContactFromGroup(models, previousGroupId, String(doc._id));
    }
    await syncGroupMemberships(models, String(group._id), String(doc._id));

    return { id: String(doc._id), name: doc.name, mobile: doc.mobile, department: doc.department ?? '', groupId: String(doc.groupId) };
  });

  ipcMain.handle('contacts:delete', async (_e, raw) => {
    const { id } = z.object({ id: z.string().trim().min(1) }).parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const doc = await models.Contact.findById(id);
    if (!doc) throw new Error('Contact not found.');
    doc.deletedAt = new Date();
    await doc.save();
    await removeContactFromGroup(models, doc.groupId ? String(doc.groupId) : undefined, String(doc._id));
    return { ok: true };
  });

  ipcMain.handle('contacts:bulk-delete', async (_e, raw) => {
    const { ids } = z.object({ ids: z.array(z.string().trim().min(1)) }).parse(raw ?? { ids: [] });
    await ensureDbReady();
    const { models } = await import('../db/models');
    const docs = await models.Contact.find({ _id: { $in: ids }, deletedAt: null }).lean();
    await models.Contact.updateMany({ _id: { $in: docs.map((doc) => doc._id) } }, { $set: { deletedAt: new Date() } });
    await models.Group.updateMany({ members: { $in: docs.map((doc) => doc._id) } }, { $pull: { members: { $in: docs.map((doc) => doc._id) } } });
    return { count: docs.length };
  });

  ipcMain.handle('contacts:import', async (_e, raw) => {
    const rows = z.array(ContactImportRow).parse(raw ?? []);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const adminUser = await models.User.findOne({ username: 'admin' });
    const results: Array<{ id: string; name: string; mobile: string; groupId: string }> = [];
    const skippedNumbers: string[] = [];
    const normalizedRows = rows.map((row) => {
      const mobile = normalizeMvNumber(row.mobile);
      if (!isValidMvMobile(mobile)) {
        throw new Error(`Invalid mobile number for ${row.name || 'unknown contact'}: ${row.mobile}`);
      }
      return { row, mobile };
    });
    const existing = await models.Contact.find({
      mobile: { $in: normalizedRows.map(({ mobile }) => mobile) },
      deletedAt: null,
    }).select('mobile groupId').lean();
    const seenGroupNumbers = new Set(existing.map((contact) => `${String(contact.groupId)}:${contact.mobile}`));

    for (const { row, mobile } of normalizedRows) {
      const group = row.groupId
        ? await models.Group.findById(row.groupId).lean()
        : await models.Group.findOne({ name: String(row.groupName ?? '').trim(), deletedAt: null }).lean();

      if (!group) {
        throw new Error(`Group not found for contact ${row.name}; provide a valid group name or groupId.`);
      }

      const groupNumberKey = `${String(group._id)}:${mobile}`;
      if (seenGroupNumbers.has(groupNumberKey)) {
        skippedNumbers.push(mobile);
        continue;
      }
      seenGroupNumbers.add(groupNumberKey);

      let doc;
      try {
        doc = await models.Contact.create({
          name: row.name,
          mobile,
          department: row.department ?? '',
          designation: row.designation ?? '',
          notes: row.notes ?? '',
          groupId: group._id,
          createdBy: adminUser?._id,
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          skippedNumbers.push(mobile);
          continue;
        }
        throw error;
      }

      await models.Group.findByIdAndUpdate(group._id, { $addToSet: { members: doc._id } });
      results.push({ id: String(doc._id), name: doc.name, mobile: doc.mobile, groupId: String(doc.groupId) });
    }

    return { count: results.length, skippedDuplicates: skippedNumbers.length, skippedNumbers, rows: results };
  });

  // Group lists derive member counts from live contact assignments to tolerate stale legacy arrays.
  ipcMain.handle('groups:list', async () => {
    await ensureDbReady();
    const { models } = await import('../db/models');
    const items = await models.Group.find({ deletedAt: null }).sort({ name: 1 }).lean();
    const contactAssignments = await models.Contact.find({ deletedAt: null }).select('_id groupId').lean();
    const memberIdsByGroup = new Map<string, string[]>();

    for (const contact of contactAssignments) {
      if (!contact.groupId) continue;
      const groupId = String(contact.groupId);
      const ids = memberIdsByGroup.get(groupId) ?? [];
      ids.push(String(contact._id));
      memberIdsByGroup.set(groupId, ids);
    }

    return items.map((item) => ({
      id: String(item._id),
      name: item.name,
      description: item.description ?? '',
      memberCount: getGroupMemberCount(Array.isArray(item.members) ? item.members : [], memberIdsByGroup.get(String(item._id)) ?? []),
    }));
  });

  ipcMain.handle('groups:create', async (event, raw) => {
    // Group structure changes are administrator-only; member edits are separately checked in groups:update.
    requireAdministrator(event.sender.id);
    const c = GroupInput.parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const adminUser = await models.User.findOne({ username: 'admin' });
    const doc = await models.Group.create({
      name: c.name,
      description: c.description,
      members: [],
      createdBy: adminUser?._id,
    });
    const memberCount = await saveGroupMembers(models, String(doc._id), c.members, adminUser?._id);
    return { id: String(doc._id), name: doc.name, description: doc.description ?? '', memberCount };
  });

  ipcMain.handle('groups:update', async (event, raw) => {
    const user = getAuthenticatedUser(event.sender.id);
    const updatesDetails = typeof raw === 'object' && raw !== null && ('name' in raw || 'description' in raw);
    if (updatesDetails && user.role !== 'administrator') {
      throw new Error('Administrator access is required to change group details.');
    }
    const c = GroupUpdateInput.parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const existing = await models.Group.findById(c.id).lean();
    if (!existing) throw new Error('Group not found.');

    const doc = updatesDetails
      ? await models.Group.findByIdAndUpdate(c.id, {
          $set: {
            name: c.name ?? existing.name,
            description: c.description ?? existing.description ?? '',
          },
        }, { new: true }).lean()
      : existing;
    if (!doc) throw new Error('Group not found.');
    const memberCount = c.members
      ? await saveGroupMembers(models, String(doc._id), c.members)
      : await models.Contact.countDocuments({ groupId: doc._id, deletedAt: null });
    return { id: String(doc._id), name: doc.name, description: doc.description ?? '', memberCount };
  });

  ipcMain.handle('groups:delete', async (event, raw) => {
    requireAdministrator(event.sender.id);
    const { id } = z.object({ id: z.string().trim().min(1) }).parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const group = await models.Group.findById(id);
    if (!group) throw new Error('Group not found.');
    const memberIds = group.members ?? [];
    await models.Contact.updateMany({ _id: { $in: memberIds } }, { $set: { deletedAt: new Date() } });
    group.deletedAt = new Date();
    await group.save();
    return { ok: true };
  });

  // User records never include password hashes in renderer responses.
  ipcMain.handle('users:list', async () => {
    await ensureDbReady();
    const { models } = await import('../db/models');
    const users = await models.User.find({ deletedAt: null }).sort({ name: 1 }).lean();
    return users.map((user) => ({
      id: String(user._id),
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
    }));
  });

  ipcMain.handle('users:create', async (_e, raw) => {
    const c = UserInput.parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const duplicate = await models.User.findOne({
      deletedAt: null,
      $or: [{ username: c.username.toLowerCase() }, { email: c.email.toLowerCase() }],
    }).lean();
    if (duplicate) throw new Error('A user with that username or email already exists.');
    const doc = await models.User.create({
      name: c.name,
      username: c.username.toLowerCase(),
      email: c.email.toLowerCase(),
      passwordHash: await bcrypt.hash(c.password ?? 'changeMe123', 10),
      role: c.role,
      active: true,
    });
    return { id: String(doc._id), username: doc.username, name: doc.name, email: doc.email, role: doc.role, active: doc.active };
  });

  ipcMain.handle('users:update', async (_e, raw) => {
    const c = UserUpdateInput.parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const existing = await models.User.findById(c.id).lean();
    if (!existing) throw new Error('User not found.');

    const duplicate = await models.User.findOne({
      deletedAt: null,
      _id: { $ne: existing._id },
      $or: [
        ...(c.username ? [{ username: c.username.toLowerCase() }] : []),
        ...(c.email ? [{ email: c.email.toLowerCase() }] : []),
      ],
    }).lean();
    if (duplicate) throw new Error('Another user already uses that username or email.');

    const updates: Record<string, unknown> = {};
    if (c.name) updates.name = c.name;
    if (c.username) updates.username = c.username.toLowerCase();
    if (c.email) updates.email = c.email.toLowerCase();
    if (c.role) updates.role = c.role;
    if (c.password) updates.passwordHash = await bcrypt.hash(c.password, 10);

    const doc = await models.User.findByIdAndUpdate(c.id, { $set: updates }, { new: true }).lean();
    if (!doc) throw new Error('User not found.');
    return { id: String(doc._id), username: doc.username, name: doc.name, email: doc.email, role: doc.role, active: doc.active };
  });

  ipcMain.handle('users:delete', async (_e, raw) => {
    const { id } = z.object({ id: z.string().trim().min(1) }).parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const user = await models.User.findById(id);
    if (!user) throw new Error('User not found.');
    user.deletedAt = new Date();
    user.active = false;
    await user.save();
    return { ok: true };
  });

  // SMS list cursors use createdAt plus _id to provide stable pagination across timestamp ties.
  ipcMain.handle('sms:list', async (event, raw) => {
    const input = SmsListInput.parse(raw ?? {});
    const authenticatedUser = getAuthenticatedUser(event.sender.id);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const filter: Record<string, unknown> = { deletedAt: null };
    // Non-admins are always scoped to their own logs; ownOnly can further restrict an administrator query.
    if (authenticatedUser.role !== 'administrator' || input.ownOnly) filter.createdBy = authenticatedUser.id;
    if (input.sentOnly) filter.status = { $in: ['submitted', 'processing', 'delivered'] };
    if (input.cursor) {
      const cursorDate = new Date(input.cursor.createdAt);
      filter.$or = [
        { createdAt: { $lt: cursorDate } },
        { createdAt: cursorDate, _id: { $lt: input.cursor.id } },
      ];
    }
    const documents = await models.SmsLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(input.limit + 1)
      .lean();
    const hasMore = documents.length > input.limit;
    const items = documents.slice(0, input.limit);
    const lastItem = items.at(-1);
    const queuedCount = input.cursor
      ? undefined
      : await models.SmsLog.countDocuments({ ...filter, status: 'queued' });
    const sentCount = input.cursor
      ? undefined
      : await models.SmsLog.countDocuments({
          deletedAt: null,
          createdBy: authenticatedUser.id,
          status: { $in: ['submitted', 'processing', 'delivered'] },
        });
    return {
      items: items.map((item) => ({
        id: String(item._id),
        to: item.mobile,
        message: item.body,
        status: item.status,
        contactName: item.contactName ?? '',
        groupName: item.groupName ?? null,
        createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : null,
      })),
      hasMore,
      nextCursor: hasMore && lastItem?.createdAt
        ? { createdAt: new Date(lastItem.createdAt).toISOString(), id: String(lastItem._id) }
        : null,
      ...(queuedCount === undefined ? {} : { queuedCount }),
      ...(sentCount === undefined ? {} : { sentCount }),
    };
  });

  ipcMain.handle('sms:queue', async (event, raw) => {
    const authenticatedUser = getAuthenticatedUser(event.sender.id);
    const c = SmsInput.parse(raw);
    if (Array.from(c.message).length > 1530) {
      throw new Error('SMS message cannot exceed 1,530 characters.');
    }
    await ensureDbReady();
    const { models } = await import('../db/models');
    const currentUserId = authenticatedUser.id;
    const group = c.groupId
      ? await models.Group.findOne({ _id: c.groupId, deletedAt: null }).lean()
      : null;
    if (c.groupId && !group) throw new Error('Selected group was not found.');

    // Snapshot the selected group membership at queue time so later edits do not change queued recipients.
    const recipients = c.groupId
      ? (await models.Contact.find({ groupId: group!._id, deletedAt: null }).lean())
          .map((contact) => ({ mobile: contact.mobile, name: contact.name ?? '' }))
      : await (async () => {
          const numbers = parseDirectSmsRecipients(c.to ?? '');
          const savedContacts = await models.Contact.find({ mobile: { $in: numbers }, deletedAt: null }).select('mobile name').lean();
          const namesByNumber = new Map(savedContacts.map((contact) => [contact.mobile, contact.name ?? '']));
          return numbers.map((mobile) => ({ mobile, name: namesByNumber.get(mobile) ?? '' }));
        })();

    if (!recipients.length) throw new Error('No contacts were found in the selected group.');

    const created = await Promise.all(
      recipients.map(async (recipient) => {
        const doc = await models.SmsLog.create({
          mobile: recipient.mobile,
          body: c.message,
          contactName: recipient.name,
          groupName: group?.name,
          status: 'queued',
          createdBy: currentUserId ?? undefined,
        });
        return { id: String(doc._id), to: doc.mobile, message: doc.body, status: doc.status };
      }),
    );

    return created;
  });

  ipcMain.handle('sms:test-connection', async () => {
    await ensureDbReady();
    const auth = await getDhiraaguAuthRecord();
    const user = auth?.user?.trim();
    const password = auth?.password?.trim();
    const sender = 'MTO';
    if (!user || !password) {
      return { ok: false, message: 'Dhiraagu SMS credentials are not configured in the dhiraagu_auth collection.' };
    }

    try {
      const payloads = buildDhiraaguXmlVariants({ username: user, password, sender, to: '9607712345', text: 'MTO connection test' });
      let lastError: string | null = null;

      for (const payload of payloads) {
        try {
          const response = await fetch('https://bulksms.dhiraagu.com.mv/partners/xmlMessage.jsp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/xml; charset=utf-8', Accept: 'application/xml' },
            body: payload,
          });
          const responseXml = await response.text();
          if (!response.ok) {
            lastError = `HTTP ${response.status}: ${responseXml.slice(0, 200)}`;
            continue;
          }
          parseDhiraaguStatus(responseXml);
          return { ok: true, message: 'Dhiraagu connection test passed: the XML payload was accepted by the provider.' };
        } catch (error) {
          lastError = error instanceof Error ? error.message : 'Unexpected provider response';
        }
      }

      return { ok: false, message: lastError ?? 'Dhiraagu connection test failed.' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Dhiraagu connection test failed.' };
    }
  });

  // Only queued records are claimed here; submitted/terminal statuses are never selected for sending.
  ipcMain.handle('sms:send', async (event) => {
    const authenticatedUser = getAuthenticatedUser(event.sender.id);
    await ensureDbReady();
    const auth = await getDhiraaguAuthRecord();
    const user = auth?.user?.trim();
    const password = auth?.password?.trim();
    const sender = 'MTO';
    if (!user || !password) throw new Error('Dhiraagu SMS credentials are not configured in the dhiraagu_auth collection.');

    const { models } = await import('../db/models');
    const queueFilter: Record<string, unknown> = { status: 'queued', deletedAt: null };
    if (authenticatedUser.role !== 'administrator') queueFilter.createdBy = authenticatedUser.id;
    const queued = await models.SmsLog.find(queueFilter).sort({ createdAt: 1 }).select('_id').lean();
    let sentCount = 0;
    const sentMessages: Array<{ id: string; to: string; message: string; status: string; groupName: string | null; createdAt: string | null }> = [];

    for (const queuedItem of queued) {
    // Atomically claim a queued log so overlapping send requests cannot submit it twice.
    const item = await models.SmsLog.findOneAndUpdate(
      { _id: queuedItem._id, ...queueFilter },
      { $set: { status: 'sending' } },
      { new: true },
    ).lean();
    if (!item) continue;

    let requestXml = '';
    let responseXml = '';
    let lastError: Error | null = null;

    for (const payload of buildDhiraaguXmlVariants({ username: user, password, sender, to: item.mobile, text: item.body })) {
      requestXml = payload;
      try {
        const response = await fetch('https://bulksms.dhiraagu.com.mv/partners/xmlMessage.jsp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/xml; charset=utf-8', Accept: 'application/xml' },
          body: payload,
        });
        responseXml = await response.text();
        if (!response.ok) {
          throw new Error(`Dhiraagu API returned HTTP ${response.status}: ${responseXml.slice(0, 200)}`);
        }

        const parsed = parseDhiraaguStatus(responseXml);
        await models.SmsLog.updateOne(
          { _id: item._id, status: 'sending' },
          { $set: { status: 'submitted', messageId: parsed.messageId, messageKey: parsed.messageKey, requestXml, responseXml, submittedAt: new Date() } },
        );
        sentCount += 1;
        sentMessages.push({
          id: String(item._id),
          to: item.mobile,
          message: item.body,
          status: 'submitted',
          groupName: item.groupName ?? null,
          createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : null,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown SMS error');
        responseXml = (error as Error).message || 'Unknown SMS error';
      }
    }

    if (lastError) {
      await models.SmsLog.updateOne(
        { _id: item._id, status: 'sending' },
        { $set: { status: 'failed', requestXml, responseXml: lastError.message || 'Unknown SMS error' } },
      );
    }
  }

    return { sentCount, sentMessages };
  });
}
