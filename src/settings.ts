import { apiClient } from './app';
import { notifyStatus } from './shared/notifications';

export function bindSettingsTabs() {
  // Settings sections are now stacked vertically as panels instead of tabs.
}

export function attachSettingsHandlers() {
  document.getElementById('setup-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const payload = {
      username: String(formData.get('username') ?? ''),
      password: String(formData.get('password') ?? ''),
      host: String(formData.get('host') ?? ''),
    };
    const status = document.getElementById('setup-status');
    const appApi = apiClient();
    if (!appApi) {
      notifyStatus(status, 'Only the Electron app can save encrypted database settings.', 'error');
      return;
    }
    try {
      await appApi.invoke('setup:save-db', payload);
      notifyStatus(status, 'Database settings saved securely.', 'success');
    } catch (error) {
      notifyStatus(status, error instanceof Error ? error.message : 'Unable to save settings.', 'error');
    }
  });

  document.getElementById('test-db')?.addEventListener('click', async () => {
    const status = document.getElementById('setup-status');
    const appApi = apiClient();
    try {
      if (!appApi) {
        notifyStatus(status, 'Demo mode: the database test is only available in Electron.', 'error');
        return;
      }
      const result = await appApi.invoke('setup:test-db');
      const passed = Boolean(result && typeof result === 'object' && 'ok' in result && result.ok);
      notifyStatus(status, passed ? 'Database connection test passed.' : 'Database connection test failed.', passed ? 'success' : 'error');
    } catch (error) {
      notifyStatus(status, error instanceof Error ? error.message : 'Database test failed.', 'error');
    }
  });

  document.getElementById('init-db')?.addEventListener('click', async () => {
    const status = document.getElementById('setup-status');
    const appApi = apiClient();
    try {
      if (!appApi) {
        notifyStatus(status, 'Demo mode: collection initialization is only available in Electron.', 'error');
        return;
      }
      await appApi.invoke('setup:init-db');
      notifyStatus(status, 'Database collections initialized.', 'success');
    } catch (error) {
      notifyStatus(status, error instanceof Error ? error.message : 'Initialization failed.', 'error');
    }
  });

  document.getElementById('test-dhiraagu-settings')?.addEventListener('click', async () => {
    const status = document.getElementById('sms-provider-status');
    const appApi = apiClient();
    try {
      if (!appApi) {
        notifyStatus(status, 'Dhiraagu connection testing is only available in the Electron app.', 'error');
        return;
      }
      const result = await appApi.invoke('sms:test-connection');
      const message = typeof result === 'object' && result && 'message' in result ? String((result as { message?: string }).message ?? '') : 'Dhiraagu connection test completed.';
      notifyStatus(status, message, /failed|unable|error/i.test(message) ? 'error' : 'success');
    } catch (error) {
      notifyStatus(status, error instanceof Error ? error.message : 'Dhiraagu connection test failed.', 'error');
    }
  });
}
