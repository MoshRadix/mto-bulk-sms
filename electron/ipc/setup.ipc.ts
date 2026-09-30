import { ipcMain } from 'electron';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { loadSecret, saveSecret } from '../security/credentialStore';
import { connectDatabase, initializeCollections, testConnection } from '../db/connection';

const DbCreds = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  host: z.string().trim().optional().transform((value) => (value && value.trim() ? value.trim() : undefined)),
});
const SmsConfig = z.object({
  username: z.string().trim().min(1).optional(),
  user: z.string().trim().min(1).optional(),
  password: z.string().min(1).optional(),
  sender: z.string().trim().min(1).optional(),
});
const LoginInput = z.object({ username: z.string().trim().min(1), password: z.string().min(1) });
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
}).refine((value) => Boolean(value.name || value.description), {
  message: 'At least one field is required to update a group.',
});
const SmsInput = z.object({
  to: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  message: z.string().trim().min(1),
  groupId: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  userId: z.string().trim().optional(),
  role: z.enum(['administrator', 'user']).optional(),
}).refine((value) => Boolean(value.groupId || value.to), {
  message: 'Either a direct recipient or a group selection is required.',
});
const SmsListInput = z.object({
  userId: z.string().trim().optional(),
  role: z.enum(['administrator', 'user']).optional(),
}).optional();
const UserInput = z.object({
  name: z.string().trim().min(1),
  username: z.string().trim().min(1),
  email: z.string().trim().email(),
  password: z.string().trim().min(6).optional(),
  role: z.enum(['administrator', 'user']).default('user'),
});
const UserUpdateInput = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  username: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  password: z.string().trim().min(6).optional(),
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
  return /^960[79]\d{6}$/.test(normalizeMvNumber(input));
}

export function getGroupMemberCount(groupMembers: unknown[] = [], actualMemberIds: unknown[] = []): number {
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildDhiraaguXmlVariants({ username, password, sender, to, text }: { username: string; password: string; sender: string; to: string; text: string }): string[] {
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
  await connectDatabase();
  const { models } = await import('../db/models');
  const exists = await models.User.findOne({ username: 'admin' }).lean();
  if (!exists) {
    await models.User.create({
      name: 'System Administrator',
      username: 'admin',
      email: 'admin@mto.gov.mv',
      passwordHash: await bcrypt.hash('admin123', 10),
      role: 'administrator',
      active: true,
    });
  }
}

async function getDhiraaguAuthRecord() {
  await ensureDbReady();
  const { models } = await import('../db/models');
  return models.DhiraaguAuth.findOne({}).lean() as Promise<{ user?: string; password?: string } | null>;
}

export async function getSetupStatus(): Promise<{ configured: boolean; ready: boolean; message: string }> {
  const username = await loadSecret('db.username');
  const password = await loadSecret('db.password');
  const configured = Boolean(username && password);

  if (!configured) {
    return { configured: false, ready: false, message: 'Database credentials are not configured yet.' };
  }

  try {
    await connectDatabase();
    const { models } = await import('../db/models');
    const adminExists = Boolean(await models.User.findOne({ username: 'admin' }).lean());
    return {
      configured: true,
      ready: adminExists,
      message: adminExists ? 'Database and admin user are ready.' : 'Admin user needs to be created.',
    };
  } catch (error) {
    return {
      configured: true,
      ready: false,
      message: error instanceof Error ? error.message : 'Unable to connect to the configured database.',
    };
  }
}

export function registerSetupIpc() {
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
    const c = DbCreds.parse(raw);
    await saveSecret('db.username', c.username);
    await saveSecret('db.password', c.password);
    if (c.host) await saveSecret('db.host', c.host);
    await initializeCollections();
    await ensureDbReady();
    return { ok: true };
  });

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

  ipcMain.handle('auth:login', async (_e, raw) => {
    const { username, password } = LoginInput.parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const user = await models.User.findOne({ username: username.toLowerCase() });
    if (!user || !user.active) throw new Error('Invalid username or password');
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) throw new Error('Invalid username or password');
    return {
      id: String(user._id),
      name: user.name,
      username: user.username,
      role: user.role,
    };
  });

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

    const adminUser = await models.User.findOne({ username: 'admin' });
    const doc = await models.Contact.create({
      name: c.name,
      mobile,
      department: c.department,
      designation: c.designation,
      notes: c.notes,
      groupId: group._id,
      createdBy: adminUser?._id,
    });

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

    const doc = await models.Contact.findByIdAndUpdate(c.id, {
      $set: {
        name: c.name ?? existing.name,
        mobile,
        department: c.department ?? existing.department ?? '',
        designation: c.designation ?? existing.designation ?? '',
        notes: c.notes ?? existing.notes ?? '',
        groupId: group._id,
      },
    }, { new: true }).lean();

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

    for (const row of rows) {
      const mobile = normalizeMvNumber(row.mobile);
      if (!isValidMvMobile(mobile)) {
        throw new Error(`Invalid mobile number for ${row.name || 'unknown contact'}: ${row.mobile}`);
      }

      const group = row.groupId
        ? await models.Group.findById(row.groupId).lean()
        : await models.Group.findOne({ name: String(row.groupName ?? '').trim(), deletedAt: null }).lean();

      if (!group) {
        throw new Error(`Group not found for contact ${row.name}; provide a valid group name or groupId.`);
      }

      const doc = await models.Contact.findOneAndUpdate(
        { mobile, deletedAt: null },
        {
          $set: {
            name: row.name,
            mobile,
            department: row.department ?? '',
            designation: row.designation ?? '',
            notes: row.notes ?? '',
            groupId: group._id,
            createdBy: adminUser?._id ?? undefined,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      await models.Group.findByIdAndUpdate(group._id, { $addToSet: { members: doc._id } });
      results.push({ id: String(doc._id), name: doc.name, mobile: doc.mobile, groupId: String(doc.groupId) });
    }

    return { count: results.length, rows: results };
  });

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

  ipcMain.handle('groups:create', async (_e, raw) => {
    const c = GroupInput.parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const adminUser = await models.User.findOne({ username: 'admin' });
    const doc = await models.Group.create({
      name: c.name,
      description: c.description,
      members: c.members,
      createdBy: adminUser?._id,
    });
    return { id: String(doc._id), name: doc.name, description: doc.description ?? '', memberCount: doc.members.length };
  });

  ipcMain.handle('groups:update', async (_e, raw) => {
    const c = GroupUpdateInput.parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const existing = await models.Group.findById(c.id).lean();
    if (!existing) throw new Error('Group not found.');

    const doc = await models.Group.findByIdAndUpdate(c.id, {
      $set: {
        name: c.name ?? existing.name,
        description: c.description ?? existing.description ?? '',
      },
    }, { new: true }).lean();
    if (!doc) throw new Error('Group not found.');
    return { id: String(doc._id), name: doc.name, description: doc.description ?? '', memberCount: Array.isArray(doc.members) ? doc.members.length : 0 };
  });

  ipcMain.handle('groups:delete', async (_e, raw) => {
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

  ipcMain.handle('groups:bulk-delete', async (_e, raw) => {
    const { ids } = z.object({ ids: z.array(z.string().trim().min(1)) }).parse(raw ?? { ids: [] });
    await ensureDbReady();
    const { models } = await import('../db/models');
    const groups = await models.Group.find({ _id: { $in: ids }, deletedAt: null }).lean();
    const memberIds = groups.flatMap((group) => Array.isArray(group.members) ? group.members.map((member) => String(member)) : []);
    await models.Contact.updateMany({ _id: { $in: memberIds } }, { $set: { deletedAt: new Date() } });
    await models.Group.updateMany({ _id: { $in: groups.map((group) => group._id) } }, { $set: { deletedAt: new Date() } });
    return { count: groups.length };
  });

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

  ipcMain.handle('sms:list', async (_e, raw) => {
    const input = SmsListInput.parse(raw ?? {});
    await ensureDbReady();
    const { models } = await import('../db/models');
    const filter: Record<string, unknown> = { deletedAt: null };
    if (input?.role !== 'administrator' && input?.userId) {
      filter.createdBy = input.userId;
    }
    const items = await models.SmsLog.find(filter).sort({ createdAt: -1 }).lean();
    return items.map((item) => ({
      id: String(item._id),
      to: item.mobile,
      message: item.body,
      status: item.status,
      contactName: item.contactName ?? '',
      createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : null,
    }));
  });

  ipcMain.handle('sms:queue', async (_e, raw) => {
    const c = SmsInput.parse(raw);
    await ensureDbReady();
    const { models } = await import('../db/models');
    const currentUserId = c.role === 'administrator' ? undefined : c.userId;

    const contacts = c.groupId
      ? await models.Contact.find({ groupId: c.groupId, deletedAt: null }).lean()
      : c.to
        ? await models.Contact.find({ mobile: normalizeMvNumber(c.to), deletedAt: null }).lean()
        : [];

    if (!contacts.length) {
      throw new Error(c.groupId ? 'No contacts were found in the selected group.' : 'No contact matches the provided mobile number.');
    }

    const created = await Promise.all(
      contacts.map(async (contact) => {
        const doc = await models.SmsLog.create({
          mobile: contact.mobile,
          body: c.message,
          contactName: contact.name,
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

  ipcMain.handle('sms:send', async (_e, raw) => {
    const input = SmsListInput.parse(raw ?? {});
    await ensureDbReady();
    const auth = await getDhiraaguAuthRecord();
    const user = auth?.user?.trim();
    const password = auth?.password?.trim();
    const sender = 'MTO';
    if (!user || !password) throw new Error('Dhiraagu SMS credentials are not configured in the dhiraagu_auth collection.');

    const { models } = await import('../db/models');
    const queueFilter: Record<string, unknown> = { status: 'queued', deletedAt: null };
    if (input?.role !== 'administrator' && input?.userId) {
      queueFilter.createdBy = input.userId;
    }
    const queued = await models.SmsLog.find(queueFilter).sort({ createdAt: 1 }).lean();
    let sentCount = 0;

    for (const item of queued) {
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
          { _id: item._id },
          { $set: { status: 'submitted', messageId: parsed.messageId, messageKey: parsed.messageKey, requestXml, responseXml, submittedAt: new Date() } },
        );
        sentCount += 1;
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown SMS error');
        responseXml = (error as Error).message || 'Unknown SMS error';
      }
    }

    if (lastError) {
      await models.SmsLog.updateOne(
        { _id: item._id },
        { $set: { status: 'failed', requestXml, responseXml: lastError.message || 'Unknown SMS error' } },
      );
    }
  }

    return sentCount;
  });
}
