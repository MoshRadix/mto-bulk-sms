import { apiClient, getValidContactCount, root, state, type Contact, type SmsCursor, type SmsItem, type SmsPage } from './app';
import { isValidMvMobile, normalizeMvNumber, parseMvMobileList } from './shared/phone';
import { countSmsCharacters, createSmsExcerpt, SMS_MESSAGE_LIMIT, truncateSmsMessage } from './shared/sms';
import { exportContactsCsv, exportSmsLogsCsv, filterSmsLogs, parseContactsCsv } from './shared/reporting';
import { clearSmsHistoryPagesAfter, getStoredSmsHistoryPage, saveSmsHistoryPage, type StoredSmsHistoryPage } from './shared/smsHistory';
import { deleteLocalSmsTemplate, listLocalSmsTemplates, saveLocalSmsTemplate, type LocalSmsTemplate } from './shared/smsTemplates';
import { notifyStatus } from './shared/notifications';
import { bindSettingsTabs, attachSettingsHandlers } from './settings';
import { renderIcons } from './shared/icons';
import packageInfo from '../package.json';

const SMS_PAGE_SIZE = 10;
const SMS_HISTORY_PAGE_SIZE = 20;
let localSmsTemplates: LocalSmsTemplate[] = [];
let localSmsTemplatesUserId = '';
let templatesLoadingUserId = '';
let templatesLoadError: string | null = null;
let templatesLoadToken = 0;
let editingLocalSmsTemplateId: string | null = null;

type UniqueContactRow = { contact: Contact; contactIds: string[]; groupNames: string[] };

function getUniqueContactRows(contacts: Contact[]): UniqueContactRow[] {
  const rows = new Map<string, UniqueContactRow>();
  for (const contact of contacts) {
    const mobile = normalizeMvNumber(contact.mobile);
    const row = rows.get(mobile) ?? { contact, contactIds: [], groupNames: [] };
    if (!rows.has(mobile)) rows.set(mobile, row);
    if (!row.contactIds.includes(contact.id)) row.contactIds.push(contact.id);
    if (contact.groupName && !row.groupNames.includes(contact.groupName)) row.groupNames.push(contact.groupName);
  }
  return Array.from(rows.values());
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
    }
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.append(textArea);
  textArea.focus();
  textArea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    textArea.remove();
  }
  if (!copied) throw new Error('Clipboard access is unavailable.');
}

export async function loadDashboardData() {
  const appApi = apiClient();
  state.view = 'dashboard';
  if (!appApi) {
    state.contacts = [];
    state.groups = [];
    state.sms = [];
    state.smsCursor = null;
    state.smsHasMore = false;
    state.queuedSmsCount = 0;
    state.sentSmsCount = 0;
    state.smsReport = [];
    state.smsReportLoaded = true;
    state.smsReportError = null;
    state.status = 'Live database access is available only when the Electron app is running.';
    notifyStatus(null, state.status);
    renderDashboard();
    return;
  }

  try {
    const [contacts, groups, smsPage, users] = await Promise.all([
      appApi.invoke('contacts:list') as Promise<Array<{ id: string; name: string; mobile: string; department: string; groupId?: string; groupName?: string }>>,
      appApi.invoke('groups:list') as Promise<Array<{ id: string; name: string; description: string; memberCount: number }>>,
      appApi.invoke('sms:list', { limit: SMS_PAGE_SIZE }) as Promise<SmsPage>,
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
    state.sms = smsPage.items;
    state.smsCursor = smsPage.nextCursor;
    state.smsHasMore = smsPage.hasMore;
    state.queuedSmsCount = smsPage.queuedCount ?? 0;
    state.sentSmsCount = smsPage.sentCount ?? 0;
    state.smsReport = [];
    state.smsReportLoaded = false;
    state.smsReportError = null;
    state.users = users.map((item) => ({ id: item.id, username: item.username, name: item.name, email: item.email, role: item.role, active: item.active }));
    state.status = 'Connected to database-backed data.';
  } catch (error) {
    state.contacts = [];
    state.groups = [];
    state.sms = [];
    state.smsCursor = null;
    state.smsHasMore = false;
    state.queuedSmsCount = 0;
    state.sentSmsCount = 0;
    state.smsReport = [];
    state.smsReportLoaded = false;
    state.smsReportError = null;
    state.users = [];
    state.status = error instanceof Error ? error.message : 'Unable to connect to the database-backed app services.';
    notifyStatus(null, state.status, 'error');
  }

  renderDashboard();
}

async function loadSmsReport() {
  const appApi = apiClient();
  if (!appApi) {
    state.smsReport = [];
    state.smsReportLoaded = true;
    return;
  }

  const reportItems: SmsItem[] = [];
  let cursor: SmsCursor | null = null;
  do {
    const page = await appApi.invoke('sms:list', {
      limit: 50,
      ...(cursor ? { cursor } : {}),
    }) as SmsPage;
    reportItems.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  state.smsReport = reportItems;
  state.smsReportLoaded = true;
}

async function loadSmsHistoryPage(page: number, refresh = false) {
  if (!state.user || state.smsHistoryLoading) return;

  const userId = state.user.id;
  const appApi = apiClient();
  state.smsHistoryLoading = true;
  state.smsHistoryError = null;

  try {
    const cachedPage = await getStoredSmsHistoryPage(userId, page);
    let historyPage: StoredSmsHistoryPage | null = refresh ? null : cachedPage;

    if (!historyPage && appApi) {
      let cursor: SmsCursor | null = null;
      if (page > 0) {
        const previousPage = await getStoredSmsHistoryPage(userId, page - 1);
        if (!previousPage?.nextCursor) throw new Error('Load the previous history page first.');
        cursor = previousPage.nextCursor;
      }

      const result = await appApi.invoke('sms:list', {
        limit: SMS_HISTORY_PAGE_SIZE,
        ownOnly: true,
        sentOnly: true,
        ...(cursor ? { cursor } : {}),
      }) as SmsPage;
      historyPage = {
        userId,
        page,
        items: result.items,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      };
      if (page === 0) await clearSmsHistoryPagesAfter(userId, 0);
      await saveSmsHistoryPage(historyPage);
      state.smsHistoryStatus = 'Sent history saved on this computer for this account.';
    } else if (!historyPage) {
      state.smsHistoryStatus = 'No sent messages are saved on this computer yet.';
    } else {
      state.smsHistoryStatus = 'Showing sent history saved on this computer.';
    }

    state.smsHistoryItems = historyPage?.items ?? [];
    state.smsHistoryPage = page;
    state.smsHistoryHasMore = historyPage?.hasMore ?? false;
    state.smsHistoryNextCursor = historyPage?.nextCursor ?? null;
    state.smsHistoryLoaded = true;
  } catch (error) {
    const cachedPage = await getStoredSmsHistoryPage(userId, page).catch(() => null);
    if (cachedPage) {
      state.smsHistoryItems = cachedPage.items;
      state.smsHistoryPage = page;
      state.smsHistoryHasMore = cachedPage.hasMore;
      state.smsHistoryNextCursor = cachedPage.nextCursor;
      state.smsHistoryLoaded = true;
      state.smsHistoryStatus = 'Showing locally saved history; it could not be refreshed.';
    } else {
      state.smsHistoryError = error instanceof Error ? error.message : 'Unable to load sent history.';
      state.smsHistoryItems = [];
      state.smsHistoryPage = page;
      state.smsHistoryHasMore = false;
      state.smsHistoryNextCursor = null;
    }
  } finally {
    state.smsHistoryLoading = false;
    renderDashboard();
    const refreshedStatus = document.getElementById('sms-history-status');
    if (state.smsHistoryError) notifyStatus(refreshedStatus, state.smsHistoryError, 'error');
  }
}

async function loadLocalTemplates(userId: string) {
  if (localSmsTemplatesUserId === userId || templatesLoadingUserId === userId) return;
  const loadToken = ++templatesLoadToken;
  templatesLoadingUserId = userId;
  templatesLoadError = null;
  renderDashboard();
  try {
    const templates = await listLocalSmsTemplates(userId);
    if (loadToken !== templatesLoadToken) return;
    localSmsTemplates = templates;
    localSmsTemplatesUserId = userId;
  } catch (error) {
    if (loadToken !== templatesLoadToken) return;
    templatesLoadError = error instanceof Error ? error.message : 'Unable to load local SMS templates.';
  } finally {
    if (loadToken === templatesLoadToken) {
      templatesLoadingUserId = '';
      if (state.user?.id === userId) renderDashboard();
    }
  }
}

function bindMainNavigation() {
  document.querySelectorAll('.nav-tab').forEach((button) => {
    button.addEventListener('click', () => {
      const selectedSection = button.getAttribute('data-section');
      if (!selectedSection) return;
      state.activeSection = selectedSection as typeof state.activeSection;

      document.querySelectorAll('.nav-tab').forEach((tab) => {
        const isActive = tab === button;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-current', isActive ? 'page' : 'false');
      });

      document.querySelectorAll('.section').forEach((pane) => {
        const isActive = pane.getAttribute('data-section-panel') === selectedSection;
        pane.classList.toggle('active', isActive);
      });

      if (selectedSection === 'admin' && !state.smsReportLoaded && !state.smsReportLoading) {
        state.smsReportLoading = true;
        state.smsReportError = null;
        const reportList = document.getElementById('sms-report-list');
        if (reportList) reportList.innerHTML = '<li><span class="muted">Loading report data...</span></li>';
        void loadSmsReport()
          .catch((error: unknown) => {
            state.smsReportError = error instanceof Error ? error.message : 'Unable to load SMS report data.';
            notifyStatus(null, state.smsReportError, 'error');
          })
          .finally(() => {
            state.smsReportLoading = false;
            renderDashboard();
          });
      }

      if (selectedSection === 'history') void loadSmsHistoryPage(0, true);
      if (selectedSection === 'templates' && state.user) void loadLocalTemplates(state.user.id);
    });
  });
}

export function renderDashboard() {
  if (!state.user) return;

  const currentDate = new Date();
  const localDateIso = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
  const currentDateLabel = currentDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const isAdministrator = state.user.role === 'administrator';
  const isCreatingGroup = isAdministrator && state.groupEditorMode === 'new';
  const uniqueContacts = getUniqueContactRows(state.contacts);
  const stats = [
    { label: 'Unique contacts', value: String(uniqueContacts.length) },
    { label: 'Groups', value: String(state.groups.length) },
    { label: 'Queued SMS', value: String(state.queuedSmsCount) },
    { label: 'Valid numbers', value: String(getValidContactCount()) },
    { label: 'YOUR SMS SCORE', value: String(state.sentSmsCount) },
  ];

  const groupsOptions = state.groups.length
    ? state.groups
        .map((group) => `<option value="${group.id}">${group.name} (${group.memberCount})</option>`)
        .join('')
    : '<option value="">No groups yet</option>';
  const editingGroup = state.groups.find((group) => group.id === state.groupEditorId);
  const currentGroupMembers = state.contacts.filter((contact) => contact.groupId === state.groupEditorId);
  const currentGroupNumbers = new Set(currentGroupMembers.map((contact) => contact.mobile));
  const availableGroupContacts = state.contacts.filter((contact) => contact.groupId !== state.groupEditorId && !currentGroupNumbers.has(contact.mobile));

  const adminNav = state.user?.role === 'administrator'
    ? `<button type="button" class="nav-tab ${state.activeSection === 'admin' ? 'active' : ''}" data-section="admin" aria-current="${state.activeSection === 'admin' ? 'page' : 'false'}"><i data-lucide="shield-check"></i>Admin</button>`
    : '';
  const historyNav = `<button type="button" class="nav-tab ${state.activeSection === 'history' ? 'active' : ''}" data-section="history" aria-current="${state.activeSection === 'history' ? 'page' : 'false'}"><i data-lucide="history"></i>History</button>`;
  const templatesNav = `<button type="button" class="nav-tab ${state.activeSection === 'templates' ? 'active' : ''}" data-section="templates" aria-current="${state.activeSection === 'templates' ? 'page' : 'false'}"><i data-lucide="file-text"></i>Templates</button>`;

  const years = Array.from(new Set(
    state.smsReport
      .map((item) => (item.createdAt ? new Date(item.createdAt).getFullYear() : null))
      .filter((value): value is number => Number.isFinite(value)),
  )).sort((a, b) => b - a);

  const selectedYear = state.reportFilters.year ?? '';
  const selectedMonth = state.reportFilters.month ?? '';
  const reportRows = filterSmsLogs(state.smsReport, state.reportFilters);
  const yearOptions = years.length
    ? years.map((year) => `<option value="${year}" ${selectedYear === year ? 'selected' : ''}>${year}</option>`).join('')
    : '<option value="">No logs</option>';

  const monthLabels = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthOptions = monthLabels
    .map((label, index) => `<option value="${index + 1}" ${selectedMonth === String(index + 1) ? 'selected' : ''}>${label}</option>`)
    .join('');

  const formatSmsTimestamp = (value?: string | null) => {
    if (!value) return 'Date/time unavailable';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Date/time unavailable';
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };

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
                <button type="button" class="link-action" data-user-action="edit" data-user-id="${user.id}"><i data-lucide="pencil"></i>Edit</button>
                <button type="button" class="link-action danger" data-user-action="delete" data-user-id="${user.id}"><i data-lucide="trash-2"></i>Delete</button>
              </div>
            </li>
          `,
        )
        .join('')
    : '<li><span class="muted">No users found.</span></li>';

  const reportRowsHtml = state.smsReportLoading
    ? '<li><span class="muted">Loading report data...</span></li>'
    : state.smsReportError
      ? '<li><span class="muted">Unable to load SMS report data. Reopen Admin to retry.</span></li>'
      : !state.smsReportLoaded
        ? '<li><span class="muted">Open the Admin panel to load report data.</span></li>'
        : reportRows.length
    ? reportRows
        .slice(0, 25)
        .map(
          (item) => `
            <li>
              <div>
                <strong>${item.groupName || item.to}</strong><br />
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

  const smsHistoryRowsHtml = state.smsHistoryLoading
    ? '<li class="sms-history-state"><i data-lucide="history"></i><strong>Loading sent history</strong><span class="muted">Your saved messages will appear here in a moment.</span></li>'
    : state.smsHistoryError
      ? `<li class="sms-history-state is-error"><i data-lucide="x"></i><strong>History could not be loaded</strong><span class="muted">${escapeHtml(state.smsHistoryError)}</span></li>`
      : state.smsHistoryItems.length
        ? state.smsHistoryItems.map((item) => `
            <li class="sms-history-row">
              <div class="sms-history-content">
                <div class="sms-history-meta">
                  <strong>${escapeHtml(item.groupName || item.to)}</strong>
                  <span class="pill history-status-pill ${item.status === 'failed' ? 'danger' : ''}">${escapeHtml(item.status)}</span>
                  <time class="muted" datetime="${escapeHtml(item.createdAt ?? '')}">${formatSmsTimestamp(item.createdAt)}</time>
                </div>
                <p class="sms-history-message">${escapeHtml(item.message)}</p>
              </div>
              <button type="button" class="secondary sms-history-copy" data-copy-sms-id="${escapeHtml(item.id)}" title="Copy message" aria-label="Copy message sent to ${escapeHtml(item.groupName || item.to)}"><i data-lucide="copy"></i></button>
            </li>
          `).join('')
        : '<li class="sms-history-state"><i data-lucide="history"></i><strong>No sent messages yet</strong><span class="muted">Messages sent from this account will appear here.</span></li>';

  const userTemplates = localSmsTemplatesUserId === state.user.id ? localSmsTemplates : [];
  const isLoadingTemplates = templatesLoadingUserId === state.user.id;
  const templatesRowsHtml = isLoadingTemplates
    ? '<li class="template-state"><strong>Loading templates</strong><span class="muted">Opening your local template library...</span></li>'
    : templatesLoadError
      ? `<li class="template-state is-error"><strong>Templates could not be loaded</strong><span class="muted">${escapeHtml(templatesLoadError)}</span></li>`
      : userTemplates.length
        ? userTemplates.map((template) => `
            <li class="template-row" data-template-search="${escapeHtml(`${template.title} ${template.message}`.toLocaleLowerCase())}">
              <div class="template-row-heading">
                <div class="template-title-block">
                  <h3>${escapeHtml(template.title)}</h3>
                  <span class="muted">${countSmsCharacters(template.message).toLocaleString()} / ${SMS_MESSAGE_LIMIT.toLocaleString()} characters</span>
                </div>
                <div class="template-actions">
                  <button type="button" class="secondary template-copy" data-template-action="copy" data-template-id="${escapeHtml(template.id)}" aria-label="Copy ${escapeHtml(template.title)} text"><i data-lucide="copy"></i>Copy text</button>
                  <button type="button" class="link-action" data-template-action="edit" data-template-id="${escapeHtml(template.id)}"><i data-lucide="pencil"></i>Edit</button>
                  <button type="button" class="link-action danger" data-template-action="delete" data-template-id="${escapeHtml(template.id)}"><i data-lucide="trash-2"></i>Delete</button>
                </div>
              </div>
              <p class="template-message">${escapeHtml(template.message)}</p>
            </li>
          `).join('')
        : '<li class="template-state"><i data-lucide="file-text"></i><strong>No templates saved</strong><span class="muted">Create a reusable message on the left. Your templates stay on this device.</span></li>';

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
        font-family: "Segoe UI", sans-serif;
        background:
          linear-gradient(rgba(148, 163, 184, 0.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(148, 163, 184, 0.025) 1px, transparent 1px),
          linear-gradient(135deg, var(--bg), var(--bg-strong));
        background-size: 32px 32px, 32px 32px, auto;
        color: var(--text);
      }
      .app { min-height: 100vh; padding: 24px; }
      .app-shell {
        max-width: 1500px;
        margin: 0 auto;
        display: grid;
        grid-template-columns: 240px minmax(0, 1fr);
        gap: 20px;
        min-width: 0;
      }
      .sidebar {
        position: sticky;
        top: 24px;
        align-self: start;
        min-height: calc(100vh - 48px);
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
        width: 48px;
        height: 48px;
        border-radius: 12px;
        display: grid;
        place-items: center;
        flex: 0 0 48px;
        overflow: hidden;
        border: 1px solid rgba(34, 211, 238, 0.24);
        background: #07131f;
      }
      .brand-badge img { display: block; width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
      .brand-title { font-size: 1rem; font-weight: 800; letter-spacing: 0.02em; }
      .brand-subtitle { margin-top: 3px; color: #8dded2; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; }
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
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 10px;
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
      .nav-tab[data-section="history"].active { background: linear-gradient(135deg, rgba(251,191,36,0.22), rgba(217,119,6,0.14)); color: #fef3c7; }
      .nav-tab[data-section="templates"].active { background: linear-gradient(135deg, rgba(34,211,238,0.2), rgba(20,184,166,0.2)); color: #cffafe; }
      .nav-tab[data-section="settings"].active { background: linear-gradient(135deg, rgba(139,92,246,0.28), rgba(124,58,237,0.18)); color: #ede9fe; }
      .sidebar-footer {
        margin-top: auto;
        padding-top: 12px;
        border-top: 1px solid var(--line);
      }
      .app-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 12px; padding: 10px 2px 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.68rem; font-variant-numeric: tabular-nums; }
      .app-meta-version { padding: 4px 7px; border: 1px solid rgba(45, 212, 191, 0.24); border-radius: 999px; color: #8dded2; font-weight: 700; white-space: nowrap; }
      .app-meta time { white-space: nowrap; }
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
        min-width: 0;
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
      .brand { margin: 0; font-size: 1.35rem; font-weight: 800; }
      .user-pill { color: var(--muted); font-size: 0.8rem; margin-top: 4px; }
      .ui-icon { display: inline-block; width: 18px; height: 18px; flex: 0 0 18px; stroke-width: 1.9; }
      .nav-tab .ui-icon { color: var(--cyan); }
      .status {
        background: rgba(52, 211, 153, 0.12);
        border: 1px solid rgba(52, 211, 153, 0.35);
        color: #bbf7d0;
        padding: 9px 12px;
        border-radius: 999px;
        font-size: 0.84rem;
        white-space: nowrap;
      }
      .stats-scroll { width: 100%; max-width: 100%; min-width: 0; overflow-x: auto; overscroll-behavior-inline: contain; scrollbar-color: rgba(34,211,238,0.45) rgba(148,163,184,0.08); }
      .stats-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; min-width: 900px; }
      .card {
        background: rgba(17, 24, 39, 0.9);
        border: 1px solid var(--line);
        border-radius: 16px;
        box-shadow: 0 12px 30px rgba(15,23,42,0.25);
      }
      .sms-composer {
        border: 1px solid transparent;
        background:
          linear-gradient(rgba(17, 24, 39, 0.96), rgba(17, 24, 39, 0.96)) padding-box,
          linear-gradient(125deg, #22d3ee, #3b82f6 58%, #22d3ee) border-box;
        box-shadow: 0 12px 30px rgba(15,23,42,0.25), 0 0 20px rgba(34,211,238,0.14);
      }
      .sms-composer:focus-within { box-shadow: 0 12px 30px rgba(15,23,42,0.25), 0 0 26px rgba(34,211,238,0.24); }
      .sms-message-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 0.76rem; }
      .sms-message-counter { flex: 0 0 auto; color: var(--muted); font-variant-numeric: tabular-nums; }
      .sms-message-counter.near-limit { color: var(--warning); }
      .sms-message-counter.at-limit { color: var(--danger); font-weight: 700; }
      .stat { position: relative; min-height: 136px; display: grid; align-content: center; justify-items: center; gap: 8px; overflow: hidden; padding: 20px 16px; background: linear-gradient(155deg, rgba(17, 24, 39, 0.98), rgba(15, 23, 42, 0.86)); text-align: center; }
      .stat::before { content: ''; position: absolute; top: 0; left: 22%; right: 22%; height: 3px; border-radius: 0 0 3px 3px; background: var(--stat-accent, var(--cyan)); }
      .stat:nth-child(1) { --stat-accent: #22d3ee; }
      .stat:nth-child(2) { --stat-accent: #2dd4bf; }
      .stat:nth-child(3) { --stat-accent: #fbbf24; }
      .stat:nth-child(4) { --stat-accent: #4ade80; }
      .stat:nth-child(5) { --stat-accent: #60a5fa; }
      .stat-label { display: grid; min-height: 2.4em; max-width: 100%; place-items: center; color: var(--muted); font-size: 0.72rem; font-weight: 700; line-height: 1.2; text-align: center; text-transform: uppercase; }
      .stat-value { color: var(--stat-accent, var(--text)); font-size: 2.1rem; font-variant-numeric: tabular-nums; font-weight: 800; line-height: 1; }
      .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; min-width: 0; }
      .dashboard-workspace { grid-template-columns: minmax(0, 1.08fr) minmax(320px, 0.92fr); align-items: start; gap: 16px; }
      .dashboard-workspace > .card { min-width: 0; }
      #sms-log-list { max-height: min(64vh, 620px); overflow-x: hidden; overflow-y: auto; padding-right: 8px; }
      .sms-log-message { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
      .sms-log-message strong, .sms-log-message .muted { overflow-wrap: anywhere; word-break: break-word; }
      .sms-log-excerpt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
      .sms-log-meta { display: flex; flex: 0 0 auto; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
      .history-page { margin-top: 20px; }
      .history-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 4px 0 22px; border-bottom: 1px solid var(--line); }
      .history-heading { min-width: 0; }
      .history-eyebrow { margin: 0 0 6px; color: var(--teal); font-size: 0.72rem; font-weight: 800; text-transform: uppercase; }
      .history-header h1 { margin: 0; font-size: 1.65rem; line-height: 1.2; }
      .history-header p.history-description { margin: 7px 0 0; }
      .history-refresh { width: auto; flex: 0 0 auto; }
      .history-status { min-height: 42px; display: flex; align-items: center; margin: 0; color: var(--muted); font-size: 0.84rem; }
      #sms-history-list { display: grid; gap: 10px; }
      .sms-history-row { align-items: flex-start; gap: 16px; padding: 16px; border: 1px solid var(--line); border-left: 3px solid rgba(34, 211, 238, 0.65); border-radius: 8px; background: rgba(17, 24, 39, 0.65); }
      .sms-history-content { flex: 1 1 auto; min-width: 0; }
      .sms-history-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
      .sms-history-meta strong { overflow-wrap: anywhere; }
      .sms-history-meta time { margin-left: auto; white-space: nowrap; font-size: 0.78rem; }
      .history-status-pill { padding: 4px 9px; text-transform: capitalize; }
      .sms-history-message { margin: 12px 0 0; padding: 10px 12px; border-left: 2px solid rgba(20, 184, 166, 0.55); border-radius: 0 6px 6px 0; background: rgba(2, 6, 23, 0.28); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; line-height: 1.55; }
      .sms-history-copy { width: 38px; height: 38px; padding: 0; flex: 0 0 38px; border: 1px solid var(--line); border-radius: 8px; background: rgba(148, 163, 184, 0.1); }
      .sms-history-copy:hover { background: rgba(34, 211, 238, 0.16); }
      .sms-history-state { min-height: 190px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 28px; border: 1px dashed var(--line); border-radius: 8px; text-align: center; }
      .sms-history-state .ui-icon { width: 24px; height: 24px; margin-bottom: 4px; color: var(--teal); }
      .sms-history-state strong { font-size: 0.98rem; }
      .sms-history-state .muted { max-width: 440px; font-size: 0.86rem; }
      .sms-history-state.is-error .ui-icon { color: var(--danger); }
      .sms-history-pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }
      .sms-history-pagination button { width: auto; }
      .templates-page { margin-top: 20px; }
      .templates-page-header { padding: 4px 0 18px; border-bottom: 1px solid var(--line); }
      .templates-page-header h1 { margin: 0; font-size: 1.65rem; }
      .templates-page-header p { margin: 6px 0 0; }
      .templates-eyebrow { margin: 0 0 5px !important; color: var(--teal); font-size: 0.7rem; font-weight: 800; text-transform: uppercase; }
      .templates-workspace { grid-template-columns: minmax(300px, 0.8fr) minmax(0, 1.2fr); align-items: start; gap: 16px; margin-top: 16px; }
      .template-editor { position: sticky; top: 16px; }
      .template-editor h2, .template-library h2 { margin-bottom: 6px; }
      .template-editor-intro { margin: 0 0 16px; font-size: 0.84rem; }
      #template-message { min-height: 180px; line-height: 1.55; }
      .template-form-actions button { flex: 1 1 130px; }
      .template-counter { display: flex; justify-content: space-between; gap: 8px; margin-top: 6px; font-size: 0.76rem; }
      .template-counter output { color: var(--muted); font-variant-numeric: tabular-nums; }
      .template-counter output.near-limit { color: var(--warning); }
      .template-counter output.at-limit { color: var(--danger); font-weight: 700; }
      .template-status { min-height: 1.4em; margin: 12px 0 0; color: var(--muted); font-size: 0.82rem; }
      .template-library-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
      .template-library-header h2 { margin: 0; }
      .template-count { color: var(--muted); font-size: 0.8rem; white-space: nowrap; }
      .template-search { margin-bottom: 12px; }
      .template-list { display: grid; gap: 10px; }
      .template-row { display: block; padding: 14px; border: 1px solid var(--line); border-left: 3px solid rgba(20, 184, 166, 0.65); border-radius: 8px; background: rgba(15, 23, 42, 0.58); }
      .template-row[hidden] { display: none; }
      .template-row-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
      .template-title-block { min-width: 0; }
      .template-title-block h3 { margin: 0 0 4px; overflow-wrap: anywhere; font-size: 0.98rem; }
      .template-title-block .muted { font-size: 0.74rem; }
      .template-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
      .template-actions button { width: auto; }
      .template-actions .template-copy { padding: 8px 10px; font-size: 0.82rem; }
      .template-message { margin: 12px 0 0; padding: 10px 12px; border-left: 2px solid rgba(34, 211, 238, 0.45); border-radius: 0 6px 6px 0; background: rgba(2, 6, 23, 0.3); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
      .template-state { min-height: 150px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; border: 1px dashed var(--line); border-radius: 8px; text-align: center; }
      .template-state .ui-icon { width: 24px; height: 24px; color: var(--teal); }
      .template-state .muted { max-width: 420px; font-size: 0.84rem; }
      .template-state.is-error .muted { color: #fecaca; }
      #template-no-results { display: none; }
      #template-no-results.visible { display: flex; }
      .panel { padding: 20px; }
      .layout > .card,
      .layout > .panel { width: 100%; }
      .contacts-workspace { grid-template-columns: minmax(300px, 0.8fr) minmax(0, 1.2fr); align-items: start; gap: 16px; }
      .contact-editor-panel { position: sticky; top: 16px; }
      .contact-panel-heading, .contact-list-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
      .contact-panel-heading h2, .contact-list-heading h2 { margin: 0; }
      .contact-eyebrow { margin: 0 0 5px; color: var(--teal); font-size: 0.7rem; font-weight: 800; text-transform: uppercase; }
      .contact-intro { margin: 6px 0 0; font-size: 0.84rem; }
      .contact-list-heading { align-items: center; }
      .contact-count { display: inline-grid; min-width: 28px; height: 28px; margin-left: 6px; padding: 0 7px; place-items: center; border: 1px solid var(--line); border-radius: 999px; color: var(--cyan); font-size: 0.78rem; vertical-align: 2px; }
      .contact-toolbar { display: grid; gap: 12px; margin-bottom: 14px; }
      .contact-toolbar-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .contact-toolbar-actions button { width: auto; padding: 9px 11px; font-size: 0.82rem; }
      .contact-search-wrap { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; }
      #contact-result-count { font-size: 0.78rem; white-space: nowrap; }
      .contact-list { display: grid; gap: 8px; }
      .contact-row { align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: rgba(15, 23, 42, 0.58); }
      .contact-row[hidden] { display: none; }
      .contact-identity { display: flex; align-items: center; gap: 11px; min-width: 0; }
      .contact-avatar { width: 38px; height: 38px; flex: 0 0 38px; display: grid; place-items: center; border: 1px solid rgba(20, 184, 166, 0.35); border-radius: 50%; background: rgba(20, 184, 166, 0.12); color: #99f6e4; font-weight: 800; }
      .contact-details { min-width: 0; }
      .contact-details strong { display: block; overflow-wrap: anywhere; }
      .contact-subtitle { display: block; margin-top: 3px; font-size: 0.78rem; overflow-wrap: anywhere; }
      .contact-row-actions { display: flex; align-items: center; justify-content: flex-end; flex: 0 0 auto; gap: 10px; }
      .contact-bulk-select { width: 16px; height: 16px; margin: 0; padding: 0; accent-color: var(--teal); }
      .contact-status { min-height: 1.4em; margin: 14px 0 0; color: var(--muted); font-size: 0.84rem; }
      .contact-import-status { min-height: 1.2em; margin: 10px 0 0; color: var(--muted); font-size: 0.8rem; }
      .contacts-empty { display: flex; min-height: 170px; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; border: 1px dashed var(--line); border-radius: 8px; text-align: center; }
      .contacts-empty[hidden] { display: none; }
      .contacts-empty .ui-icon { width: 24px; height: 24px; color: var(--teal); }
      .contacts-empty .muted { max-width: 380px; font-size: 0.84rem; }
      .groups-page-header { padding: 4px 0 18px; border-bottom: 1px solid var(--line); }
      .groups-page-header h1 { margin: 0; font-size: 1.65rem; }
      .groups-page-header p { margin: 6px 0 0; }
      .groups-eyebrow { color: var(--teal); font-size: 0.7rem; font-weight: 800; text-transform: uppercase; }
      .groups-status { min-height: 38px; display: flex; align-items: center; margin: 0; color: var(--muted); font-size: 0.84rem; }
      .groups-workspace { grid-template-columns: minmax(300px, 0.9fr) minmax(0, 1.1fr); align-items: start; gap: 16px; }
      .groups-left-column { display: grid; align-content: start; gap: 16px; min-width: 0; }
      .group-form-heading, .group-panel-heading, .group-directory-heading, .group-picker-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .group-form-heading { margin-bottom: 18px; }
      .group-form-heading h2, .group-panel-heading h2, .group-directory-heading h2 { margin: 0; }
      .group-form-heading p, .group-directory-heading p { margin: 5px 0 0; font-size: 0.82rem; }
      .group-form-heading .group-eyebrow, .group-panel-heading .group-eyebrow, .group-directory-heading .group-eyebrow { margin: 0 0 5px; color: var(--teal); font-size: 0.7rem; font-weight: 800; text-transform: uppercase; }
      .group-form-heading button { width: auto; flex: 0 0 auto; }
      .group-form-actions button { flex: 1 1 130px; }
      .group-panel-heading { align-items: flex-start; margin-bottom: 16px; }
      .group-count { color: var(--muted); font-size: 0.8rem; white-space: nowrap; }
      .group-selector { margin-bottom: 18px; }
      .group-member-section { padding-top: 16px; border-top: 1px solid var(--line); }
      .group-member-section h3 { margin: 0 0 8px; font-size: 0.92rem; }
      .group-member-list, .group-directory-list { display: grid; gap: 7px; }
      .group-member-row, .group-directory-row { gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: rgba(15, 23, 42, 0.58); }
      .group-member-details, .group-directory-details { min-width: 0; overflow-wrap: anywhere; }
      .group-member-details .muted, .group-directory-details .muted { display: block; margin-top: 3px; font-size: 0.78rem; }
      .group-directory-row[hidden] { display: none; }
      .group-directory-heading { margin-bottom: 14px; }
      .group-directory-search { margin-bottom: 12px; }
      .group-row-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; }
      .group-member-count { min-width: 76px; color: var(--muted); font-size: 0.78rem; text-align: right; }
      .group-member-picker-section { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
      .group-picker-heading { align-items: flex-end; margin-bottom: 8px; }
      .group-picker-heading label { margin: 0; }
      .group-picker-heading button { width: auto; padding: 5px 0; border: 0; background: transparent; color: #99f6e4; font-size: 0.78rem; }
      .group-picker-search { margin-bottom: 8px; }
      .group-member-results { min-height: 1.2em; margin: 0 0 8px; color: var(--muted); font-size: 0.76rem; }
      .member-picker { max-height: 280px; overflow-y: auto; display: grid; gap: 3px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: rgba(2, 6, 23, 0.22); }
      .member-option { display: flex; align-items: center; gap: 10px; margin: 0; padding: 9px; border-radius: 6px; color: var(--text); cursor: pointer; }
      .member-option:hover { background: rgba(148,163,184,0.1); }
      .member-option[hidden] { display: none; }
      .member-option input[type='checkbox'] { flex: 0 0 16px; width: 16px; height: 16px; margin: 0; padding: 0; accent-color: var(--success); }
      .member-option span { display: grid; gap: 2px; min-width: 0; }
      .member-option small { color: var(--muted); font-size: 0.74rem; }
      .group-member-empty { padding: 18px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); font-size: 0.84rem; text-align: center; }
      .group-member-empty[hidden] { display: none; }
      .group-empty-state { padding: 22px 16px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); font-size: 0.84rem; text-align: center; }
      .group-empty-state strong { display: block; margin-bottom: 5px; color: var(--text); }
      .group-empty-state[hidden] { display: none; }
      .groups-workspace + .groups-empty-state { margin-top: 16px; }
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
      input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
      textarea { min-height: 110px; resize: vertical; }
      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        cursor: pointer;
        background: linear-gradient(135deg, var(--primary), var(--primary-strong));
        border: none;
        font-weight: 700;
        color: white;
        transition: filter 0.15s ease, transform 0.15s ease;
      }
      button:hover { filter: brightness(1.08); }
      button:active { transform: translateY(1px); }
      button:disabled { cursor: not-allowed; opacity: 0.55; filter: saturate(0.6); transform: none; }
      .secondary {
        background: linear-gradient(135deg, #374151, #4b5563);
        color: var(--text);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .link-action {
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        gap: 6px;
        width: auto;
        padding: 4px 2px;
        border: 0;
        border-radius: 0;
        background: none;
        color: #93c5fd;
        font-size: 0.82rem;
        font-weight: 650;
        text-align: left;
        text-decoration: none;
      }
      .link-action:hover { filter: none; color: #bfdbfe; text-decoration: underline; text-underline-offset: 3px; }
      .link-action:focus-visible { outline: 2px solid #60a5fa; outline-offset: 3px; }
      .link-action.danger { background: none; color: #fca5a5; }
      .link-action.danger:hover { filter: none; color: #fecaca; }
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
      .actions button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; flex: 1; }
      .section { display: none; min-width: 0; }
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
        .app-shell { grid-template-columns: minmax(0, 1fr); }
        .sidebar { position: static; align-self: stretch; min-height: 0; padding: 14px; }
        .nav { grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); }
      }
      @media (max-width: 820px) {
        .app { padding: 16px; }
        .layout { grid-template-columns: minmax(0, 1fr); }
        .contact-editor-panel { position: static; }
        .template-editor { position: static; }
        .template-row-heading { flex-direction: column; }
        .template-actions { justify-content: flex-start; }
        .groups-workspace { grid-template-columns: minmax(0, 1fr); }
        .group-row-actions { flex-wrap: wrap; }
        .row { grid-template-columns: 1fr; }
        .topbar { flex-direction: column; align-items: flex-start; gap: 12px; }
      }
      @media (max-width: 600px) {
        .history-header { align-items: flex-start; flex-direction: column; gap: 12px; }
        .history-refresh { align-self: flex-start; }
        .sms-history-row { gap: 12px; padding: 12px; }
        .sms-history-meta time { flex-basis: 100%; margin-left: 0; }
        .sms-history-pagination { gap: 8px; }
        .sms-history-pagination button { padding: 9px 10px; }
        .contact-search-wrap { grid-template-columns: minmax(0, 1fr); }
        .contact-row { align-items: flex-start; flex-direction: column; }
        .contact-row-actions { width: 100%; justify-content: flex-start; flex-wrap: wrap; gap: 8px; }
      }
      @media (max-width: 480px) {
        .app { padding: 10px; }
        .sidebar { padding: 12px; gap: 12px; }
        .topbar, .panel { padding: 14px; }
        .status { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
        .nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .nav-tab { padding: 10px; }
        .stat { padding: 14px; }
        .stats-grid { gap: 10px; }
        .sms-history-row { gap: 8px; }
        .sms-history-copy { padding: 8px; }
        .sms-history-copy .ui-icon { width: 16px; height: 16px; flex-basis: 16px; }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
      }
    </style>

    <div class="app">
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand-block">
            <div class="brand-badge"><img src="../assets/addu-city-icon.png" alt="" /></div>
            <div>
              <div class="brand-title">MTO SMS</div>
              <div class="brand-subtitle">City of Addu</div>
            </div>
          </div>

          <div class="sidebar-label">Workspace</div>
          <nav class="nav" aria-label="Workspace">
            <button type="button" class="nav-tab ${state.activeSection === 'dashboard' ? 'active' : ''}" data-section="dashboard" aria-current="${state.activeSection === 'dashboard' ? 'page' : 'false'}"><i data-lucide="layout-dashboard"></i>Dashboard</button>
            <button type="button" class="nav-tab ${state.activeSection === 'contacts' ? 'active' : ''}" data-section="contacts" aria-current="${state.activeSection === 'contacts' ? 'page' : 'false'}"><i data-lucide="contact"></i>Contacts</button>
            <button type="button" class="nav-tab ${state.activeSection === 'groups' ? 'active' : ''}" data-section="groups" aria-current="${state.activeSection === 'groups' ? 'page' : 'false'}"><i data-lucide="users-round"></i>Groups</button>
            ${historyNav}
            ${templatesNav}
            ${adminNav}
            <button type="button" class="nav-tab ${state.activeSection === 'settings' ? 'active' : ''}" data-section="settings" aria-current="${state.activeSection === 'settings' ? 'page' : 'false'}"><i data-lucide="settings"></i>Settings</button>
          </nav>

          <div class="sidebar-footer">
            <div class="mini-card">
              <div class="mini-label">Account</div>
              <div style="margin-top: 8px; font-weight: 700;">${state.user.name}</div>
              <div class="muted" style="margin-top: 4px;">${state.user.role}</div>
            </div>
            <div class="app-meta" aria-label="Application information">
              <span class="app-meta-version">v${packageInfo.version}</span>
              <time datetime="${localDateIso}">${currentDateLabel}</time>
            </div>
          </div>
        </aside>

        <main class="content">
          <!--
          <div class="topbar">
            <div>
              <h1 class="brand">MTO Bulk SMS Manager</h1>
              <div class="user-pill">Signed in as ${state.user.name} (${state.user.role})</div>
            </div>
            <div class="status">${state.status}</div>
          </div>
          -->

      <div class="section ${state.activeSection === 'dashboard' ? 'active' : ''}" data-section-panel="dashboard">
        <div class="stats-scroll">
        <div class="stats-grid">
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
          </div>

        <div class="layout dashboard-workspace" style="margin-top: 20px;">
          <div class="card panel sms-composer">
            <h2>SMS composer</h2>
            <form id="sms-form" class="stack">
              <div>
                <label for="sms-recipient-numbers">Recipient numbers</label>
                <input id="sms-recipient-numbers" name="to" inputmode="tel" placeholder="9607712345, 9609912345" />
              </div>
              <div>
                <label for="sms-group">Send to group</label>
                <select id="sms-group" name="groupId">
                  <option value="">Direct number</option>
                  ${groupsOptions}
                </select>
              </div>
              <div>
                <label for="sms-message">Message</label>
                <textarea id="sms-message" name="message" aria-describedby="sms-message-help sms-message-counter" placeholder="Type the message to send..." required></textarea>
                <div class="sms-message-meta">
                  <span id="sms-message-help" class="muted">1,530 characters maximum; spaces count.</span>
                  <output id="sms-message-counter" class="sms-message-counter" aria-live="polite" aria-atomic="true">0 / 1,530</output>
                </div>
              </div>
              <div class="actions">
                <button type="submit" style="background: linear-gradient(135deg, #22c55e, #16a34a); color: #f0fdf4;"><i data-lucide="send-horizontal"></i>Queue SMS</button>
                <button type="button" class="secondary" id="send-sms" style="background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff7ed;"><i data-lucide="send"></i>Send queued</button>
              </div>
            </form>
            <p class="muted" id="sms-status" role="status" aria-live="polite">Enter one number or comma-separated numbers, or select a group.</p>
          </div>

          <div class="card panel">
            <h2>Outgoing SMS log</h2>
            <ul id="sms-log-list">
              ${state.sms.length
                ? state.sms
                    .map(
                      (item) => `
                        <li>
                          <div class="sms-log-message">
                            <strong>${item.groupName || item.to}</strong><br />
                            <span class="muted sms-log-excerpt">${createSmsExcerpt(item.message)}</span>
                          </div>
                          <div class="sms-log-meta">
                            <span class="pill ${item.status === 'delivered' ? '' : 'danger'}">${item.status}</span>
                            <span class="muted" style="font-size: 0.72rem; white-space: nowrap;">${formatSmsTimestamp(item.createdAt)}</span>
                          </div>
                        </li>
                      `,
                    )
                    .join('')
                : '<li><span class="muted">No SMS jobs queued.</span></li>'}
            </ul>
            ${state.smsHasMore ? '<button type="button" class="secondary" id="load-more-sms" style="margin-top: 12px;"><i data-lucide="chevron-down"></i>Load 10 more</button>' : ''}
          </div>
        </div>
      </div>

      <div class="section ${state.activeSection === 'history' ? 'active' : ''}" data-section-panel="history">
        <div class="history-page">
          <div class="history-header">
            <div class="history-heading">
              <p class="history-eyebrow">Message archive</p>
              <h1>Sent history</h1>
              <p class="muted history-description">Review messages saved on this computer for ${escapeHtml(state.user.username)}.</p>
            </div>
            <button type="button" class="secondary history-refresh" id="refresh-sms-history" ${state.smsHistoryLoading ? 'disabled' : ''}><i data-lucide="refresh-cw"></i>Refresh</button>
          </div>
          <p class="history-status" id="sms-history-status" role="status" aria-live="polite">${escapeHtml(state.smsHistoryStatus)}</p>
          <ul id="sms-history-list">${smsHistoryRowsHtml}</ul>
          <div class="sms-history-pagination">
            <button type="button" class="secondary" id="sms-history-previous" ${state.smsHistoryPage <= 0 || state.smsHistoryLoading ? 'disabled' : ''}><i data-lucide="chevron-left"></i>Previous</button>
            <span class="muted">Page ${state.smsHistoryPage + 1}</span>
            <button type="button" class="secondary" id="sms-history-next" ${!state.smsHistoryHasMore || state.smsHistoryLoading ? 'disabled' : ''}>Next<i data-lucide="chevron-right"></i></button>
          </div>
        </div>
      </div>

      <div class="section ${state.activeSection === 'templates' ? 'active' : ''}" data-section-panel="templates">
        <div class="templates-page">
          <header class="templates-page-header">
            <p class="templates-eyebrow">Saved on this device for ${escapeHtml(state.user.username)}</p>
            <h1>SMS templates</h1>
            <p class="muted">Keep frequently used messages ready to edit and copy. Each message is limited to ${SMS_MESSAGE_LIMIT.toLocaleString()} characters.</p>
          </header>
          <p id="templates-status" class="template-status" role="status" aria-live="polite"></p>
          <div class="layout templates-workspace">
            <section class="card panel template-editor">
              <h2 id="template-form-heading">Create a template</h2>
              <p class="muted template-editor-intro">Templates are stored locally and are only available to this account on this device.</p>
              <form id="template-form" class="stack">
                <div>
                  <label for="template-title">Template name</label>
                  <input id="template-title" name="title" maxlength="80" placeholder="e.g. Meeting reminder" autocomplete="off" required />
                </div>
                <div>
                  <label for="template-message">Message text</label>
                  <textarea id="template-message" name="message" placeholder="Write your reusable SMS message..." aria-describedby="template-character-help template-character-count" required></textarea>
                  <div class="template-counter">
                    <span id="template-character-help" class="muted">Maximum ${SMS_MESSAGE_LIMIT.toLocaleString()} characters</span>
                    <output id="template-character-count" aria-live="polite" aria-atomic="true">0 / ${SMS_MESSAGE_LIMIT.toLocaleString()}</output>
                  </div>
                </div>
                <div class="actions template-form-actions">
                  <button type="submit" id="template-save-button"><i data-lucide="check"></i><span id="template-save-label">Save template</span></button>
                  <button type="button" class="secondary" id="template-reset-button"><i data-lucide="x"></i><span id="template-reset-label">Clear</span></button>
                </div>
              </form>
            </section>
            <section class="card panel template-library">
              <div class="template-library-header">
                <h2>Saved templates</h2>
                <span id="template-count" class="template-count">${userTemplates.length} template${userTemplates.length === 1 ? '' : 's'}</span>
              </div>
              <input id="template-search" class="template-search" type="search" placeholder="Search templates" aria-label="Search saved templates" />
              <ul id="template-list" class="template-list">${templatesRowsHtml}</ul>
              <div id="template-no-results" class="template-state"><strong>No matching templates</strong><span class="muted">Try a different name or phrase.</span></div>
            </section>
          </div>
        </div>
      </div>

      <div class="section ${state.activeSection === 'contacts' ? 'active' : ''}" data-section-panel="contacts">
        <div class="layout contacts-workspace" style="margin-top: 20px;">
          <div class="card panel contact-editor-panel">
            <div class="contact-panel-heading">
              <div>
                <p class="contact-eyebrow">Contact details</p>
                <h2 id="contact-form-heading">Add a contact</h2>
                <p class="muted contact-intro">Add a person and assign them to a group.</p>
              </div>
            </div>
            <form id="contact-form" class="stack">
              <input type="hidden" name="contactId" />
              <div>
                <label for="contact-name">Full name</label>
                <input id="contact-name" name="name" autocomplete="name" placeholder="e.g. Aisha Mohamed" required />
              </div>
              <div>
                <label for="contact-mobile">Mobile number</label>
                <input id="contact-mobile" name="mobile" type="tel" autocomplete="tel" inputmode="tel" placeholder="9607712345" aria-describedby="contact-mobile-help" required />
                <small id="contact-mobile-help" class="muted">Enter a Maldives mobile number.</small>
              </div>
              <div class="row">
                <div>
                  <label for="contact-department">Department</label>
                  <input id="contact-department" name="department" autocomplete="organization" placeholder="Optional" />
                </div>
                <div>
                  <label for="contact-designation">Designation</label>
                  <input id="contact-designation" name="designation" placeholder="Role or title" />
                </div>
              </div>
              <div>
                <label for="contact-group">Group</label>
                <select id="contact-group" name="groupId" required>
                  <option value="">Choose a group</option>
                  ${state.groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('')}
                </select>
              </div>
              <div>
                <label for="contact-notes">Notes <span class="muted">(optional)</span></label>
                <textarea id="contact-notes" name="notes" placeholder="Additional details"></textarea>
              </div>
              <div class="actions contact-form-actions">
                <button type="submit" id="contact-submit-button"><i data-lucide="user-plus"></i><span id="contact-submit-label">Add contact</span></button>
                <button type="button" class="secondary" id="reset-contact-form"><i data-lucide="x"></i><span id="contact-reset-label">Clear</span></button>
              </div>
              <p class="contact-status" id="contacts-status" role="status" aria-live="polite"></p>
            </form>
          </div>

          <div class="card panel contact-list-panel">
            <div class="contact-list-heading">
              <div>
                <p class="contact-eyebrow">Directory</p>
                <h2>Contacts <span class="contact-count" id="contacts-total">${uniqueContacts.length}</span></h2>
              </div>
            </div>
            <div class="contact-toolbar">
              <div class="contact-toolbar-actions">
                <button type="button" class="secondary" id="import-contacts-csv"><i data-lucide="upload"></i>Import CSV</button>
                <button type="button" class="secondary" id="export-contacts-csv"><i data-lucide="download"></i>Export CSV</button>
                ${state.user?.role === 'administrator' ? '<button type="button" class="secondary" id="bulk-delete-contacts" disabled><i data-lucide="trash-2"></i><span id="bulk-delete-label">Delete selected</span></button>' : ''}
              </div>
              <div class="contact-search-wrap">
                <input id="contact-search" type="search" placeholder="Search name, number, department, or group" aria-label="Search contacts" />
                <span class="muted" id="contact-result-count">Showing ${uniqueContacts.length} of ${uniqueContacts.length} contacts</span>
              </div>
              <input id="contacts-import-input" type="file" accept=".csv,text/csv" hidden />
              <p class="contact-import-status" id="contacts-import-status" role="status" aria-live="polite"></p>
            </div>
            <ul id="contact-list" class="contact-list">
              ${uniqueContacts.map(({ contact, contactIds, groupNames }) => `
                <li class="contact-row" data-contact-search="${escapeHtml(`${contact.name} ${contact.mobile} ${contact.department} ${groupNames.join(' ')}`.toLocaleLowerCase())}">
                  <div class="contact-identity">
                    <span class="contact-avatar" aria-hidden="true">${escapeHtml(contact.name.trim().slice(0, 1).toLocaleUpperCase() || '?')}</span>
                    <div class="contact-details">
                      <strong>${escapeHtml(contact.name)}</strong>
                      <span class="muted contact-subtitle">${escapeHtml(contact.mobile)} · ${escapeHtml(contact.department || 'No department')}</span>
                      <span class="muted contact-subtitle">${escapeHtml(groupNames.length ? groupNames.join(', ') : 'No group')}</span>
                    </div>
                  </div>
                  <div class="contact-row-actions">
                    ${state.user?.role === 'administrator'
                      ? `
                          <input type="checkbox" class="contact-bulk-select" value="${escapeHtml(contactIds.join(','))}" aria-label="Select ${escapeHtml(contact.name)}" />
                          <button type="button" class="link-action" data-contact-action="edit" data-contact-id="${escapeHtml(contact.id)}"><i data-lucide="pencil"></i>Edit</button>
                          <button type="button" class="link-action danger" data-contact-action="delete" data-contact-id="${escapeHtml(contact.id)}" data-contact-ids="${escapeHtml(contactIds.join(','))}"><i data-lucide="trash-2"></i>Delete</button>
                        `
                      : ''}
                    <span class="pill ${isValidMvMobile(contact.mobile) ? '' : 'danger'}">${isValidMvMobile(contact.mobile) ? 'Valid number' : 'Check number'}</span>
                  </div>
                </li>
              `).join('')}
            </ul>
            <div class="contacts-empty" id="contacts-empty-state" ${uniqueContacts.length ? 'hidden' : ''}>
              <i data-lucide="contact"></i><strong>No contacts yet</strong>
              <span class="muted">Add your first contact using the form, or import a CSV directory.</span>
            </div>
            <div class="contacts-empty" id="contacts-no-results" hidden>
              <i data-lucide="contact"></i><strong>No matching contacts</strong>
              <span class="muted">Try another name, mobile number, department, or group.</span>
            </div>
          </div>
        </div>
      </div>

      <div class="section ${state.activeSection === 'groups' ? 'active' : ''}" data-section-panel="groups">
        <div class="groups-page" style="margin-top: 20px;">
          <header class="groups-page-header">
            <p class="groups-eyebrow">Workspace</p>
            <h1>Groups</h1>
            <p class="muted">Organize contacts into teams and manage who receives each group message.</p>
          </header>
          <p id="groups-status" class="groups-status" role="status" aria-live="polite"></p>
          <div class="layout groups-workspace">
            <div class="groups-left-column">
              ${isAdministrator ? `
                <form id="group-form" class="card panel">
                  <div class="group-form-heading">
                    <div>
                      <p class="group-eyebrow">Group details</p>
                      <h2 id="group-form-title">${isCreatingGroup ? 'Create a group' : editingGroup ? 'Edit group' : 'Group details'}</h2>
                      <p class="muted">${isCreatingGroup ? 'Name the group before adding contacts.' : editingGroup ? 'Update this group’s name or description.' : 'Choose a group below to edit its details.'}</p>
                    </div>
                    <button type="button" class="secondary" id="new-group-button"><i data-lucide="${isCreatingGroup ? 'x' : 'plus'}"></i>${isCreatingGroup ? 'Cancel' : 'New group'}</button>
                  </div>
                  <div class="stack">
                    <div>
                      <label for="group-name">Group name</label>
                      <input id="group-name" name="name" value="${escapeHtml(isCreatingGroup ? '' : editingGroup?.name ?? '')}" placeholder="e.g. Roadworks Team" autocomplete="off" required />
                    </div>
                    <div>
                      <label for="group-description">Description <span class="muted">(optional)</span></label>
                      <textarea id="group-description" name="description" placeholder="What is this group for?">${escapeHtml(isCreatingGroup ? '' : editingGroup?.description ?? '')}</textarea>
                    </div>
                    <div class="actions group-form-actions">
                      <button type="submit" id="save-group-button" ${!isCreatingGroup && !editingGroup ? 'disabled' : ''}><i data-lucide="${isCreatingGroup ? 'plus' : 'check'}"></i>${isCreatingGroup ? 'Create group' : 'Save changes'}</button>
                      <button type="button" class="secondary" id="reset-group-form"><i data-lucide="x"></i>${editingGroup || isCreatingGroup ? 'Cancel' : 'Clear selection'}</button>
                    </div>
                  </div>
                </form>
              ` : ''}

              <section class="card panel group-directory-panel">
                <div class="group-directory-heading">
                  <div>
                    <p class="group-eyebrow">Directory</p>
                    <h2>All groups <span class="contact-count">${state.groups.length}</span></h2>
                  </div>
                </div>
                <input id="group-directory-search" class="group-directory-search" type="search" placeholder="Search groups" aria-label="Search groups" />
                <p id="group-directory-count" class="muted" style="margin: 0 0 10px; font-size: 0.78rem;">${state.groups.length} group${state.groups.length === 1 ? '' : 's'}</p>
                <ul id="group-list" class="group-directory-list">
                  ${state.groups.map((group) => `
                    <li class="group-directory-row" data-group-search="${escapeHtml(`${group.name} ${group.description}`.toLocaleLowerCase())}">
                      <div class="group-directory-details">
                        <strong>${escapeHtml(group.name)}</strong>
                        <span class="muted">${escapeHtml(group.description || 'No description')}</span>
                      </div>
                      <div class="group-row-actions">
                        <span class="group-member-count">${group.memberCount} member${group.memberCount === 1 ? '' : 's'}</span>
                        <button type="button" class="link-action" data-group-action="manage" data-group-id="${escapeHtml(group.id)}"><i data-lucide="users-round"></i>Manage</button>
                        ${state.user?.role === 'administrator'
                          ? `
                              <button type="button" class="link-action" data-group-action="edit" data-group-id="${escapeHtml(group.id)}"><i data-lucide="pencil"></i>Edit</button>
                              <button type="button" class="link-action danger" data-group-action="delete" data-group-id="${escapeHtml(group.id)}"><i data-lucide="trash-2"></i>Delete</button>
                            `
                          : ''}
                      </div>
                    </li>
                  `).join('')}
                </ul>
                <div id="group-directory-empty" class="group-empty-state" ${state.groups.length ? 'hidden' : ''}>
                  <strong>No groups yet</strong>
                  ${isAdministrator ? 'Create a group to organize contacts and manage recipients.' : 'An administrator can create groups for your team.'}
                </div>
                <div id="group-directory-no-results" class="group-empty-state" hidden><strong>No matching groups</strong>Try a different group name or description.</div>
              </section>
            </div>

            <section class="card panel group-members-panel">
              <div class="group-panel-heading">
                <div>
                  <p class="group-eyebrow">Membership</p>
                  <h2>${editingGroup ? escapeHtml(editingGroup.name) : 'Manage members'}</h2>
                </div>
                ${editingGroup ? `<span class="pill">${currentGroupMembers.length} member${currentGroupMembers.length === 1 ? '' : 's'}</span>` : ''}
              </div>
              <div class="group-selector">
                <label for="group-editor-select">Choose a group</label>
                <select id="group-editor-select">
                  <option value="" ${!editingGroup ? 'selected' : ''}>Select a group to manage</option>
                  ${state.groups.map((group) => `<option value="${escapeHtml(group.id)}" ${group.id === editingGroup?.id ? 'selected' : ''}>${escapeHtml(group.name)} (${group.memberCount})</option>`).join('')}
                </select>
              </div>
              ${isCreatingGroup
                ? '<div class="group-empty-state"><strong>Create the group first</strong>After saving its details, you can add contacts here.</div>'
                : editingGroup
                  ? `
                    <div class="group-member-section">
                      <h3>Current members</h3>
                      <ul id="current-group-members" class="group-member-list">
                        ${currentGroupMembers.length
                          ? currentGroupMembers.map((contact) => `
                              <li class="group-member-row">
                                <div class="group-member-details"><strong>${escapeHtml(contact.name)}</strong><span class="muted">${escapeHtml(contact.mobile)}</span></div>
                                <button type="button" class="link-action danger" data-remove-group-member="${escapeHtml(contact.id)}" aria-label="Remove ${escapeHtml(contact.name)} from ${escapeHtml(editingGroup.name)}"><i data-lucide="user-minus"></i>Remove</button>
                              </li>
                            `).join('')
                          : '<li class="group-empty-state"><strong>No members in this group</strong>Search available contacts below to add the first member.</li>'}
                      </ul>
                    </div>
                    <div class="group-member-picker-section">
                      <div class="group-picker-heading">
                        <label for="group-member-search">Add contacts</label>
                        <button type="button" id="select-visible-members" ${availableGroupContacts.length ? '' : 'disabled'}>Select visible</button>
                      </div>
                      <input id="group-member-search" class="group-picker-search" type="search" placeholder="Search name or mobile number" aria-label="Search available contacts" />
                      <p id="group-member-results" class="group-member-results" aria-live="polite"></p>
                      <div id="group-member-picker" class="member-picker">
                        ${availableGroupContacts.map((contact) => `
                          <label class="member-option" data-member-search="${escapeHtml(`${contact.name} ${contact.mobile} ${contact.groupName || ''}`.toLocaleLowerCase())}">
                            <input type="checkbox" name="add-members" value="${escapeHtml(contact.id)}" />
                            <span><strong>${escapeHtml(contact.name)}</strong><small>${escapeHtml(contact.mobile)} · ${escapeHtml(contact.groupName || 'Unassigned')}</small></span>
                          </label>
                        `).join('')}
                        <div id="group-member-no-results" class="group-member-empty" ${availableGroupContacts.length ? 'hidden' : ''}>No other contacts are available to add.</div>
                      </div>
                      <button type="button" id="add-group-members" disabled><i data-lucide="user-plus"></i><span id="add-group-members-label">Add selected contacts</span></button>
                      <p class="muted" style="margin: 10px 0 0; font-size: 0.78rem;">Contacts from another group are copied into this group. Removing a member only affects this group.</p>
                    </div>
                  `
                  : state.groups.length
                    ? '<div class="group-empty-state"><strong>Select a group to get started</strong>Choose a group above or use Manage from the directory.</div>'
                    : '<div class="group-empty-state"><strong>No groups to manage</strong>Create a group first, then add its contacts.</div>'}
            </section>
          </div>
        </div>
      </div>

      <div class="section ${state.activeSection === 'admin' ? 'active' : ''}" data-section-panel="admin">
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
                      <button type="submit"><i data-lucide="check"></i>Save user</button>
                      <button type="button" class="secondary" id="reset-user-form"><i data-lucide="x"></i>Clear</button>
                    </div>
                  </form>
                  <p class="muted" id="user-status">Create or update admin and staff accounts.</p>
                </div>

                <div class="card panel">
                  <h2>Existing users</h2>
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
                    <button type="button" class="secondary" id="export-sms-csv" ${state.smsReportLoaded && !state.smsReportLoading ? '' : 'disabled'}><i data-lucide="download"></i>Export CSV</button>
                    <button type="button" class="secondary" id="clear-sms-filter"><i data-lucide="list-filter"></i>Clear filters</button>
                  </div>
                  <ul id="sms-report-list" style="margin-top: 14px;">
                    ${reportRowsHtml}
                  </ul>
                </div>
              </div>
            `
            : '<p class="muted">Administrator access is required to manage users and export SMS reports.</p>'}
        </div>
      </div>

      <div class="section ${state.activeSection === 'settings' ? 'active' : ''}" data-section-panel="settings">
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
                  <button type="submit"><i data-lucide="check"></i>Save DB settings</button>
                  <button type="button" class="secondary" id="test-db"><i data-lucide="refresh-cw"></i>Test connection</button>
                  <button type="button" class="secondary" id="init-db"><i data-lucide="database"></i>Initialize collections</button>
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

  renderIcons(root);
  bindMainNavigation();
  bindSettingsTabs();
  attachSettingsHandlers();

  document.getElementById('refresh-sms-history')?.addEventListener('click', () => {
    void loadSmsHistoryPage(0, true);
  });

  document.getElementById('sms-history-previous')?.addEventListener('click', () => {
    if (state.smsHistoryPage > 0) void loadSmsHistoryPage(state.smsHistoryPage - 1);
  });

  document.getElementById('sms-history-next')?.addEventListener('click', () => {
    if (state.smsHistoryHasMore) void loadSmsHistoryPage(state.smsHistoryPage + 1);
  });

  document.getElementById('sms-history-list')?.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest('[data-copy-sms-id]') as HTMLElement | null;
    const messageId = button?.getAttribute('data-copy-sms-id');
    const item = state.smsHistoryItems.find((historyItem) => historyItem.id === messageId);
    if (!item) return;

    const status = document.getElementById('sms-history-status');
    try {
      await copyTextToClipboard(item.message);
      notifyStatus(status, 'Message copied to clipboard.', 'success');
    } catch {
      notifyStatus(status, 'Could not copy the message. Select and copy the text instead.', 'error');
    }
  });

  const templateForm = document.getElementById('template-form') as HTMLFormElement | null;
  const templateTitleInput = document.getElementById('template-title') as HTMLInputElement | null;
  const templateMessageInput = document.getElementById('template-message') as HTMLTextAreaElement | null;
  const templateCounter = document.getElementById('template-character-count');
  const updateTemplateCounter = () => {
    if (!templateMessageInput || !templateCounter) return;
    let characterCount = countSmsCharacters(templateMessageInput.value);
    if (characterCount > SMS_MESSAGE_LIMIT) {
      templateMessageInput.value = truncateSmsMessage(templateMessageInput.value, SMS_MESSAGE_LIMIT);
      characterCount = countSmsCharacters(templateMessageInput.value);
    }
    templateCounter.textContent = `${characterCount.toLocaleString()} / ${SMS_MESSAGE_LIMIT.toLocaleString()}`;
    templateCounter.classList.toggle('near-limit', characterCount >= SMS_MESSAGE_LIMIT * 0.9 && characterCount < SMS_MESSAGE_LIMIT);
    templateCounter.classList.toggle('at-limit', characterCount === SMS_MESSAGE_LIMIT);
  };
  templateMessageInput?.addEventListener('input', updateTemplateCounter);
  updateTemplateCounter();

  const resetTemplateForm = () => {
    templateForm?.reset();
    editingLocalSmsTemplateId = null;
    const heading = document.getElementById('template-form-heading');
    const saveLabel = document.getElementById('template-save-label');
    const resetLabel = document.getElementById('template-reset-label');
    if (heading) heading.textContent = 'Create a template';
    if (saveLabel) saveLabel.textContent = 'Save template';
    if (resetLabel) resetLabel.textContent = 'Clear';
    updateTemplateCounter();
  };

  templateForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const userId = state.user?.id;
    const title = templateTitleInput?.value.trim() ?? '';
    const message = templateMessageInput?.value ?? '';
    if (!userId) return;
    if (!title) {
      const status = document.getElementById('templates-status');
      notifyStatus(status, 'Enter a name for this template.', 'error');
      templateTitleInput?.focus();
      return;
    }
    if (!message.trim()) {
      const status = document.getElementById('templates-status');
      notifyStatus(status, 'Enter message text before saving.', 'error');
      templateMessageInput?.focus();
      return;
    }
    if (countSmsCharacters(message) > SMS_MESSAGE_LIMIT) {
      const status = document.getElementById('templates-status');
      notifyStatus(status, `Messages cannot exceed ${SMS_MESSAGE_LIMIT.toLocaleString()} characters.`, 'error');
      updateTemplateCounter();
      return;
    }

    const now = new Date().toISOString();
    const existingTemplate = localSmsTemplates.find((template) => template.id === editingLocalSmsTemplateId && template.userId === userId);
    const template: LocalSmsTemplate = {
      id: existingTemplate?.id ?? crypto.randomUUID(),
      userId,
      title,
      message,
      createdAt: existingTemplate?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      await saveLocalSmsTemplate(template);
      localSmsTemplates = [template, ...localSmsTemplates.filter((item) => item.id !== template.id)]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      localSmsTemplatesUserId = userId;
      editingLocalSmsTemplateId = null;
      renderDashboard();
      const status = document.getElementById('templates-status');
      notifyStatus(status, existingTemplate ? 'Template changes saved locally.' : 'Template saved on this device.', 'success');
    } catch (error) {
      const status = document.getElementById('templates-status');
      notifyStatus(status, error instanceof Error ? error.message : 'Unable to save this template locally.', 'error');
    }
  });

  document.getElementById('template-reset-button')?.addEventListener('click', () => {
    resetTemplateForm();
    const status = document.getElementById('templates-status');
    if (status) status.textContent = '';
  });

  document.getElementById('template-search')?.addEventListener('input', (event) => {
    const query = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.template-row'));
    let visibleCount = 0;
    for (const row of rows) {
      const visible = row.dataset.templateSearch?.includes(query) ?? false;
      row.hidden = !visible;
      if (visible) visibleCount += 1;
    }
    const noResults = document.getElementById('template-no-results');
    noResults?.classList.toggle('visible', rows.length > 0 && visibleCount === 0);
  });

  document.getElementById('template-list')?.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest('[data-template-action]') as HTMLElement | null;
    const action = button?.getAttribute('data-template-action');
    const templateId = button?.getAttribute('data-template-id');
    const userId = state.user?.id;
    const template = localSmsTemplates.find((item) => item.id === templateId && item.userId === userId);
    if (!button || !action || !template || !userId) return;

    const status = document.getElementById('templates-status');
    if (action === 'copy') {
      try {
        await copyTextToClipboard(template.message);
        notifyStatus(status, `Copied “${template.title}” to the clipboard.`, 'success');
      } catch {
        notifyStatus(status, 'Could not copy the message. Open the template to select and copy its text.', 'error');
      }
      return;
    }

    if (action === 'edit') {
      editingLocalSmsTemplateId = template.id;
      if (templateTitleInput) templateTitleInput.value = template.title;
      if (templateMessageInput) templateMessageInput.value = template.message;
      const heading = document.getElementById('template-form-heading');
      const saveLabel = document.getElementById('template-save-label');
      const resetLabel = document.getElementById('template-reset-label');
      if (heading) heading.textContent = 'Edit template';
      if (saveLabel) saveLabel.textContent = 'Save changes';
      if (resetLabel) resetLabel.textContent = 'Cancel edit';
      updateTemplateCounter();
      templateTitleInput?.focus();
      notifyStatus(status, `Editing “${template.title}”.`);
      return;
    }

    if (action === 'delete' && window.confirm(`Delete the “${template.title}” template?`)) {
      try {
        await deleteLocalSmsTemplate(userId, template.id);
        localSmsTemplates = localSmsTemplates.filter((item) => item.id !== template.id);
        if (editingLocalSmsTemplateId === template.id) resetTemplateForm();
        renderDashboard();
        const refreshedStatus = document.getElementById('templates-status');
        notifyStatus(refreshedStatus, `Deleted “${template.title}”.`, 'success');
      } catch (error) {
        notifyStatus(status, error instanceof Error ? error.message : 'Unable to delete this template.', 'error');
      }
    }
  });

  const selectGroupForEditing = (groupId: string) => {
    state.groupEditorId = groupId;
    state.groupEditorMode = 'existing';
    renderDashboard();
  };

  document.getElementById('group-editor-select')?.addEventListener('change', (event) => {
    const groupId = (event.currentTarget as HTMLSelectElement).value;
    selectGroupForEditing(groupId);
  });

  document.getElementById('new-group-button')?.addEventListener('click', () => {
    if (state.groupEditorMode === 'new') {
      selectGroupForEditing('');
      return;
    }
    state.groupEditorId = '';
    state.groupEditorMode = 'new';
    renderDashboard();
  });

  document.getElementById('load-more-sms')?.addEventListener('click', async (event) => {
    if (state.smsLoading) return;
    const appApi = apiClient();
    if (!appApi || !state.smsHasMore) return;

    const button = event.currentTarget as HTMLButtonElement;
    state.smsLoading = true;
    button.disabled = true;
    button.textContent = 'Loading...';
    try {
      const page = await appApi.invoke('sms:list', {
        limit: SMS_PAGE_SIZE,
        ...(state.smsCursor ? { cursor: state.smsCursor } : {}),
      }) as SmsPage;
      state.sms = [...state.sms, ...page.items];
      state.smsCursor = page.nextCursor;
      state.smsHasMore = page.hasMore;
    } catch (error) {
      state.status = error instanceof Error ? error.message : 'Unable to load more SMS logs.';
      notifyStatus(null, state.status, 'error');
    } finally {
      state.smsLoading = false;
      renderDashboard();
    }
  });

  const smsForm = document.getElementById('sms-form') as HTMLFormElement | null;
  const recipientInput = smsForm?.elements.namedItem('to') as HTMLInputElement | null;
  const groupSelect = smsForm?.elements.namedItem('groupId') as HTMLSelectElement | null;
  const messageInput = smsForm?.elements.namedItem('message') as HTMLTextAreaElement | null;
  const messageCounter = document.getElementById('sms-message-counter');
  const updateSmsMessageLength = () => {
    if (!messageInput || !messageCounter) return;
    const originalValue = messageInput.value;
    const originalLength = countSmsCharacters(originalValue);
    if (originalLength > SMS_MESSAGE_LIMIT) {
      const cursorCharacter = countSmsCharacters(originalValue.slice(0, messageInput.selectionStart ?? originalValue.length));
      messageInput.value = truncateSmsMessage(originalValue);
      const cursorPosition = truncateSmsMessage(messageInput.value, cursorCharacter).length;
      messageInput.setSelectionRange(cursorPosition, cursorPosition);
    }
    const length = countSmsCharacters(messageInput.value);
    messageCounter.textContent = `${length.toLocaleString()} / ${SMS_MESSAGE_LIMIT.toLocaleString()}`;
    messageCounter.classList.toggle('near-limit', length >= SMS_MESSAGE_LIMIT * 0.9 && length < SMS_MESSAGE_LIMIT);
    messageCounter.classList.toggle('at-limit', length === SMS_MESSAGE_LIMIT);
  };
  messageInput?.addEventListener('input', updateSmsMessageLength);
  updateSmsMessageLength();
  groupSelect?.addEventListener('change', () => {
    if (recipientInput) recipientInput.disabled = Boolean(groupSelect.value);
  });

  const setContactStatus = (message: string) => {
    const status = document.getElementById('contacts-status');
    notifyStatus(status, message);
  };

  const setGroupStatus = (message: string) => {
    const status = document.getElementById('groups-status');
    notifyStatus(status, message);
  };

  const contactSearch = document.getElementById('contact-search') as HTMLInputElement | null;
  const updateContactDirectory = () => {
    const query = contactSearch?.value.trim().toLocaleLowerCase() ?? '';
    const rows = Array.from(document.querySelectorAll<HTMLElement>('#contact-list .contact-row'));
    let visibleCount = 0;
    for (const row of rows) {
      const visible = row.dataset.contactSearch?.includes(query) ?? false;
      row.hidden = !visible;
      if (visible) visibleCount += 1;
    }

    const count = document.getElementById('contact-result-count');
    if (count) {
        count.textContent = visibleCount === 0
          ? '0 contacts'
          : visibleCount === uniqueContacts.length
            ? `Showing all ${visibleCount} contact${visibleCount === 1 ? '' : 's'}`
            : `Showing ${visibleCount} of ${uniqueContacts.length} contacts`;
    }
    const emptyState = document.getElementById('contacts-empty-state');
    const noResults = document.getElementById('contacts-no-results');
    if (emptyState) emptyState.hidden = uniqueContacts.length > 0;
    if (noResults) noResults.hidden = uniqueContacts.length === 0 || visibleCount > 0;
  };
  contactSearch?.addEventListener('input', updateContactDirectory);
  updateContactDirectory();

  document.getElementById('contact-list')?.addEventListener('change', () => {
    const selectedCount = document.querySelectorAll<HTMLInputElement>('.contact-bulk-select:checked').length;
    const bulkDeleteButton = document.getElementById('bulk-delete-contacts') as HTMLButtonElement | null;
    if (bulkDeleteButton) bulkDeleteButton.disabled = selectedCount === 0;
    const bulkDeleteLabel = document.getElementById('bulk-delete-label');
    if (bulkDeleteLabel) bulkDeleteLabel.textContent = selectedCount ? `Delete selected (${selectedCount})` : 'Delete selected';
  });

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
    const appApi = apiClient();
    if (!payload.name || !payload.mobile || !isValidMvMobile(payload.mobile)) {
      setContactStatus('Contact not saved: use a valid Maldives mobile number.');
      return;
    }
    if (!payload.groupId) {
      setContactStatus('Contact not saved: select a group for this contact.');
      return;
    }
    if (state.contacts.some((contact) => contact.mobile === payload.mobile && contact.groupId === payload.groupId && contact.id !== contactId)) {
      setContactStatus('Contact not saved: this mobile number already exists in the selected group.');
      return;
    }
    try {
      if (!appApi) {
        const groupName = state.groups.find((group) => group.id === payload.groupId)?.name ?? 'Unassigned';
        state.contacts.unshift({ id: `demo-${Date.now()}`, name: payload.name, mobile: payload.mobile, department: payload.department, groupId: payload.groupId, groupName });
        renderDashboard();
        (document.getElementById('contact-form') as HTMLFormElement | null)?.reset();
        setContactStatus(`Demo contact saved to ${groupName}.`);
        return;
      }
      let successMessage: string;
      if (contactId) {
        await appApi.invoke('contacts:update', { id: contactId, ...payload });
        successMessage = `Contact updated for ${payload.mobile}.`;
      } else {
        await appApi.invoke('contacts:create', payload);
        successMessage = `Contact added for ${payload.mobile}.`;
      }
      await loadDashboardData();
      (document.getElementById('contact-form') as HTMLFormElement | null)?.reset();
      setContactStatus(successMessage);
    } catch (error) {
      setContactStatus(error instanceof Error ? error.message : 'Unable to save contact.');
    }
  });

  document.getElementById('reset-contact-form')?.addEventListener('click', () => {
    const form = document.getElementById('contact-form') as HTMLFormElement | null;
    if (!form) return;
    form.reset();
    const hiddenIdField = form.elements.namedItem('contactId') as HTMLInputElement | null;
    if (hiddenIdField) hiddenIdField.value = '';
    const heading = document.getElementById('contact-form-heading');
    const submitLabel = document.getElementById('contact-submit-label');
    const resetLabel = document.getElementById('contact-reset-label');
    if (heading) heading.textContent = 'Add a contact';
    if (submitLabel) submitLabel.textContent = 'Add contact';
    if (resetLabel) resetLabel.textContent = 'Clear';
    setContactStatus('');
  });

  document.getElementById('contact-list')?.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest('[data-contact-action]') as HTMLElement | null;
    if (!button) return;

    const action = button.getAttribute('data-contact-action');
    const contactId = button.getAttribute('data-contact-id');
    if (!action || !contactId) return;
    const contactIds = button.getAttribute('data-contact-ids')?.split(',').filter(Boolean) ?? [contactId];

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
      const heading = document.getElementById('contact-form-heading');
      const submitLabel = document.getElementById('contact-submit-label');
      const resetLabel = document.getElementById('contact-reset-label');
      if (heading) heading.textContent = 'Edit contact';
      if (submitLabel) submitLabel.textContent = 'Save changes';
      if (resetLabel) resetLabel.textContent = 'Cancel edit';
      nameField?.focus();
      setContactStatus(`Editing ${contact.name}.`);
      return;
    }

    if (action === 'delete') {
      if (contactIds.length > 1 && !window.confirm(`Delete ${contact?.name ?? 'this contact'} from all ${contactIds.length} groups?`)) return;
      try {
        if (!appApi) {
          setContactStatus('Contact deletion is only available in the Electron app.');
          return;
        }
        if (contactIds.length > 1) {
          await appApi.invoke('contacts:bulk-delete', { ids: contactIds });
        } else {
          await appApi.invoke('contacts:delete', { id: contactId });
        }
        await loadDashboardData();
        setContactStatus(`${contact?.name ?? 'Contact'} deleted from all groups.`);
      } catch (error) {
        setContactStatus(error instanceof Error ? error.message : 'Unable to delete contact.');
      }
    }
  });

  document.getElementById('bulk-delete-contacts')?.addEventListener('click', async () => {
    const selectedContacts = Array.from(document.querySelectorAll('.contact-bulk-select:checked'));
    const ids = Array.from(new Set(selectedContacts.flatMap((item) => item.getAttribute('value')?.split(',') ?? [])));
    const appApi = apiClient();
    if (!ids.length) {
      setContactStatus('Select one or more contacts to delete.');
      return;
    }
    try {
      if (!appApi) {
        setContactStatus('Bulk contact deletion is only available in the Electron app.');
        return;
      }
      await appApi.invoke('contacts:bulk-delete', { ids });
      await loadDashboardData();
      setContactStatus(`${selectedContacts.length} unique contact(s) deleted.`);
    } catch (error) {
      setContactStatus(error instanceof Error ? error.message : 'Unable to delete selected contacts.');
    }
  });

  const updateGroupDirectory = () => {
    const search = document.getElementById('group-directory-search') as HTMLInputElement | null;
    const query = search?.value.trim().toLocaleLowerCase() ?? '';
    const rows = Array.from(document.querySelectorAll<HTMLElement>('#group-list .group-directory-row'));
    let visibleCount = 0;
    for (const row of rows) {
      const visible = row.dataset.groupSearch?.includes(query) ?? false;
      row.hidden = !visible;
      if (visible) visibleCount += 1;
    }
    const count = document.getElementById('group-directory-count');
    if (count) count.textContent = query ? `Showing ${visibleCount} of ${rows.length} groups` : `${rows.length} group${rows.length === 1 ? '' : 's'}`;
    const empty = document.getElementById('group-directory-empty');
    const noResults = document.getElementById('group-directory-no-results');
    if (empty) empty.hidden = rows.length > 0;
    if (noResults) noResults.hidden = rows.length === 0 || visibleCount > 0;
  };
  document.getElementById('group-directory-search')?.addEventListener('input', updateGroupDirectory);
  updateGroupDirectory();

  const updateGroupMemberPicker = () => {
    const search = document.getElementById('group-member-search') as HTMLInputElement | null;
    const query = search?.value.trim().toLocaleLowerCase() ?? '';
    const options = Array.from(document.querySelectorAll<HTMLElement>('.member-option'));
    let visibleCount = 0;
    for (const option of options) {
      const visible = option.dataset.memberSearch?.includes(query) ?? false;
      option.hidden = !visible;
      if (visible) visibleCount += 1;
    }
    const selectedCount = document.querySelectorAll<HTMLInputElement>('.member-option input:checked').length;
    const results = document.getElementById('group-member-results');
    if (results) {
      results.textContent = options.length
        ? `${query ? `Showing ${visibleCount} of ${options.length}` : `${options.length}`} available contact${options.length === 1 ? '' : 's'}${selectedCount ? ` · ${selectedCount} selected` : ''}`
        : 'No other contacts are available.';
    }
    const noResults = document.getElementById('group-member-no-results');
    if (noResults) {
      noResults.textContent = options.length ? 'No contacts match your search.' : 'No other contacts are available to add.';
      noResults.hidden = options.length > 0 && visibleCount > 0;
    }
    const addButton = document.getElementById('add-group-members') as HTMLButtonElement | null;
    if (addButton) addButton.disabled = selectedCount === 0;
    const addLabel = document.getElementById('add-group-members-label');
    if (addLabel) addLabel.textContent = selectedCount ? `Add selected contacts (${selectedCount})` : 'Add selected contacts';
    const selectVisibleButton = document.getElementById('select-visible-members') as HTMLButtonElement | null;
    if (selectVisibleButton) selectVisibleButton.disabled = visibleCount === 0;
  };
  document.getElementById('group-member-search')?.addEventListener('input', updateGroupMemberPicker);
  document.getElementById('group-member-picker')?.addEventListener('change', updateGroupMemberPicker);
  document.getElementById('select-visible-members')?.addEventListener('click', () => {
    document.querySelectorAll<HTMLInputElement>('.member-option:not([hidden]) input[type="checkbox"]')
      .forEach((checkbox) => { checkbox.checked = true; });
    updateGroupMemberPicker();
  });
  updateGroupMemberPicker();

  const saveGroupMemberIds = async (groupId: string, memberIds: string[]) => {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) throw new Error('Select a group before editing its members.');
    const appApi = apiClient();
    if (appApi) {
      const result = await appApi.invoke('groups:update', {
        id: group.id,
        members: memberIds,
      }) as { memberCount: number };
      await loadDashboardData();
      return result.memberCount;
    }

    const selectedIds = new Set(memberIds);
    const existingMembers = state.contacts.filter((contact) => contact.groupId === groupId);
    const retainedMembers = existingMembers.filter((contact) => selectedIds.has(contact.id));
    const memberNumbers = new Set(retainedMembers.map((contact) => contact.mobile));
    const copies = [] as typeof state.contacts;
    for (const contact of state.contacts) {
      if (!selectedIds.has(contact.id) || contact.groupId === groupId || memberNumbers.has(contact.mobile)) continue;
      memberNumbers.add(contact.mobile);
      copies.push({ ...contact, id: `demo-${groupId}-${Date.now()}-${copies.length}`, groupId, groupName: group.name });
    }
    state.contacts = [
      ...state.contacts.filter((contact) => contact.groupId !== groupId || selectedIds.has(contact.id)),
      ...copies,
    ];
    const memberCount = retainedMembers.length + copies.length;
    state.groups = state.groups.map((item) => item.id === groupId ? { ...item, memberCount } : item);
    renderDashboard();
    return memberCount;
  };

  document.getElementById('add-group-members')?.addEventListener('click', async () => {
    const group = state.groups.find((item) => item.id === state.groupEditorId);
    if (!group) {
      setGroupStatus('Select a group before adding members.');
      return;
    }
    const selectedIds = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="add-members"]:checked'))
      .map((checkbox) => checkbox.value);
    if (!selectedIds.length) {
      setGroupStatus('Select at least one contact to add.');
      return;
    }
    try {
      const currentIds = state.contacts.filter((contact) => contact.groupId === group.id).map((contact) => contact.id);
      const memberCount = await saveGroupMemberIds(group.id, [...currentIds, ...selectedIds]);
      const addedCount = Math.max(0, memberCount - currentIds.length);
      setGroupStatus(addedCount ? `${addedCount} contact${addedCount === 1 ? '' : 's'} added to ${group.name}.` : 'No contacts were added; those numbers are already in this group.');
    } catch (error) {
      setGroupStatus(error instanceof Error ? error.message : 'Unable to add group members.');
    }
  });

  document.getElementById('current-group-members')?.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest('[data-remove-group-member]') as HTMLElement | null;
    const contactId = button?.getAttribute('data-remove-group-member');
    const group = state.groups.find((item) => item.id === state.groupEditorId);
    if (!contactId || !group) return;
    try {
      const remainingIds = state.contacts
        .filter((contact) => contact.groupId === group.id && contact.id !== contactId)
        .map((contact) => contact.id);
      await saveGroupMemberIds(group.id, remainingIds);
      setGroupStatus(`Contact removed from ${group.name}.`);
    } catch (error) {
      setGroupStatus(error instanceof Error ? error.message : 'Unable to remove group member.');
    }
  });

  document.getElementById('group-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const groupId = state.groupEditorMode === 'new' ? '' : state.groupEditorId;
    const payload = {
      name: String(formData.get('name') ?? '').trim(),
      description: String(formData.get('description') ?? '').trim(),
    };
    const appApi = apiClient();
    if (!payload.name) {
      setGroupStatus('Group not saved: name is required.');
      return;
    }
    try {
      if (!appApi) {
        const demoGroupId = groupId || `demo-group-${Date.now()}`;
        if (groupId) {
          state.groups = state.groups.map((group) => group.id === groupId ? { ...group, name: payload.name, description: payload.description } : group);
          state.contacts = state.contacts.map((contact) => contact.groupId === groupId ? { ...contact, groupName: payload.name } : contact);
        } else {
          state.groups.unshift({ id: demoGroupId, name: payload.name, description: payload.description, memberCount: 0 });
          state.groupEditorId = demoGroupId;
          state.groupEditorMode = 'existing';
        }
        renderDashboard();
        setGroupStatus(groupId ? `Group details saved: ${payload.name}.` : `Group created: ${payload.name}. Add members from the panel.`);
        return;
      }
      let successMessage: string;
      if (groupId) {
        await appApi.invoke('groups:update', { id: groupId, ...payload });
        successMessage = `Group details saved: ${payload.name}.`;
      } else {
        const created = await appApi.invoke('groups:create', payload) as { id: string };
        state.groupEditorId = created.id;
        state.groupEditorMode = 'existing';
        successMessage = `Group created: ${payload.name}. Add members from the panel below.`;
      }
      await loadDashboardData();
      setGroupStatus(successMessage);
    } catch (error) {
      setGroupStatus(error instanceof Error ? error.message : 'Unable to save group.');
    }
  });

  document.getElementById('reset-group-form')?.addEventListener('click', () => {
    selectGroupForEditing('');
  });

  document.getElementById('group-list')?.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest('[data-group-action]') as HTMLElement | null;
    if (!button) return;

    const action = button.getAttribute('data-group-action');
    const groupId = button.getAttribute('data-group-id');
    if (!action || !groupId) return;

    const appApi = apiClient();
    const group = state.groups.find((item) => item.id === groupId);
    const form = document.getElementById('group-form') as HTMLFormElement | null;

    if (action === 'manage') {
      selectGroupForEditing(groupId);
      setGroupStatus(group ? `Managing ${group.name}.` : 'Group selected.');
      return;
    }

    if (action === 'edit' && group && form) {
      selectGroupForEditing(group.id);
      setGroupStatus(`Editing ${group.name}.`);
      return;
    }

    if (action === 'delete') {
      if (!window.confirm(`Delete ${group?.name ?? 'this group'} and remove its contacts from the directory? This cannot be undone.`)) return;
      try {
        if (!appApi) {
          setGroupStatus('Group deletion is only available in the Electron app.');
          return;
        }
        await appApi.invoke('groups:delete', { id: groupId });
        if (state.groupEditorId === groupId) state.groupEditorId = '';
        await loadDashboardData();
        setGroupStatus(`${group?.name ?? 'Group'} and its contacts were deleted.`);
      } catch (error) {
        setGroupStatus(error instanceof Error ? error.message : 'Unable to delete group.');
      }
    }
  });

  document.getElementById('sms-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const rawTo = String(formData.get('to') ?? '').trim();
    const rawGroupId = String(formData.get('groupId') ?? '').trim();
    const status = document.getElementById('sms-status');
    let directNumbers: string[];
    try {
      directNumbers = rawTo ? parseMvMobileList(rawTo) : [];
    } catch (error) {
      notifyStatus(status, error instanceof Error ? error.message : 'Invalid recipient numbers.', 'error');
      return;
    }
    const payload = {
      to: directNumbers.length ? directNumbers.join(',') : undefined,
      message: String(formData.get('message') ?? ''),
      groupId: rawGroupId || undefined,
    };
    const appApi = apiClient();
    if (!payload.message.trim()) {
      notifyStatus(status, 'SMS not queued: message text is required.', 'error');
      return;
    }
    if (countSmsCharacters(payload.message) > SMS_MESSAGE_LIMIT) {
      notifyStatus(status, 'SMS not queued: message exceeds 1,530 characters.', 'error');
      return;
    }
    if (!payload.groupId && !directNumbers.length) {
      notifyStatus(status, 'SMS not queued: enter one or more numbers or select a group.', 'error');
      return;
    }
    try {
      if (!appApi) {
        const demoRecipients = payload.groupId ? ['9607712345'] : directNumbers;
        state.sms.unshift(...demoRecipients.map((number, index) => ({
          id: `demo-sms-${Date.now()}-${index}`,
          to: number,
          message: payload.message,
          status: 'queued',
        })));
        renderDashboard();
        const refreshedStatus = document.getElementById('sms-status');
        notifyStatus(refreshedStatus, `Demo SMS queued for ${demoRecipients.length} recipient(s).`, 'success');
        return;
      }
      const queued = await appApi.invoke('sms:queue', payload) as unknown[];
      await loadDashboardData();
      const refreshedStatus = document.getElementById('sms-status');
      notifyStatus(refreshedStatus, `SMS queued for ${queued.length} recipient(s).`, 'success');
      form.reset();
    } catch (error) {
      notifyStatus(status, error instanceof Error ? error.message : 'Unable to queue SMS.', 'error');
    }
  });

  document.getElementById('send-sms')?.addEventListener('click', async () => {
    const status = document.getElementById('sms-status');
    const appApi = apiClient();
    try {
      if (!appApi) {
        state.sms = state.sms.map((item) => ({ ...item, status: item.status === 'queued' ? 'delivered' : item.status }));
        renderDashboard();
        notifyStatus(document.getElementById('sms-status'), 'Demo SMS jobs marked as delivered.', 'success');
        return;
      }
      const count = await appApi.invoke('sms:send');
      await loadDashboardData();
      notifyStatus(document.getElementById('sms-status'), `${count} queued SMS jobs sent successfully.`, 'success');
    } catch (error) {
      notifyStatus(status, error instanceof Error ? error.message : 'Unable to send queued SMS.', 'error');
    }
  });

  document.getElementById('export-contacts-csv')?.addEventListener('click', () => {
    const csv = exportContactsCsv(
      uniqueContacts.map(({ contact, groupNames }) => ({
        name: contact.name,
        mobile: contact.mobile,
        department: contact.department,
        designation: '',
        notes: '',
        groupName: groupNames.join(', '),
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
    if (!file) return;
    const setImportStatus = (message: string) => {
      const status = document.getElementById('contacts-import-status');
      notifyStatus(status, message);
    };

    const appApi = apiClient();
    try {
      setImportStatus(`Reading ${file.name}...`);
      const csvText = await file.text();
      const rows = parseContactsCsv(csvText);
      if (!rows.length) {
        setImportStatus('No contact rows were found in the selected CSV file.');
        return;
      }
      if (!appApi) {
        setImportStatus('Contact import is only available in the Electron app.');
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

      setImportStatus(`Importing ${payload.length} contact rows from ${file.name}...`);
      const result = await appApi.invoke('contacts:import', payload) as { count: number; skippedDuplicates: number };
      await loadDashboardData();
      const duplicateSummary = result.skippedDuplicates === 1
        ? ' Skipped 1 duplicate number.'
        : result.skippedDuplicates > 1
          ? ` Skipped ${result.skippedDuplicates} duplicate numbers.`
          : '';
      setImportStatus(`Imported ${result.count} contacts from ${file.name}.${duplicateSummary}`);
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : 'Unable to import contacts.');
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
      notifyStatus(status, 'Missing required user fields.', 'error');
      return;
    }

    try {
      if (!appApi) {
        notifyStatus(status, 'User management is only available in the Electron app.', 'error');
        return;
      }

      let successMessage: string;
      if (userId) {
        await appApi.invoke('users:update', { id: userId, ...payload, password: payload.password || undefined });
        successMessage = `Updated user ${payload.username}.`;
      } else {
        if (!payload.password || payload.password.length < 6) {
          notifyStatus(status, 'A password with at least 6 characters is required for new users.', 'error');
          return;
        }
        await appApi.invoke('users:create', payload);
        successMessage = `Created user ${payload.username}.`;
      }

      form.reset();
      await loadDashboardData();
      notifyStatus(document.getElementById('user-status'), successMessage, 'success');
    } catch (error) {
      notifyStatus(status, error instanceof Error ? error.message : 'Unable to save user.', 'error');
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
      notifyStatus(status, `Editing ${user.username}.`);
      return;
    }

    if (action === 'delete') {
      const status = document.getElementById('user-status');
      const appApi = apiClient();
      try {
        if (!appApi) {
          notifyStatus(status, 'User deletion is only available in the Electron app.', 'error');
          return;
        }
        await appApi.invoke('users:delete', { id: userId });
        await loadDashboardData();
        notifyStatus(document.getElementById('user-status'), `${user?.username ?? 'User'} deleted.`, 'success');
      } catch (error) {
        notifyStatus(status, error instanceof Error ? error.message : 'Unable to delete user.', 'error');
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
    const rows = filterSmsLogs(state.smsReport, state.reportFilters).map((item) => ({
      id: item.id,
      to: item.groupName || item.to,
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
