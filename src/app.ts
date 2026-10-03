import { isValidMvMobile, normalizeMvNumber } from './shared/phone';

/** Renderer-side records and transient UI state; database calls are delegated through the preload API. */
export type Contact = {
  id: string;
  name: string;
  mobile: string;
  department: string;
  groupId?: string;
  groupName?: string;
};

export type Group = {
  id: string;
  name: string;
  description: string;
  memberCount: number;
};

export type SmsItem = {
  id: string;
  to: string;
  message: string;
  status: string;
  groupName?: string | null;
  createdAt?: string | null;
};

export type SmsCursor = { createdAt: string; id: string };

export type SmsPage = {
  items: SmsItem[];
  hasMore: boolean;
  nextCursor: SmsCursor | null;
  queuedCount?: number;
  sentCount?: number;
};

export type UserRecord = {
  id: string;
  username: string;
  name: string;
  email: string;
  role: 'administrator' | 'user';
  active: boolean;
};

export type DashboardState = {
  contacts: Contact[];
  groups: Group[];
  sms: SmsItem[];
  smsCursor: SmsCursor | null;
  smsHasMore: boolean;
  smsLoading: boolean;
  queuedSmsCount: number;
  sentSmsCount: number;
  smsReport: SmsItem[];
  smsReportLoaded: boolean;
  smsReportLoading: boolean;
  smsReportError: string | null;
  smsHistoryItems: SmsItem[];
  smsHistoryPage: number;
  smsHistoryHasMore: boolean;
  smsHistoryNextCursor: SmsCursor | null;
  smsHistoryLoading: boolean;
  smsHistoryLoaded: boolean;
  smsHistoryError: string | null;
  smsHistoryStatus: string;
  activeSection: 'dashboard' | 'contacts' | 'groups' | 'admin' | 'settings' | 'history' | 'templates';
  groupEditorId: string;
  groupEditorMode: 'existing' | 'new';
  users: UserRecord[];
  status: string;
  user: { id: string; username: string; name: string; role: string } | null;
  reportFilters: { year?: number; month?: number };
  view: 'setup' | 'login' | 'dashboard';
};

/** Single renderer state store. Re-rendering replaces the view, not this session state. */
export const state: DashboardState = {
  contacts: [],
  groups: [],
  sms: [],
  smsCursor: null,
  smsHasMore: false,
  smsLoading: false,
  queuedSmsCount: 0,
  sentSmsCount: 0,
  smsReport: [],
  smsReportLoaded: false,
  smsReportLoading: false,
  smsReportError: null,
  smsHistoryItems: [],
  smsHistoryPage: 0,
  smsHistoryHasMore: false,
  smsHistoryNextCursor: null,
  smsHistoryLoading: false,
  smsHistoryLoaded: false,
  smsHistoryError: null,
  smsHistoryStatus: '',
  activeSection: 'dashboard',
  groupEditorId: '',
  groupEditorMode: 'existing',
  users: [],
  status: 'Loading dashboard...',
  user: null,
  reportFilters: {},
  view: 'setup',
};

const appRoot = document.getElementById('root');
if (!appRoot) throw new Error('Root element not found');
export const root: HTMLElement = appRoot;

declare global {
  interface Window {
    api?: {
      invoke: (channel: string, payload?: unknown) => Promise<unknown>;
    };
  }
}

export function apiClient() {
  // A missing bridge means this is the browser preview, not an authenticated Electron session.
  return window.api ?? null;
}

export function getValidContactCount() {
  // Count normalized numbers, not contact rows, because one person can belong to multiple groups.
  return new Set(state.contacts
    .map((contact) => normalizeMvNumber(contact.mobile))
    .filter(isValidMvMobile)).size;
}
