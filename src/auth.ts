import { apiClient, root, state } from './app';
import { loadDashboardData } from './dashboard';
import { notifyStatus, showAppNotification } from './shared/notifications';
import { renderIcons } from './shared/icons';

const REMEMBERED_LOGIN_KEY = 'mto-bulk-sms.remembered-login';

function getRememberedLogin() {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(REMEMBERED_LOGIN_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { username?: string; password?: string };
    if (!parsed.username || !parsed.password) return null;
    return { username: parsed.username, password: parsed.password };
  } catch {
    return null;
  }
}

function saveRememberedLogin(username: string, password: string) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(REMEMBERED_LOGIN_KEY, JSON.stringify({ username, password }));
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

export function renderSetup(message = 'Configure MongoDB to continue.') {
  state.view = 'setup';
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
    </style>
    <div class="login-shell">
      <div class="login-card">
        <div class="brand"><img class="brand-mark" src="../assets/addu%20city%20logo.png" alt="City of Addu logo, the finest" /><span>MTO Bulk SMS Manager</span></div>
        <h1 class="screen-title">Database setup required</h1>
        <div class="sub">Set up MongoDB credentials before the app can create the admin account and unlock login.</div>
        <form id="setup-bootstrap-form">
          <div>
            <label for="setup-db-username">DB username</label>
            <input id="setup-db-username" name="username" autocomplete="username" placeholder="mongodb user" required />
          </div>
          <div style="margin-top: 14px;">
            <label for="setup-db-password">DB password</label>
            <input id="setup-db-password" name="password" type="password" autocomplete="new-password" placeholder="••••••••" required />
          </div>
          <div style="margin-top: 14px;">
            <label for="setup-db-host">DB host</label>
            <input id="setup-db-host" name="host" autocomplete="url" placeholder="cluster.mongodb.net" />
          </div>
          <button type="submit"><i data-lucide="database"></i>Save database settings</button>
        </form>
        <div id="setup-message" class="small warning">${message}</div>
      </div>
    </div>
  `;

  renderIcons(root);

  document.getElementById('setup-bootstrap-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const payload = {
      username: String(formData.get('username') ?? '').trim(),
      password: String(formData.get('password') ?? ''),
      host: String(formData.get('host') ?? '').trim() || undefined,
    };
    const message = document.getElementById('setup-message');
    const appApi = apiClient();

    try {
      if (!appApi) {
        throw new Error('This app requires the Electron runtime. Run npm run start to launch the live app.');
      }
      notifyStatus(message, 'Saving database settings and creating the admin user...');
      await appApi.invoke('setup:bootstrap', payload);
      notifyStatus(message, 'Database settings saved. Redirecting to login...', 'success');
      state.view = 'login';
      state.status = 'Database ready. Sign in with the admin account.';
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
            <input id="login-username" name="username" autocomplete="username" value="${rememberedLogin?.username ?? ''}" placeholder="Enter your username" required />
          </div>
          <div style="margin-top: 14px;">
            <label for="login-password">Password</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" value="${rememberedLogin?.password ?? ''}" placeholder="Enter your password" required />
          </div>
          <div class="remember-row">
            <label>
              <input name="remember-login" type="checkbox" ${rememberedLogin ? 'checked' : ''} />
              Remember me
            </label>
            ${rememberedLogin ? '<button id="forget-login-button" type="button" class="link-action"><i data-lucide="x"></i>Forget saved login</button>' : ''}
          </div>
          <button type="submit"><i data-lucide="log-in"></i>Log in</button>
        </form>
        <div id="login-message" class="small">Use the username and password assigned to your account.</div>
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
          saveRememberedLogin(username, password);
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
  const appApi = apiClient();
  state.view = 'setup';

  if (!appApi) {
    renderSetup('This app requires the Electron runtime. Run npm run start to launch the live app.');
    return;
  }

  try {
    const status = await appApi.invoke('setup:status') as { ready: boolean; message?: string };
    if (status.ready) {
      state.view = 'login';
      renderLogin();
      return;
    }
    renderSetup(status.message ?? 'Database credentials are required before login.');
  } catch (error) {
    renderSetup(error instanceof Error ? error.message : 'Database setup is required before login.');
  }
}
