import { apiClient, getValidContactCount, root, state } from './app';
import { isValidMvMobile, normalizeMvNumber } from './shared/phone';
import { exportContactsCsv, exportSmsLogsCsv, filterSmsLogs, parseContactsCsv } from './shared/reporting';
import { bindSettingsTabs, attachSettingsHandlers } from './settings';

export async function loadDashboardData() {
  const appApi = apiClient();
  state.view = 'dashboard';
  if (!appApi) {
    state.contacts = [];
    state.groups = [];
    state.sms = [];
    state.status = 'Live database access is available only when the Electron app is running.';
    renderDashboard();
    return;
  }

  try {
    const [contacts, groups, sms, users] = await Promise.all([
      appApi.invoke('contacts:list') as Promise<Array<{ id: string; name: string; mobile: string; department: string; groupId?: string; groupName?: string }>>,
      appApi.invoke('groups:list') as Promise<Array<{ id: string; name: string; description: string; memberCount: number }>>,
      appApi.invoke('sms:list', { userId: state.user?.id, role: state.user?.role }) as Promise<Array<{ id: string; to: string; message: string; status: string; createdAt?: string | null }>>,
      appApi.invoke('users:list') as Promise<Array<{ id: string; username: string; name: string; email: string; role: 'administrator' | 'user'; active: boolean }>>,
    ]);

    state.contacts = contacts.map((item) => ({
      id: item.id,
      name: item.name,
      mobile: item.mobile,
      department: item.department ?? '',
      groupId: item.groupId ?? '',
      groupName: item.groupName ?? 'Unassigned',
    }));
    state.groups = groups.map((item) => ({ id: item.id, name: item.name, description: item.description ?? '', memberCount: item.memberCount ?? 0 }));
    state.sms = sms.map((item) => ({ id: item.id, to: item.to, message: item.message, status: item.status, createdAt: item.createdAt ?? null }));
    state.users = users.map((item) => ({ id: item.id, username: item.username, name: item.name, email: item.email, role: item.role, active: item.active }));
    state.status = 'Connected to database-backed data.';
  } catch (error) {
    state.contacts = [];
    state.groups = [];
    state.sms = [];
    state.users = [];
    state.status = error instanceof Error ? error.message : 'Unable to connect to the database-backed app services.';
  }

  renderDashboard();
}

function bindMainNavigation() {
  document.querySelectorAll('.nav-tab').forEach((button) => {
    button.addEventListener('click', () => {
      const selectedSection = button.getAttribute('data-section');
      if (!selectedSection) return;

      document.querySelectorAll('.nav-tab').forEach((tab) => {
        const isActive = tab === button;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
      });

      document.querySelectorAll('.section').forEach((pane) => {
        const isActive = pane.getAttribute('data-section-panel') === selectedSection;
        pane.classList.toggle('active', isActive);
      });
    });
  });
}

export function renderDashboard() {
  if (!state.user) return;

  const stats = [
    { label: 'Contacts', value: String(state.contacts.length) },
    { label: 'Groups', value: String(state.groups.length) },
    { label: 'Queued SMS', value: String(state.sms.filter((item) => item.status === 'queued').length) },
    { label: 'Valid numbers', value: String(getValidContactCount()) },
  ];

  const groupsOptions = state.groups.length
    ? state.groups
        .map((group) => `<option value="${group.id}">${group.name} (${group.memberCount})</option>`)
        .join('')
    : '<option value="">No groups yet</option>';

  const adminNav = state.user?.role === 'administrator'
    ? '<button type="button" class="nav-tab" data-section="admin" aria-selected="false">Admin</button>'
    : '';

  const years = Array.from(new Set(
    state.sms
      .map((item) => (item.createdAt ? new Date(item.createdAt).getFullYear() : null))
      .filter((value): value is number => Number.isFinite(value)),
  )).sort((a, b) => b - a);

  const selectedYear = state.reportFilters.year ?? '';
  const selectedMonth = state.reportFilters.month ?? '';
  const reportRows = filterSmsLogs(state.sms, state.reportFilters);
  const yearOptions = years.length
    ? years.map((year) => `<option value="${year}" ${selectedYear === year ? 'selected' : ''}>${year}</option>`).join('')
    : '<option value="">No logs</option>';

  const monthLabels = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthOptions = monthLabels
    .map((label, index) => `<option value="${index + 1}" ${selectedMonth === String(index + 1) ? 'selected' : ''}>${label}</option>`)
    .join('');

  const userList = state.users.length
    ? state.users
        .map(
          (user) => `
            <li>
              <div>
                <strong>${user.name}</strong><br />
                <span class="muted">${user.username} · ${user.email} · ${user.role}</span>
              </div>
              <div style="display: flex; gap: 8px;">
                <button type="button" class="secondary" data-user-action="edit" data-user-id="${user.id}" style="max-width: 72px;">Edit</button>
                <button type="button" class="secondary" data-user-action="delete" data-user-id="${user.id}" style="max-width: 78px; background: rgba(248,113,113,0.14); color: #fecaca;">Delete</button>
              </div>
            </li>
          `,
        )
        .join('')
    : '<li><span class="muted">No users found.</span></li>';

  const reportRowsHtml = reportRows.length
    ? reportRows
        .slice(0, 25)
        .map(
          (item) => `
            <li>
              <div>
                <strong>${item.to}</strong><br />
                <span class="muted">${item.message}</span>
              </div>
              <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
                <span class="pill ${item.status === 'delivered' || item.status === 'submitted' ? '' : 'danger'}">${item.status}</span>
                <span class="muted" style="font-size: 0.72rem;">${item.createdAt ? new Date(item.createdAt).toLocaleDateString() : 'Unknown date'}</span>
              </div>
            </li>
          `,
        )
        .join('')
    : '<li><span class="muted">No SMS logs match the selected period.</span></li>';

  root.innerHTML = `
    <style>
      :root {
        --bg: #091320;
        --bg-strong: #0f172a;
        --panel: rgba(15, 23, 42, 0.94);
        --panel-soft: rgba(17, 24, 39, 0.9);
        --panel-alt: rgba(15, 118, 110, 0.08);
        --text: #ebf2ff;
        --muted: #9fb3c8;
        --line: rgba(148, 163, 184, 0.2);
        --primary: #60a5fa;
        --primary-strong: #2563eb;
        --success: #34d399;
        --warning: #fbbf24;
        --danger: #f87171;
        --purple: #8b5cf6;
        --cyan: #22d3ee;
        --teal: #14b8a6;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, Arial, Helvetica, sans-serif;
        background:
          radial-gradient(circle at top left, rgba(37, 99, 235, 0.25), transparent 30%),
          radial-gradient(circle at bottom right, rgba(20, 184, 166, 0.15), transparent 28%),
          linear-gradient(135deg, var(--bg), var(--bg-strong));
        color: var(--text);
      }
      .app { min-height: 100vh; padding: 24px; }
      .app-shell {
        max-width: 1500px;
        margin: 0 auto;
        display: grid;
        grid-template-columns: 240px minmax(0, 1fr);
        gap: 20px;
      }
      .sidebar {
        background: rgba(15, 23, 42, 0.82);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 18px 16px;
        display: flex;
        flex-direction: column;
        gap: 18px;
        box-shadow: 0 18px 40px rgba(2, 6, 23, 0.38);
      }
      .brand-block {
        display: flex;
        align-items: center;
        gap: 12px;
        padding-bottom: 18px;
        border-bottom: 1px solid var(--line);
      }
      .brand-badge {
        width: 42px;
        height: 42px;
        border-radius: 12px;
        display: grid;
        place-items: center;
        font-weight: 800;
        background: linear-gradient(135deg, var(--primary), var(--teal));
        color: white;
      }
      .brand-title { font-size: 1.05rem; font-weight: 800; letter-spacing: 0.04em; }
      .brand-subtitle { font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.14em; }
      .sidebar-label {
        font-size: 0.72rem;
        color: var(--muted);
        letter-spacing: 0.12em;
        text-transform: uppercase;
        padding: 0 4px;
      }
      .nav {
        display: grid;
        gap: 8px;
      }
      .nav-tab {
        background: rgba(148, 163, 184, 0.08);
        color: var(--text);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px 14px;
        font-weight: 700;
        cursor: pointer;
        text-align: left;
        transition: all 0.15s ease;
      }
      .nav-tab.active {
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);
        transform: translateX(2px);
      }
      .nav-tab[data-section="dashboard"].active { background: linear-gradient(135deg, rgba(59,130,246,0.28), rgba(37,99,235,0.18)); color: #dbeafe; }
      .nav-tab[data-section="contacts"].active { background: linear-gradient(135deg, rgba(34,211,238,0.28), rgba(14,165,233,0.18)); color: #cffafe; }
      .nav-tab[data-section="groups"].active { background: linear-gradient(135deg, rgba(20,184,166,0.28), rgba(13,148,136,0.18)); color: #ccfbf1; }
      .nav-tab[data-section="settings"].active { background: linear-gradient(135deg, rgba(139,92,246,0.28), rgba(124,58,237,0.18)); color: #ede9fe; }
      .sidebar-footer {
        margin-top: auto;
        padding-top: 12px;
        border-top: 1px solid var(--line);
      }
      .mini-card {
        background: rgba(148,163,184,0.06);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
      }
      .mini-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); }
      .content {
        display: grid;
        gap: 18px;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 18px 20px;
        background: rgba(15, 23, 42, 0.72);
        border: 1px solid var(--line);
        border-radius: 16px;
        box-shadow: 0 12px 30px rgba(2, 6, 23, 0.24);
      }
      .brand { font-size: 1.8rem; font-weight: 800; letter-spacing: 0.02em; }
      .user-pill { color: var(--muted); font-size: 0.8rem; margin-top: 4px; }
      .status {
        background: rgba(52, 211, 153, 0.12);
        border: 1px solid rgba(52, 211, 153, 0.35);
        color: #bbf7d0;
        padding: 9px 12px;
        border-radius: 999px;
        font-size: 0.84rem;
        white-space: nowrap;
      }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
      .card {
        background: rgba(17, 24, 39, 0.9);
        border: 1px solid var(--line);
        border-radius: 16px;
        box-shadow: 0 12px 30px rgba(15,23,42,0.25);
      }
      .stat { padding: 18px; }
      .stat-label { color: var(--muted); font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.12em; }
      .stat-value { font-size: 2rem; font-weight: 800; margin-top: 10px; }
      .layout { display: grid; grid-template-columns: 1fr; gap: 20px; }
      .panel { padding: 20px; }
      .layout > .card,
      .layout > .panel { width: 100%; }
      .panel h2 { margin: 0 0 16px; font-size: 1.1rem; }
      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      .section-title { font-size: 1.15rem; font-weight: 800; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      label { display: block; font-size: 0.8rem; color: var(--muted); margin-bottom: 6px; }
      input, textarea, select, button {
        width: 100%;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: rgba(15, 23, 42, 0.8);
        color: var(--text);
        padding: 10px 12px;
        font: inherit;
      }
      input:focus, textarea:focus, select:focus {
        outline: 2px solid rgba(96, 165, 250, 0.4);
        border-color: rgba(96, 165, 250, 0.7);
      }
      textarea { min-height: 110px; resize: vertical; }
      button {
        cursor: pointer;
        background: linear-gradient(135deg, var(--primary), var(--primary-strong));
        border: none;
        font-weight: 700;
        color: white;
        transition: filter 0.15s ease, transform 0.15s ease;
      }
      button:hover { filter: brightness(1.08); }
      button:active { transform: translateY(1px); }
      .secondary {
        background: linear-gradient(135deg, #374151, #4b5563);
        color: var(--text);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .muted { color: var(--muted); }
      ul { list-style: none; padding: 0; margin: 0; }
      li {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: center;
        padding: 12px 0;
        border-bottom: 1px solid var(--line);
      }
      li:last-child { border-bottom: none; }
      .pill {
        display: inline-block;
        padding: 5px 10px;
        border-radius: 999px;
        font-size: 0.72rem;
        background: rgba(56, 189, 248, 0.12);
        color: #bae6fd;
        white-space: nowrap;
      }
      .danger { background: rgba(248, 113, 113, 0.12); color: #fecaca; }
      .stack { display: grid; gap: 12px; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .actions button { flex: 1; }
      .section { display: none; }
      .section.active { display: block; }
      .settings-stack { display: grid; gap: 16px; }
      .settings-pane {
        display: block;
        padding: 18px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(15, 23, 42, 0.58);
      }
      .settings-pane h3 {
        margin: 0 0 16px;
        font-size: 1rem;
      }
      @media (max-width: 980px) {
        .app-shell { grid-template-columns: 1fr; }
        .sidebar { padding: 14px; }
      }
      @media (max-width: 820px) {
        .layout { grid-template-columns: 1fr; }
        .row { grid-template-columns: 1fr; }
        .topbar { flex-direction: column; align-items: flex-start; gap: 12px; }
      }
    </style>

    <div class="app">
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand-block">
            <div class="brand-badge">M</div>
            <div>
              <div class="brand-title">MTO</div>
              <div class="brand-subtitle">Bulk SMS</div>
            </div>
          </div>

          <div class="sidebar-label">Workspace</div>
          <div class="nav" role="tablist" aria-label="Main navigation">
            <button type="button" class="nav-tab active" data-section="dashboard" aria-selected="true">Dashboard</button>
            <button type="button" class="nav-tab" data-section="contacts" aria-selected="false">Contacts</button>
            <button type="button" class="nav-tab" data-section="groups" aria-selected="false">Groups</button>
            ${adminNav}
            <button type="button" class="nav-tab" data-section="settings" aria-selected="false">Settings</button>
          </div>

          <div class="sidebar-footer">
            <div class="mini-card">
              <div class="mini-label">Account</div>
              <div style="margin-top: 8px; font-weight: 700;">${state.user.name}</div>
              <div class="muted" style="margin-top: 4px;">${state.user.role}</div>
            </div>
          </div>
        </aside>

        <main class="content">
          <div class="topbar">
            <div>
              <div class="brand">MTO Bulk SMS Manager</div>
              <div class="user-pill">Signed in as ${state.user.name} (${state.user.role})</div>
            </div>
            <div class="status">${state.status}</div>
          </div>

      <div class="section active" data-section-panel="dashboard">
        <div class="grid">
          ${stats
            .map(
              (item) => `
                <div class="card stat">
                  <div class="stat-label">${item.label}</div>
                  <div class="stat-value">${item.value}</div>
                </div>
              `,
            )
            .join('')}
        </div>

        <div class="layout" style="margin-top: 20px;">
          <div class="card panel">
            <h2>SMS composer</h2>
            <form id="sms-form" class="stack">
              <div>
                <label>Recipient</label>
                <input name="to" placeholder="9607712345" />
              </div>
              <div>
                <label>Send to group</label>
                <select name="groupId">
                  <option value="">Direct number</option>
                  ${groupsOptions}
                </select>
              </div>
              <div>
                <label>Message</label>
                <textarea name="message" placeholder="Type the message to send..." required></textarea>
              </div>
              <div class="actions">
                <button type="submit" style="background: linear-gradient(135deg, #22c55e, #16a34a); color: #f0fdf4;">Queue SMS</button>
                <button type="button" class="secondary" id="send-sms" style="background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff7ed;">Send queued</button>
              </div>
            </form>
            <p class="muted" id="sms-status">Messages are validated against Maldives mobile-number rules before sending.</p>
          </div>

          <div class="card panel">
            <h2>Outgoing SMS log</h2>
            <ul>
              ${state.sms.length
                ? state.sms
                    .map(
                      (item) => `
                        <li>
                          <div>
                            <strong>${item.to}</strong><br />
                            <span class="muted">${item.message}</span>
                          </div>
                          <span class="pill ${item.status === 'delivered' ? '' : 'danger'}">${item.status}</span>
                        </li>
                      `,
                    )
                    .join('')
                : '<li><span class="muted">No SMS jobs queued.</span></li>'}
            </ul>
          </div>
        </div>
      </div>

      <div class="section" data-section-panel="contacts">
        <div class="card panel" style="margin-top: 20px;">
          <h2>Contacts</h2>
          <form id="contact-form" class="stack">
            <input type="hidden" name="contactId" />
            <div class="row">
              <div>
                <label>Name</label>
                <input name="name" placeholder="Full name" required />
              </div>
              <div>
                <label>Mobile</label>
                <input name="mobile" placeholder="9607712345" required />
              </div>
            </div>
            <div class="row">
              <div>
                <label>Department</label>
                <input name="department" placeholder="Department" />
              </div>
              <div>
                <label>Designation</label>
                <input name="designation" placeholder="Role / title" />
              </div>
            </div>
            <div>
              <label>Group</label>
              <select name="groupId" required>
                <option value="">Select group</option>
                ${state.groups.map((group) => `<option value="${group.id}">${group.name}</option>`).join('')}
              </select>
            </div>
            <div>
              <label>Notes</label>
              <textarea name="notes" placeholder="Optional notes"></textarea>
            </div>
            <div class="actions" style="margin-top: 4px;">
              <button type="submit">${state.user?.role === 'administrator' ? 'Save contact' : 'Add contact'}</button>
              <button type="button" class="secondary" id="reset-contact-form">Clear</button>
              <button type="button" class="secondary" id="export-contacts-csv">Export CSV</button>
              <button type="button" class="secondary" id="import-contacts-csv">Import CSV</button>
              ${state.user?.role === 'administrator' ? '<button type="button" class="secondary" id="bulk-delete-contacts">Bulk delete</button>' : ''}
            </div>
            <input id="contacts-import-input" type="file" accept=".csv,text/csv" hidden />
          </form>
          <ul id="contact-list" style="margin-top: 14px;">
            ${state.contacts.length
              ? state.contacts
                  .map(
                    (contact) => `
                      <li>
                        <div>
                          <strong>${contact.name}</strong><br />
                          <span class="muted">${contact.mobile} · ${contact.department || 'No department'} · ${contact.groupName || 'No group'}</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px;">
                          ${state.user?.role === 'administrator'
                            ? `
                                <input type="checkbox" class="contact-bulk-select" value="${contact.id}" aria-label="Select ${contact.name}" />
                                <button type="button" class="secondary" data-contact-action="edit" data-contact-id="${contact.id}" style="max-width: 64px;">Edit</button>
                                <button type="button" class="secondary" data-contact-action="delete" data-contact-id="${contact.id}" style="max-width: 78px; background: rgba(248,113,113,0.14); color: #fecaca;">Delete</button>
                              `
                            : ''}
                          <span class="pill ${isValidMvMobile(contact.mobile) ? '' : 'danger'}">${isValidMvMobile(contact.mobile) ? 'Valid' : 'Invalid'}</span>
                        </div>
                      </li>
                    `,
                  )
                  .join('')
              : '<li><span class="muted">No contacts recorded yet.</span></li>'}
          </ul>
        </div>
      </div>

      <div class="section" data-section-panel="groups">
        <div class="card panel" style="margin-top: 20px;">
          <h2>Groups</h2>
          <form id="group-form" class="stack">
            <input type="hidden" name="groupId" />
            <div>
              <label>Group name</label>
              <input name="name" placeholder="Roadworks Team" required />
            </div>
            <div>
              <label>Description</label>
              <textarea name="description" placeholder="Group purpose"></textarea>
            </div>
            <div class="actions">
              <button type="submit">${state.user?.role === 'administrator' ? 'Save group' : 'Create group'}</button>
              <button type="button" class="secondary" id="reset-group-form">Clear</button>
              ${state.user?.role === 'administrator' ? '<button type="button" class="secondary" id="bulk-delete-groups">Bulk delete</button>' : ''}
            </div>
          </form>
          <ul id="group-list" style="margin-top: 14px;">
            ${state.groups.length
              ? state.groups
                  .map(
                    (group) => `
                      <li>
                        <div>
                          <strong>${group.name}</strong><br />
                          <span class="muted">${group.description || 'No description'} · ${group.memberCount} members</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px;">
                          ${state.user?.role === 'administrator'
                            ? `
                                <input type="checkbox" class="group-bulk-select" value="${group.id}" aria-label="Select ${group.name}" />
                                <button type="button" class="secondary" data-group-action="edit" data-group-id="${group.id}" style="max-width: 64px;">Edit</button>
                                <button type="button" class="secondary" data-group-action="delete" data-group-id="${group.id}" style="max-width: 78px; background: rgba(248,113,113,0.14); color: #fecaca;">Delete</button>
                              `
                            : ''}
                          <span class="pill">${group.memberCount}</span>
                        </div>
                      </li>
                    `,
                  )
                  .join('')
              : '<li><span class="muted">No groups created yet.</span></li>'}
          </ul>
        </div>
      </div>

      <div class="section" data-section-panel="admin">
        <div class="card panel" style="margin-top: 20px;">
          <h2>Admin</h2>
          ${state.user?.role === 'administrator'
            ? `
              <div class="layout">
                <div class="card panel">
                  <h2>User management</h2>
                  <form id="user-form" class="stack">
                    <input type="hidden" name="userId" />
                    <div class="row">
                      <div>
                        <label>Name</label>
                        <input name="name" placeholder="Administrator name" required />
                      </div>
                      <div>
                        <label>Role</label>
                        <select name="role">
                          <option value="user">User</option>
                          <option value="administrator">Administrator</option>
                        </select>
                      </div>
                    </div>
                    <div class="row">
                      <div>
                        <label>Username</label>
                        <input name="username" placeholder="username" required />
                      </div>
                      <div>
                        <label>Email</label>
                        <input name="email" type="email" placeholder="name@example.com" required />
                      </div>
                    </div>
                    <div>
                      <label>Password</label>
                      <input name="password" type="password" placeholder="Password" />
                    </div>
                    <div class="actions">
                      <button type="submit">Save user</button>
                      <button type="button" class="secondary" id="reset-user-form">Clear</button>
                    </div>
                  </form>
                  <p class="muted" id="user-status">Create or update admin and staff accounts.</p>
                  <ul id="user-list" style="margin-top: 14px;">
                    ${userList}
                  </ul>
                </div>

                <div class="card panel">
                  <h2>SMS log report</h2>
                  <div class="row">
                    <div>
                      <label>Year</label>
                      <select id="report-year" name="report-year">
                        <option value="">All years</option>
                        ${yearOptions}
                      </select>
                    </div>
                    <div>
                      <label>Month</label>
                      <select id="report-month" name="report-month">
                        <option value="">All months</option>
                        ${monthOptions}
                      </select>
                    </div>
                  </div>
                  <div class="actions" style="margin-top: 12px;">
                    <button type="button" class="secondary" id="export-sms-csv">Export CSV</button>
                    <button type="button" class="secondary" id="clear-sms-filter">Clear filters</button>
                  </div>
                  <ul style="margin-top: 14px;">
                    ${reportRowsHtml}
                  </ul>
                </div>
              </div>
            `
            : '<p class="muted">Administrator access is required to manage users and export SMS reports.</p>'}
        </div>
      </div>

      <div class="section" data-section-panel="settings">
        <div class="card panel" style="margin-top: 20px;">
          <h2>Settings</h2>

          <div class="settings-stack">
            <div class="settings-pane" data-pane="database">
              <h3>Database</h3>
              <form id="setup-form" class="stack">
                <div class="row">
                  <div>
                    <label>DB username</label>
                    <input name="username" placeholder="mongodb user" required />
                  </div>
                  <div>
                    <label>DB host</label>
                    <input name="host" placeholder="cluster.mongodb.net" />
                  </div>
                </div>
                <div>
                  <label>DB password</label>
                  <input name="password" type="password" placeholder="••••••••" required />
                </div>
                <div class="actions">
                  <button type="submit">Save DB settings</button>
                  <button type="button" class="secondary" id="test-db">Test connection</button>
                  <button type="button" class="secondary" id="init-db">Initialize collections</button>
                </div>
              </form>
              <p class="muted" id="setup-status">Your encrypted database settings are stored locally in the app.</p>
            </div>

          </div>
        </div>
      </div>
        </main>
      </div>
    </div>
  `;

  bindMainNavigation();
  bindSettingsTabs();
  attachSettingsHandlers();

  document.getElementById('contact-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const contactId = String(formData.get('contactId') ?? '').trim();
    const payload = {
      name: String(formData.get('name') ?? '').trim(),
      mobile: normalizeMvNumber(String(formData.get('mobile') ?? '')),
      department: String(formData.get('department') ?? '').trim(),
      designation: String(formData.get('designation') ?? '').trim(),
      notes: String(formData.get('notes') ?? '').trim(),
      groupId: String(formData.get('groupId') ?? '').trim(),
    };
    const status = document.getElementById('sms-status');
    const appApi = apiClient();
    if (!payload.name || !payload.mobile || !isValidMvMobile(payload.mobile)) {
      status!.textContent = 'Contact not saved: use a valid Maldives mobile number.';
      return;
    }
    if (!payload.groupId) {
      status!.textContent = 'Contact not saved: select a group for this contact.';
      return;
    }
    try {
      if (!appApi) {
        const groupName = state.groups.find((group) => group.id === payload.groupId)?.name ?? 'Unassigned';
        state.contacts.unshift({ id: `demo-${Date.now()}`, name: payload.name, mobile: payload.mobile, department: payload.department, groupId: payload.groupId, groupName });
        renderDashboard();
        status!.textContent = `Demo contact saved to ${groupName}.`;
        form.reset();
        return;
      }
      if (contactId) {
        await appApi.invoke('contacts:update', { id: contactId, ...payload });
        status!.textContent = `Contact updated for ${payload.mobile}.`;
      } else {
        await appApi.invoke('contacts:create', payload);
        status!.textContent = `Contact added for ${payload.mobile}.`;
      }
      await loadDashboardData();
      form.reset();
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Unable to save contact.';
    }
  });

  document.getElementById('reset-contact-form')?.addEventListener('click', () => {
    const form = document.getElementById('contact-form') as HTMLFormElement | null;
    if (!form) return;
    form.reset();
    const hiddenIdField = form.elements.namedItem('contactId') as HTMLInputElement | null;
    if (hiddenIdField) hiddenIdField.value = '';
  });

  document.getElementById('contact-list')?.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest('[data-contact-action]') as HTMLElement | null;
    if (!button) return;

    const action = button.getAttribute('data-contact-action');
    const contactId = button.getAttribute('data-contact-id');
    if (!action || !contactId) return;

    const status = document.getElementById('sms-status');
    const appApi = apiClient();
    const form = document.getElementById('contact-form') as HTMLFormElement | null;
    const contact = state.contacts.find((item) => item.id === contactId);
    if (action === 'edit' && contact && form) {
      const hiddenIdField = form.elements.namedItem('contactId') as HTMLInputElement | null;
      const nameField = form.elements.namedItem('name') as HTMLInputElement | null;
      const mobileField = form.elements.namedItem('mobile') as HTMLInputElement | null;
      const departmentField = form.elements.namedItem('department') as HTMLInputElement | null;
      const designationField = form.elements.namedItem('designation') as HTMLInputElement | null;
      const notesField = form.elements.namedItem('notes') as HTMLTextAreaElement | null;
      const groupField = form.elements.namedItem('groupId') as HTMLSelectElement | null;
      if (hiddenIdField) hiddenIdField.value = contact.id;
      if (nameField) nameField.value = contact.name;
      if (mobileField) mobileField.value = contact.mobile;
      if (departmentField) departmentField.value = contact.department;
      if (designationField) designationField.value = '';
      if (notesField) notesField.value = '';
      if (groupField) groupField.value = contact.groupId ?? '';
      status!.textContent = `Editing ${contact.name}.`;
      return;
    }

    if (action === 'delete') {
      try {
        if (!appApi) {
          status!.textContent = 'Contact deletion is only available in the Electron app.';
          return;
        }
        await appApi.invoke('contacts:delete', { id: contactId });
        await loadDashboardData();
        status!.textContent = `${contact?.name ?? 'Contact'} deleted.`;
      } catch (error) {
        status!.textContent = error instanceof Error ? error.message : 'Unable to delete contact.';
      }
    }
  });

  document.getElementById('bulk-delete-contacts')?.addEventListener('click', async () => {
    const ids = Array.from(document.querySelectorAll('.contact-bulk-select:checked'))
      .map((item) => item.getAttribute('value'))
      .filter((value): value is string => Boolean(value));
    const status = document.getElementById('sms-status');
    const appApi = apiClient();
    if (!ids.length) {
      status!.textContent = 'Select one or more contacts to delete.';
      return;
    }
    try {
      if (!appApi) {
        status!.textContent = 'Bulk contact deletion is only available in the Electron app.';
        return;
      }
      await appApi.invoke('contacts:bulk-delete', { ids });
      await loadDashboardData();
      status!.textContent = `${ids.length} contact(s) deleted.`;
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Unable to delete selected contacts.';
    }
  });

  document.getElementById('group-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const groupId = String(formData.get('groupId') ?? '').trim();
    const payload = {
      name: String(formData.get('name') ?? '').trim(),
      description: String(formData.get('description') ?? '').trim(),
      members: [] as string[],
    };
    const status = document.getElementById('sms-status');
    const appApi = apiClient();
    if (!payload.name) {
      status!.textContent = 'Group not saved: name is required.';
      return;
    }
    try {
      if (!appApi) {
        state.groups.unshift({ id: `demo-group-${Date.now()}`, name: payload.name, description: payload.description, memberCount: 0 });
        renderDashboard();
        status!.textContent = 'Demo group created.';
        form.reset();
        return;
      }
      if (groupId) {
        await appApi.invoke('groups:update', { id: groupId, ...payload });
        status!.textContent = `Group updated: ${payload.name}.`;
      } else {
        await appApi.invoke('groups:create', payload);
        status!.textContent = `Group created: ${payload.name}.`;
      }
      await loadDashboardData();
      form.reset();
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Unable to save group.';
    }
  });

  document.getElementById('reset-group-form')?.addEventListener('click', () => {
    const form = document.getElementById('group-form') as HTMLFormElement | null;
    if (!form) return;
    form.reset();
    const hiddenIdField = form.elements.namedItem('groupId') as HTMLInputElement | null;
    if (hiddenIdField) hiddenIdField.value = '';
  });

  document.getElementById('group-list')?.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest('[data-group-action]') as HTMLElement | null;
    if (!button) return;

    const action = button.getAttribute('data-group-action');
    const groupId = button.getAttribute('data-group-id');
    if (!action || !groupId) return;

    const status = document.getElementById('sms-status');
    const appApi = apiClient();
    const group = state.groups.find((item) => item.id === groupId);
    const form = document.getElementById('group-form') as HTMLFormElement | null;

    if (action === 'edit' && group && form) {
      const hiddenIdField = form.elements.namedItem('groupId') as HTMLInputElement | null;
      const nameField = form.elements.namedItem('name') as HTMLInputElement | null;
      const descriptionField = form.elements.namedItem('description') as HTMLTextAreaElement | null;
      if (hiddenIdField) hiddenIdField.value = group.id;
      if (nameField) nameField.value = group.name;
      if (descriptionField) descriptionField.value = group.description;
      status!.textContent = `Editing group ${group.name}.`;
      return;
    }

    if (action === 'delete') {
      try {
        if (!appApi) {
          status!.textContent = 'Group deletion is only available in the Electron app.';
          return;
        }
        await appApi.invoke('groups:delete', { id: groupId });
        await loadDashboardData();
        status!.textContent = `${group?.name ?? 'Group'} deleted.`;
      } catch (error) {
        status!.textContent = error instanceof Error ? error.message : 'Unable to delete group.';
      }
    }
  });

  document.getElementById('bulk-delete-groups')?.addEventListener('click', async () => {
    const ids = Array.from(document.querySelectorAll('.group-bulk-select:checked'))
      .map((item) => item.getAttribute('value'))
      .filter((value): value is string => Boolean(value));
    const status = document.getElementById('sms-status');
    const appApi = apiClient();
    if (!ids.length) {
      status!.textContent = 'Select one or more groups to delete.';
      return;
    }
    try {
      if (!appApi) {
        status!.textContent = 'Bulk group deletion is only available in the Electron app.';
        return;
      }
      await appApi.invoke('groups:bulk-delete', { ids });
      await loadDashboardData();
      status!.textContent = `${ids.length} group(s) deleted.`;
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Unable to delete selected groups.';
    }
  });

  document.getElementById('sms-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const rawTo = String(formData.get('to') ?? '').trim();
    const rawGroupId = String(formData.get('groupId') ?? '').trim();
    const payload = {
      to: rawTo ? normalizeMvNumber(rawTo) : undefined,
      message: String(formData.get('message') ?? '').trim(),
      groupId: rawGroupId || undefined,
    };
    const status = document.getElementById('sms-status');
    const appApi = apiClient();
    if (!payload.message) {
      status!.textContent = 'SMS not queued: message text is required.';
      return;
    }
    if (!payload.groupId && !payload.to) {
      status!.textContent = 'SMS not queued: enter a mobile number or select a group.';
      return;
    }
    if (!payload.groupId && !isValidMvMobile(payload.to ?? '')) {
      status!.textContent = 'SMS not queued: invalid Maldives mobile number.';
      return;
    }
    try {
      if (!appApi) {
        state.sms.unshift({ id: `demo-sms-${Date.now()}`, to: payload.to || '9607712345', message: payload.message, status: 'queued' });
        renderDashboard();
        status!.textContent = 'Demo SMS queued.';
        return;
      }
      await appApi.invoke('sms:queue', { ...payload, userId: state.user?.id, role: state.user?.role });
      await loadDashboardData();
      status!.textContent = `SMS queued for ${payload.to || 'selected group'}.`;
      form.reset();
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Unable to queue SMS.';
    }
  });

  document.getElementById('send-sms')?.addEventListener('click', async () => {
    const status = document.getElementById('sms-status');
    const appApi = apiClient();
    try {
      if (!appApi) {
        state.sms = state.sms.map((item) => ({ ...item, status: item.status === 'queued' ? 'delivered' : item.status }));
        renderDashboard();
        status!.textContent = 'Demo SMS jobs marked as delivered.';
        return;
      }
      const count = await appApi.invoke('sms:send', { userId: state.user?.id, role: state.user?.role });
      await loadDashboardData();
      status!.textContent = `${count} queued SMS jobs sent successfully.`;
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Unable to send queued SMS.';
    }
  });

  document.getElementById('export-contacts-csv')?.addEventListener('click', () => {
    const csv = exportContactsCsv(
      state.contacts.map((contact) => ({
        name: contact.name,
        mobile: contact.mobile,
        department: contact.department,
        designation: '',
        notes: '',
        groupName: contact.groupName ?? '',
      })),
    );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'contacts.csv';
    link.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('import-contacts-csv')?.addEventListener('click', () => {
    const input = document.getElementById('contacts-import-input') as HTMLInputElement | null;
    input?.click();
  });

  document.getElementById('contacts-import-input')?.addEventListener('change', async (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    const status = document.getElementById('sms-status');
    if (!file) return;

    const appApi = apiClient();
    try {
      const csvText = await file.text();
      const rows = parseContactsCsv(csvText);
      if (!rows.length) {
        status!.textContent = 'No contact rows were found in the selected CSV file.';
        return;
      }
      if (!appApi) {
        status!.textContent = 'Contact import is only available in the Electron app.';
        return;
      }

      const payload = rows.map((row) => ({
        name: row.name,
        mobile: normalizeMvNumber(row.mobile),
        department: row.department ?? '',
        designation: row.designation ?? '',
        notes: row.notes ?? '',
        groupName: row.groupName ?? '',
        groupId: '',
      }));

      await appApi.invoke('contacts:import', payload);
      await loadDashboardData();
      status!.textContent = `Imported ${payload.length} contacts from ${file.name}.`;
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Unable to import contacts.';
    } finally {
      input.value = '';
    }
  });

  document.getElementById('user-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const userId = String(formData.get('userId') ?? '').trim();
    const payload = {
      name: String(formData.get('name') ?? '').trim(),
      username: String(formData.get('username') ?? '').trim(),
      email: String(formData.get('email') ?? '').trim(),
      password: String(formData.get('password') ?? '').trim(),
      role: String(formData.get('role') ?? 'user').trim() as 'administrator' | 'user',
    };
    const status = document.getElementById('user-status');
    const appApi = apiClient();

    if (!payload.name || !payload.username || !payload.email) {
      status!.textContent = 'Missing required user fields.';
      return;
    }

    try {
      if (!appApi) {
        status!.textContent = 'User management is only available in the Electron app.';
        return;
      }

      if (userId) {
        await appApi.invoke('users:update', { id: userId, ...payload, password: payload.password || undefined });
        status!.textContent = `Updated user ${payload.username}.`;
      } else {
        if (!payload.password || payload.password.length < 6) {
          status!.textContent = 'A password with at least 6 characters is required for new users.';
          return;
        }
        await appApi.invoke('users:create', payload);
        status!.textContent = `Created user ${payload.username}.`;
      }

      form.reset();
      await loadDashboardData();
    } catch (error) {
      status!.textContent = error instanceof Error ? error.message : 'Unable to save user.';
    }
  });

  document.getElementById('reset-user-form')?.addEventListener('click', () => {
    const form = document.getElementById('user-form') as HTMLFormElement | null;
    if (!form) return;
    form.reset();
    const hiddenIdField = form.elements.namedItem('userId') as HTMLInputElement | null;
    if (hiddenIdField) hiddenIdField.value = '';
    const status = document.getElementById('user-status');
    if (status) status.textContent = 'Create or update admin and staff accounts.';
  });

  document.getElementById('user-list')?.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest('[data-user-action]') as HTMLElement | null;
    if (!button) return;

    const userId = button.getAttribute('data-user-id');
    const action = button.getAttribute('data-user-action');
    if (!userId || !action) return;

    const user = state.users.find((item) => item.id === userId);
    const form = document.getElementById('user-form') as HTMLFormElement | null;
    if (!form) return;

    if (action === 'edit' && user) {
      const hiddenIdField = form.elements.namedItem('userId') as HTMLInputElement | null;
      const nameField = form.elements.namedItem('name') as HTMLInputElement | null;
      const usernameField = form.elements.namedItem('username') as HTMLInputElement | null;
      const emailField = form.elements.namedItem('email') as HTMLInputElement | null;
      const roleField = form.elements.namedItem('role') as HTMLSelectElement | null;
      const passwordField = form.elements.namedItem('password') as HTMLInputElement | null;
      if (hiddenIdField) hiddenIdField.value = user.id;
      if (nameField) nameField.value = user.name;
      if (usernameField) usernameField.value = user.username;
      if (emailField) emailField.value = user.email;
      if (roleField) roleField.value = user.role;
      if (passwordField) passwordField.value = '';
      const status = document.getElementById('user-status');
      if (status) status.textContent = `Editing ${user.username}.`;
      return;
    }

    if (action === 'delete') {
      const status = document.getElementById('user-status');
      const appApi = apiClient();
      try {
        if (!appApi) {
          status!.textContent = 'User deletion is only available in the Electron app.';
          return;
        }
        await appApi.invoke('users:delete', { id: userId });
        await loadDashboardData();
        status!.textContent = `${user?.username ?? 'User'} deleted.`;
      } catch (error) {
        status!.textContent = error instanceof Error ? error.message : 'Unable to delete user.';
      }
    }
  });

  document.getElementById('report-year')?.addEventListener('change', (event) => {
    const target = event.currentTarget as HTMLSelectElement;
    const value = target.value ? Number(target.value) : undefined;
    state.reportFilters = { ...state.reportFilters, year: value };
    renderDashboard();
  });

  document.getElementById('report-month')?.addEventListener('change', (event) => {
    const target = event.currentTarget as HTMLSelectElement;
    const value = target.value ? Number(target.value) : undefined;
    state.reportFilters = { ...state.reportFilters, month: value };
    renderDashboard();
  });

  document.getElementById('clear-sms-filter')?.addEventListener('click', () => {
    state.reportFilters = {};
    renderDashboard();
  });

  document.getElementById('export-sms-csv')?.addEventListener('click', () => {
    const rows = filterSmsLogs(state.sms, state.reportFilters).map((item) => ({
      id: item.id,
      to: item.to,
      message: item.message,
      status: item.status,
      createdAt: item.createdAt ?? '',
    }));

    const csv = exportSmsLogsCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const filename = state.reportFilters.year
      ? `sms-logs-${state.reportFilters.year}${state.reportFilters.month ? `-${String(state.reportFilters.month).padStart(2, '0')}` : ''}.csv`
      : 'sms-logs.csv';
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  });
}
