import { apiClient } from './app';

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
      status!.textContent = 'Only the Electron app can save encrypted database settings.';
      return;
    }
    try {
      await appApi.invoke('setup:save-db', payload);
      status!.textContent = 'Database settings saved securely.';
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Unable to save settings.';
    }
  });

  document.getElementById('test-db')?.addEventListener('click', async () => {
    const status = document.getElementById('setup-status');
    const appApi = apiClient();
    try {
      if (!appApi) {
        status!.textContent = 'Demo mode: the database test is only available in Electron.';
        return;
      }
      const result = await appApi.invoke('setup:test-db');
      status!.textContent = result && typeof result === 'object' && 'ok' in result && result.ok ? 'Database connection test passed.' : 'Database connection test failed.';
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Database test failed.';
    }
  });

  document.getElementById('init-db')?.addEventListener('click', async () => {
    const status = document.getElementById('setup-status');
    const appApi = apiClient();
    try {
      if (!appApi) {
        status!.textContent = 'Demo mode: collection initialization is only available in Electron.';
        return;
      }
      await appApi.invoke('setup:init-db');
      status!.textContent = 'Database collections initialized.';
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Initialization failed.';
    }
  });

  document.getElementById('test-dhiraagu-settings')?.addEventListener('click', async () => {
    const status = document.getElementById('sms-provider-status');
    const appApi = apiClient();
    try {
      if (!appApi) {
        status!.textContent = 'Dhiraagu connection testing is only available in the Electron app.';
        return;
      }
      const result = await appApi.invoke('sms:test-connection');
      const message = typeof result === 'object' && result && 'message' in result ? String((result as { message?: string }).message ?? '') : 'Dhiraagu connection test completed.';
      status!.textContent = message;
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Dhiraagu connection test failed.';
    }
  });
}
