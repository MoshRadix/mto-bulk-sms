export type Role = 'administrator' | 'user';
export type SmsStatus = 'queued' | 'sending' | 'submitted' | 'processing' | 'delivered' | 'failed' | 'unknown';
export type AuditResult = 'success' | 'failure';
export const SCHEMA_VERSION = 1;
