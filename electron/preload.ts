import { contextBridge, ipcRenderer } from 'electron';

/**
 * IMPORTANT: a sandboxed preload can only require('electron') and a few built-ins.
 * It cannot require local files, so this whitelist must live inline here.
 * tests/channels.test.ts keeps it in sync with electron/ipc/channels.ts.
 */
const CHANNELS: readonly string[] = [
  'setup:status', 'setup:test-db', 'setup:save-db', 'setup:init-db', 'setup:bootstrap',
  'settings:get-sms-provider', 'settings:save-sms-provider',
  'auth:login', 'contacts:list', 'contacts:create', 'contacts:update', 'contacts:delete', 'contacts:bulk-delete', 'contacts:import', 'groups:list', 'groups:create', 'groups:update', 'groups:delete', 'groups:bulk-delete',
  'users:list', 'users:create', 'users:update', 'users:delete',
  'sms:list', 'sms:queue', 'sms:send', 'sms:test-connection',
];

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, payload?: unknown) => {
    if (!CHANNELS.includes(channel)) return Promise.reject(new Error('Blocked IPC channel'));
    return ipcRenderer.invoke(channel, payload);
  },
});
