import { apiClient, root, state } from './app';
import { loadDashboardData } from './dashboard';
import { notifyStatus, showAppNotification } from './shared/notifications';
import { renderIcons } from './shared/icons';

/** Owns the pre-dashboard lifecycle: database setup, first-admin bootstrap, and sign-in. */
const REMEMBERED_LOGIN_KEY = 'mto-bulk-sms.remembered-login';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

function getRememberedLogin() {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(REMEMBERED_LOGIN_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { username?: string };
    if (typeof parsed.username !== 'string' || !parsed.username.trim()) {
      window.localStorage.removeItem(REMEMBERED_LOGIN_KEY);
      return null;
    }
    // Migrate older entries by retaining only the username, never the plaintext password.
    window.localStorage.setItem(REMEMBERED_LOGIN_KEY, JSON.stringify({ username: parsed.username }));
    return { username: parsed.username.trim() };
  } catch {
    try {
      window.localStorage.removeItem(REMEMBERED_LOGIN_KEY);
    } catch {
      return null;
    }
    return null;
  }
}

function saveRememberedLogin(username: string) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(REMEMBERED_LOGIN_KEY, JSON.stringify({ username }));
  } catch {
    // ignore permission/storage errors
  }
}

function clearRememberedLogin() {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(REMEMBERED_LOGIN_KEY);
  } catch {
    // ignore permission/storage errors
  }
}

export function renderSetup(message = 'Configure MongoDB to continue.', administratorSetupOnly = false) {
  state.view = 'setup';
  // Existing databases with an administrator skip account creation; incomplete setup resumes at the required stage.
  let setupPhase: 'database' | 'administrator' = administratorSetupOnly ? 'administrator' : 'database';
  root.innerHTML = `
    <style>
      :root { --panel: rgba(15, 23, 42, 0.9); --border: rgba(255,255,255,0.09); --text: #e5e7eb; --muted: #9ca3af; --accent: #38bdf8; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", sans-serif; background: linear-gradient(135deg, #091320, #0f172a 48%, #102435); color: var(--text); }
      .login-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .login-card { width: min(500px, 100%); background: var(--panel); border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 18px 50px rgba(2, 8, 23, 0.5); padding: 28px; }
      .brand { display: grid; justify-items: center; gap: 8px; font-size: 1rem; font-weight: 700; text-align: center; }
      .brand-mark { display: block; width: min(100%, 110px); height: 94px; padding: 2px; border-radius: 8px; background: transparent; object-fit: contain; }
      .ui-icon { display: block; width: 18px; height: 18px; flex: 0 0 18px; stroke-width: 1.9; }
      .screen-title { margin: 20px 0 8px; font-size: 1.45rem; line-height: 1.25; }
      .sub { color: var(--muted); margin-bottom: 22px; }
      label { display: block; font-size: 0.8rem; color: var(--muted); margin-bottom: 6px; }
      input, button { width: 100%; border-radius: 10px; border: 1px solid var(--border); background: rgba(15,23,42,0.72); color: var(--text); padding: 12px; font: inherit; }
      button { display: inline-flex; align-items: center; justify-content: center; gap: 9px; margin-top: 12px; cursor: pointer; background: linear-gradient(135deg, #22d3ee, #2563eb); border: none; color: #061522; font-weight: 700; }
      button:hover { filter: brightness(1.08); }
      input:focus-visible, button:focus-visible { outline: 2px solid #22d3ee; outline-offset: 2px; }
      button:disabled { cursor: not-allowed; opacity: 0.55; }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
      .small { color: var(--muted); margin-top: 12px; font-size: 0.8rem; }
      .warning { color: #fbbf24; }
      .developer-credit { margin: 20px 0 0; color: #8dded2; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-align: center; text-transform: uppercase; }
      fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
    </style>
    <div class="login-shell">
      <div class="login-card">
        <div class="brand"><img class="brand-mark" src="../assets/addu%20city%20logo.png" alt="City of Addu logo, the finest" /><span>MTO Bulk SMS Manager</span></div>
        <h1 class="screen-title">First-time setup</h1>
        <div class="sub" id="setup-description">${administratorSetupOnly ? 'Create the administrator account for this database.' : 'Connect your database to check whether an administrator account is already set up.'}</div>
        <form id="setup-bootstrap-form">
          <fieldset id="setup-database-fields" ${administratorSetupOnly ? 'disabled hidden' : ''}>
            <div>
              <label for="setup-db-username">Database username</label>
              <input id="setup-db-username" name="dbUsername" autocomplete="off" placeholder="MongoDB username" required />
            </div>
            <div style="margin-top: 14px;">
              <label for="setup-db-password">Database password</label>
              <input id="setup-db-password" name="dbPassword" type="password" autocomplete="new-password" placeholder="Database password" required />
            </div>
            <div style="margin-top: 14px;">
              <label for="setup-db-host">Database host</label>
              <input id="setup-db-host" name="dbHost" autocomplete="url" placeholder="cluster.mongodb.net" />
            </div>
          </fieldset>
          <fieldset id="setup-admin-fields" ${administratorSetupOnly ? '' : 'disabled hidden'} style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border);">
            <strong style="font-size: 0.9rem;">Administrator account</strong>
            <div style="margin-top: 14px;">
              <label for="setup-admin-name">Full name</label>
              <input id="setup-admin-name" name="adminName" autocomplete="name" placeholder="Administrator name" required />
            </div>
            <div style="margin-top: 14px;">
              <label for="setup-admin-username">Username</label>
              <input id="setup-admin-username" name="adminUsername" autocomplete="username" placeholder="Choose a username" required />
            </div>
            <div style="margin-top: 14px;">
              <label for="setup-admin-email">Email</label>
              <input id="setup-admin-email" name="adminEmail" type="email" autocomplete="email" placeholder="name@example.com" required />
            </div>
            <div style="margin-top: 14px;">
              <label for="setup-admin-password">Administrator password</label>
              <input id="setup-admin-password" name="adminPassword" type="password" autocomplete="new-password" minlength="12" placeholder="At least 12 characters" required />
            </div>
            </fieldset>
                  <button type="submit"><i data-lucide="database"></i><span id="setup-submit-label">${administratorSetupOnly ? 'Create administrator' : 'Connect database'}</span></button>
        </form>
        <div id="setup-message" class="small warning">${message}</div>
        <p class="developer-credit">Developed by M0SH</p>
      </div>
    </div>
  `;

  renderIcons(root);

  document.getElementById('setup-bootstrap-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const database = {
      username: String(formData.get('dbUsername') ?? '').trim(),
      password: String(formData.get('dbPassword') ?? ''),
      host: String(formData.get('dbHost') ?? '').trim() || undefined,
    };
    const administrator = {
      name: String(formData.get('adminName') ?? '').trim(),
      username: String(formData.get('adminUsername') ?? '').trim(),
      email: String(formData.get('adminEmail') ?? '').trim(),
      password: String(formData.get('adminPassword') ?? ''),
    };
    const message = document.getElementById('setup-message');
    const appApi = apiClient();

    try {
      if (!appApi) {
        throw new Error('This app requires the Electron runtime. Run npm run start to launch the live app.');
      }
      notifyStatus(message, 'Connecting to the database and creating your administrator account...');
      if (setupPhase === 'database') {
        notifyStatus(message, 'Connecting to the database...');
        await appApi.invoke('setup:save-db', database);
        const status = await appApi.invoke('setup:status') as { ready: boolean; databaseConnected: boolean; message?: string };
        if (status.ready) {
          state.view = 'login';
          renderLogin();
          showAppNotification('Connected to the existing database.', 'success');
          return;
        }
        if (!status.databaseConnected) throw new Error(status.message ?? 'Could not connect to the database.');

        // Reveal admin fields only after the main process confirms the database is reachable and needs an admin.
        setupPhase = 'administrator';
        const databaseFields = document.getElementById('setup-database-fields') as HTMLFieldSetElement | null;
        const administratorFields = document.getElementById('setup-admin-fields') as HTMLFieldSetElement | null;
        if (databaseFields) {
          databaseFields.disabled = true;
          databaseFields.hidden = true;
        }
        if (administratorFields) {
          administratorFields.disabled = false;
          administratorFields.hidden = false;
        }
        const description = document.getElementById('setup-description');
        if (description) description.textContent = status.message ?? 'Create the administrator account for this database.';
        const submitLabel = document.getElementById('setup-submit-label');
        if (submitLabel) submitLabel.textContent = 'Create administrator';
        const nameInput = document.getElementById('setup-admin-name') as HTMLInputElement | null;
        nameInput?.focus();
        notifyStatus(message, status.message ?? 'Database connected. Create the first administrator account.', 'info');
        return;
      }

      notifyStatus(message, 'Creating your administrator account...');
      await appApi.invoke('setup:bootstrap', administrator);
      notifyStatus(message, 'Setup complete. Redirecting to login...', 'success');
      state.view = 'login';
      state.status = 'Database ready. Sign in with your administrator account.';
      setTimeout(() => renderLogin(), 300);
    } catch (error) {
      notifyStatus(message, error instanceof Error ? error.message : 'Unable to save database settings.', 'error');
    }
  });

  const setupMessage = document.getElementById('setup-message');
  setupMessage?.addEventListener('click', async () => {
    const appApi = apiClient();
    if (!appApi) return;
    try {
      const status = await appApi.invoke('setup:status') as { ready: boolean; message?: string };
      if (status.ready) {
        state.view = 'login';
        renderLogin();
      }
    } catch {
      // no-op: setup form remains visible if the database is not ready
    }
  });
}

export function renderLogin() {
  // Passwords are never prefilled or persisted; the optional preference remembers only the username.
  state.view = 'login';
  const rememberedLogin = getRememberedLogin();

  root.innerHTML = `
    <style>
      :root { --panel: rgba(15, 23, 42, 0.9); --border: rgba(255,255,255,0.09); --text: #e5e7eb; --muted: #9ca3af; --accent: #38bdf8; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", sans-serif; background: linear-gradient(135deg, #091320, #0f172a 48%, #102435); color: var(--text); }
      .login-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .login-card { width: min(430px, 100%); background: var(--panel); border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 18px 50px rgba(2, 8, 23, 0.5); padding: 28px; }
      .brand { display: grid; justify-items: center; gap: 8px; font-size: 1rem; font-weight: 700; text-align: center; }
      .brand-mark { display: block; width: min(100%, 110px); height: 94px; padding: 2px; border-radius: 8px; background: transparent; object-fit: contain; }
      .ui-icon { display: block; width: 18px; height: 18px; flex: 0 0 18px; stroke-width: 1.9; }
      .sub { color: var(--muted); margin-bottom: 22px; }
      label { display: block; font-size: 0.8rem; color: var(--muted); margin-bottom: 6px; }
      input, button { width: 100%; border-radius: 10px; border: 1px solid var(--border); background: rgba(15,23,42,0.72); color: var(--text); padding: 12px; font: inherit; }
      button { display: inline-flex; align-items: center; justify-content: center; gap: 9px; margin-top: 12px; cursor: pointer; background: linear-gradient(135deg, #22d3ee, #2563eb); border: none; color: #061522; font-weight: 700; }
      button:hover { filter: brightness(1.08); }
      input:focus-visible, button:focus-visible { outline: 2px solid #22d3ee; outline-offset: 2px; }
      button:disabled { cursor: not-allowed; opacity: 0.55; }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
      .small { color: var(--muted); margin-top: 12px; font-size: 0.8rem; }
      .developer-credit { margin: 20px 0 0; color: #8dded2; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-align: center; text-transform: uppercase; }
      .remember-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
      .remember-row label { margin: 0; color: var(--muted); font-size: 0.8rem; display: flex; align-items: center; gap: 8px; }
      .remember-row input[type='checkbox'] { width: auto; margin: 0; }
      .secondary { background: rgba(148,163,184,0.14); color: var(--text); border: 1px solid var(--border); }
      .link-action { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; width: auto; margin: 0; padding: 4px 2px; border: 0; border-radius: 0; background: none; color: #fca5a5; font-size: 0.8rem; font-weight: 600; text-align: right; text-decoration: none; white-space: nowrap; }
      .link-action:hover { background: none; color: #fecaca; text-decoration: underline; text-underline-offset: 3px; }
      .link-action:focus-visible { outline: 2px solid #fca5a5; outline-offset: 3px; }
    </style>
    <div class="login-shell">
      <div class="login-card">
        <div class="brand"><img class="brand-mark" src="../assets/addu%20city%20logo.png" alt="City of Addu logo, the finest" /><span>MTO Bulk SMS Manager</span></div>
        <div class="sub">Sign in to access contacts, groups, and the SMS workflow.</div>
        <form id="login-form">
          <div>
            <label for="login-username">Username</label>
            <input id="login-username" name="username" autocomplete="username" value="${escapeHtml(rememberedLogin?.username ?? '')}" placeholder="Enter your username" required />
          </div>
          <div style="margin-top: 14px;">
            <label for="login-password">Password</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required />
          </div>
          <div class="remember-row">
            <label>
              <input name="remember-login" type="checkbox" ${rememberedLogin ? 'checked' : ''} />
              Remember username
            </label>
            ${rememberedLogin ? '<button id="forget-login-button" type="button" class="link-action"><i data-lucide="x"></i>Forget saved login</button>' : ''}
          </div>
          <button type="submit"><i data-lucide="log-in"></i>Log in</button>
        </form>
        <div id="login-message" class="small">Use the username and password assigned to your account.</div>
        <p class="developer-credit">Developed by M0SH</p>
      </div>
    </div>
  `;

  renderIcons(root);

  const loginForm = document.getElementById('login-form');
  loginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const username = String(formData.get('username') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const rememberLogin = formData.get('remember-login') === 'on';
    const message = document.getElementById('login-message');
    const appApi = apiClient();

    try {
      if (!appApi) {
        throw new Error('This app requires the Electron runtime. Run npm run start to launch the live app.');
      }
      const result = await appApi.invoke('auth:login', { username, password });
      if (result && typeof result === 'object' && 'username' in result) {
        if (rememberLogin) {
          saveRememberedLogin(username);
        } else {
          clearRememberedLogin();
        }
        state.user = result as { id: string; username: string; name: string; role: string };
        state.status = `Signed in as ${state.user.username}`;
        showAppNotification('Signed in successfully.', 'success');
        await loadDashboardData();
        return;
      }
      throw new Error('Login failed.');
    } catch (error) {
      notifyStatus(message, error instanceof Error ? error.message : 'Unable to log in.', 'error');
    }
  });

  const forgetLoginButton = document.getElementById('forget-login-button');
  forgetLoginButton?.addEventListener('click', () => {
    clearRememberedLogin();
    renderLogin();
  });
}

export async function initializeApp() {
  // setup:status decides whether to show login, database connection, or administrator creation.
  const appApi = apiClient();
  state.view = 'setup';

  if (!appApi) {
    renderSetup('This app requires the Electron runtime. Run npm run start to launch the live app.');
    return;
  }

  try {
    const status = await appApi.invoke('setup:status') as { ready: boolean; message?: string; configured: boolean; databaseConnected: boolean };
    if (status.ready) {
      state.view = 'login';
      renderLogin();
      return;
    }
    renderSetup(status.message ?? 'Database credentials are required before login.', status.databaseConnected);
  } catch (error) {
    renderSetup(error instanceof Error ? error.message : 'Database setup is required before login.');
  }
}
