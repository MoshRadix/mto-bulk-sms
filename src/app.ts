import { isValidMvMobile } from './shared/phone';

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
  createdAt?: string | null;
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
  users: UserRecord[];
  status: string;
  user: { id: string; username: string; name: string; role: string } | null;
  reportFilters: { year?: number; month?: number };
  view: 'setup' | 'login' | 'dashboard';
};

export const state: DashboardState = {
  contacts: [],
  groups: [],
  sms: [],
  users: [],
  status: 'Loading dashboard...',
  user: null,
  reportFilters: {},
  view: 'setup',
};

export const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

declare global {
  interface Window {
    api?: {
      invoke: (channel: string, payload?: unknown) => Promise<unknown>;
    };
  }
}

export function apiClient() {
  return window.api ?? null;
}

export function getValidContactCount() {
  return state.contacts.filter((contact) => isValidMvMobile(contact.mobile)).length;
}
