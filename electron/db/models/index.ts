import { Schema, model, Types } from 'mongoose';

const SCHEMA_VERSION = 1;

/** Shared options: timestamps + schema versioning + soft delete. */
const base = { schemaVersion: { type: Number, default: SCHEMA_VERSION }, deletedAt: { type: Date, default: null } };
const opts = { timestamps: true } as const;

const User = model('User', new Schema({
  ...base, name: { type: String, required: true }, username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true }, passwordHash: { type: String, required: true },
  role: { type: String, enum: ['administrator', 'user'], default: 'user' },
  failedLogins: { type: Number, default: 0 }, lockedUntil: Date, active: { type: Boolean, default: true },
}, { ...opts, collection: 'users' }));

const contactSchema = new Schema({
  ...base, name: { type: String, required: true, trim: true },
  mobile: { type: String, required: true, match: /^960[79]\d{6}$/ },
  department: String, designation: String, notes: String, tags: [String],
  groupId: { type: Types.ObjectId, ref: 'Group', required: true, index: true },
  createdBy: { type: Types.ObjectId, ref: 'User', required: true },
}, { ...opts, collection: 'contacts' });
// Prevent duplicate numbers within a group while allowing reuse across groups.
contactSchema.index({ mobile: 1, groupId: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
contactSchema.index({ name: 'text', department: 'text', designation: 'text' });
const Contact = model('Contact', contactSchema);

const Group = model('Group', new Schema({
  ...base, name: { type: String, required: true }, description: String,
  members: [{ type: Types.ObjectId, ref: 'Contact' }], createdBy: { type: Types.ObjectId, ref: 'User' },
}, { ...opts, collection: 'groups' }));

const smsSchema = new Schema({
  ...base, messageId: String, messageKey: String, mobile: { type: String, required: true, index: true },
  contactName: String, body: { type: String, required: true }, groupName: String,
  status: { type: String, enum: ['queued', 'sending', 'submitted', 'processing', 'delivered', 'failed', 'unknown'], default: 'queued', index: true },
  submittedAt: Date, deliveredAt: Date, requestXml: String, responseXml: String, // request must be stored with password masked
  createdBy: { type: Types.ObjectId, ref: 'User', index: true },
}, { ...opts, collection: 'sms_logs' });
smsSchema.index({ createdAt: -1, _id: -1 });
smsSchema.index({ body: 'text' });
const SmsLog = model('SmsLog', smsSchema);

const DhiraaguAuth = model('DhiraaguAuth', new Schema({
  user: { type: String, required: true, trim: true },
  password: { type: String, required: true, trim: true },
}, { ...opts, collection: 'dhiraagu_auth' }));

const AuditLog = model('AuditLog', new Schema({
  schemaVersion: { type: Number, default: SCHEMA_VERSION }, timestamp: { type: Date, default: Date.now, index: true },
  user: String, action: { type: String, index: true }, details: Schema.Types.Mixed, ipAddress: String,
  result: { type: String, enum: ['success', 'failure'] },
}, { collection: 'audit_logs' }));

const Setting = model('Setting', new Schema({ ...base, key: { type: String, unique: true }, value: Schema.Types.Mixed }, { ...opts, collection: 'settings' })); // never store secrets here
const Session = model('Session', new Schema({ userId: Types.ObjectId, tokenId: { type: String, unique: true }, expiresAt: { type: Date, index: { expires: 0 } } }, { ...opts, collection: 'sessions' }));
const Template = model('Template', new Schema({ ...base, title: String, body: String, createdBy: Types.ObjectId }, { ...opts, collection: 'templates' }));
const Report = model('Report', new Schema({ ...base, type: String, params: Schema.Types.Mixed, generatedBy: Types.ObjectId }, { ...opts, collection: 'reports' }));

export const models = { User, Contact, Group, SmsLog, DhiraaguAuth, AuditLog, Setting, Session, Template, Report };
