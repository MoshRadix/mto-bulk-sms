import { apiClient, root, state } from './app';
import { loadDashboardData } from './dashboard';

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
      body { margin: 0; font-family: Arial, Helvetica, sans-serif; background: linear-gradient(135deg, #020817, #0f172a 35%, #111827); color: var(--text); }
      .login-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .login-card { width: min(500px, 100%); background: var(--panel); border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 18px 50px rgba(2, 8, 23, 0.5); padding: 28px; }
      .brand { font-size: 1.8rem; font-weight: 700; margin-bottom: 8px; }
      .sub { color: var(--muted); margin-bottom: 22px; }
      label { display: block; font-size: 0.8rem; color: var(--muted); margin-bottom: 6px; }
      input, button { width: 100%; border-radius: 10px; border: 1px solid var(--border); background: rgba(15,23,42,0.72); color: var(--text); padding: 12px; font: inherit; }
      button { margin-top: 12px; cursor: pointer; background: linear-gradient(135deg, var(--accent), #22c55e); border: none; color: #04171a; font-weight: 700; }
      .small { color: var(--muted); margin-top: 12px; font-size: 0.8rem; }
      .warning { color: #fbbf24; }
    </style>
    <div class="login-shell">
      <div class="login-card">
        <div class="brand">Database setup required</div>
        <div class="sub">Set up MongoDB credentials before the app can create the admin account and unlock login.</div>
        <form id="setup-bootstrap-form">
          <div>
            <label>DB username</label>
            <input name="username" placeholder="mongodb user" required />
          </div>
          <div style="margin-top: 14px;">
            <label>DB password</label>
            <input name="password" type="password" placeholder="••••••••" required />
          </div>
          <div style="margin-top: 14px;">
            <label>DB host</label>
            <input name="host" placeholder="cluster.mongodb.net" />
          </div>
          <button type="submit">Save database settings</button>
        </form>
        <div id="setup-message" class="small warning">${message}</div>
      </div>
    </div>
  `;

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
      message!.textContent = 'Saving database settings and creating the admin user...';
      await appApi.invoke('setup:bootstrap', payload);
      message!.textContent = 'Database settings saved. Redirecting to login...';
      state.view = 'login';
      state.status = 'Database ready. Sign in with the admin account.';
      setTimeout(() => renderLogin(), 300);
    } catch (error) {
      message!.textContent = error instanceof Error ? error.message : 'Unable to save database settings.';
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
      body { margin: 0; font-family: Arial, Helvetica, sans-serif; background: linear-gradient(135deg, #020817, #0f172a 35%, #111827); color: var(--text); }
      .login-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .login-card { width: min(430px, 100%); background: var(--panel); border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 18px 50px rgba(2, 8, 23, 0.5); padding: 28px; }
      .brand { font-size: 1.8rem; font-weight: 700; margin-bottom: 8px; }
      .sub { color: var(--muted); margin-bottom: 22px; }
      label { display: block; font-size: 0.8rem; color: var(--muted); margin-bottom: 6px; }
      input, button { width: 100%; border-radius: 10px; border: 1px solid var(--border); background: rgba(15,23,42,0.72); color: var(--text); padding: 12px; font: inherit; }
      button { margin-top: 12px; cursor: pointer; background: linear-gradient(135deg, var(--accent), #22c55e); border: none; color: #04171a; font-weight: 700; }
      .small { color: var(--muted); margin-top: 12px; font-size: 0.8rem; }
      .remember-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
      .remember-row label { margin: 0; color: var(--muted); font-size: 0.8rem; display: flex; align-items: center; gap: 8px; }
      .remember-row input[type='checkbox'] { width: auto; margin: 0; }
      .secondary { background: rgba(148,163,184,0.14); color: var(--text); border: 1px solid var(--border); }
    </style>
    <div class="login-shell">
      <div class="login-card">
        <div class="brand">MTO Bulk SMS Manager</div>
        <div class="sub">Sign in to access contacts, groups, and the SMS workflow.</div>
        <form id="login-form">
          <div>
            <label>Username</label>
            <input name="username" value="${rememberedLogin?.username ?? ''}" placeholder="Enter your username" required />
          </div>
          <div style="margin-top: 14px;">
            <label>Password</label>
            <input name="password" type="password" value="${rememberedLogin?.password ?? ''}" placeholder="Enter your password" required />
          </div>
          <div class="remember-row">
            <label>
              <input name="remember-login" type="checkbox" ${rememberedLogin ? 'checked' : ''} />
              Remember me
            </label>
            ${rememberedLogin ? '<button id="forget-login-button" type="button" class="secondary">Forget saved login</button>' : ''}
          </div>
          <button type="submit">Log in</button>
        </form>
        <div id="login-message" class="small">Use the username and password assigned to your account.</div>
      </div>
    </div>
  `;

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
        await loadDashboardData();
        return;
      }
      throw new Error('Login failed.');
    } catch (error) {
      message!.textContent = error instanceof Error ? error.message : 'Unable to log in.';
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
