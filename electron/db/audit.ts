import { models } from './models';
import { redact } from '../security/redact';

/** Persist an audit event only after recursively masking fields with sensitive names. */
export async function audit(action: string, user: string | null, result: 'success' | 'failure', details: unknown = {}, ipAddress = 'local') {
  await models.AuditLog.create({ action, user, result, details: redact(details), ipAddress });
}
