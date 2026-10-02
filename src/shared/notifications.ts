export type NotificationTone = 'info' | 'success' | 'error';

const NOTIFICATION_DURATION = 5000;
const INLINE_STATUS_DURATION = 5000;
const statusTimers = new WeakMap<Element, number>();
let dismissTimer = 0;
let exitTimer = 0;
let activeNotification: HTMLDivElement | null = null;

function ensureNotificationStyles(): void {
  if (document.getElementById('app-notification-styles')) return;
  const styles = document.createElement('style');
  styles.id = 'app-notification-styles';
  styles.textContent = `
    #app-notification-region {
      position: fixed;
      z-index: 10000;
      right: 20px;
      bottom: 20px;
      display: grid;
      width: min(440px, calc(100vw - 32px));
      pointer-events: none;
    }
    .app-notification {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 14px 14px 16px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-left: 4px solid #38bdf8;
      border-radius: 8px;
      background: rgba(8, 18, 31, 0.98);
      box-shadow: 0 16px 42px rgba(0, 0, 0, 0.42);
      color: #f1f5f9;
      font: 500 0.9rem/1.45 "Segoe UI", sans-serif;
      opacity: 0;
      pointer-events: auto;
      transform: translateY(10px);
      animation: app-notification-in 180ms ease-out forwards;
    }
    .app-notification[data-tone="success"] { border-left-color: #4ade80; }
    .app-notification[data-tone="error"] { border-left-color: #fb7185; }
    .app-notification-message { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
    .app-notification-dismiss {
      display: grid;
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      place-items: center;
      margin: -4px -4px 0 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #cbd5e1;
      cursor: pointer;
      font: inherit;
      font-size: 1.2rem;
      line-height: 1;
    }
    .app-notification-dismiss:hover { background: rgba(148, 163, 184, 0.16); color: white; }
    .app-notification-dismiss:focus-visible { outline: 2px solid #67e8f9; outline-offset: 2px; }
    .app-notification.is-leaving { animation: app-notification-out 160ms ease-in forwards; }
    @keyframes app-notification-in { to { opacity: 1; transform: translateY(0); } }
    @keyframes app-notification-out { to { opacity: 0; transform: translateY(8px); } }
    @media (max-width: 600px) {
      #app-notification-region { right: 12px; bottom: 12px; width: calc(100vw - 24px); }
    }
    @media (prefers-reduced-motion: reduce) {
      .app-notification, .app-notification.is-leaving { animation-duration: 1ms; }
    }
  `;
  document.head.append(styles);
}

function ensureNotificationRegion(): HTMLDivElement {
  let region = document.getElementById('app-notification-region') as HTMLDivElement | null;
  if (region) return region;
  region = document.createElement('div');
  region.id = 'app-notification-region';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  document.body.append(region);
  return region;
}

export function showAppNotification(message: string, tone: NotificationTone = 'info'): void {
  if (!message) return;
  ensureNotificationStyles();
  const region = ensureNotificationRegion();
  window.clearTimeout(dismissTimer);
  window.clearTimeout(exitTimer);
  activeNotification?.remove();

  const notification = document.createElement('div');
  notification.className = 'app-notification';
  notification.dataset.tone = tone;
  if (tone === 'error') {
    notification.setAttribute('role', 'alert');
    region.setAttribute('aria-live', 'assertive');
  } else {
    notification.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
  }

  const text = document.createElement('span');
  text.className = 'app-notification-message';
  text.textContent = message;
  const dismiss = document.createElement('button');
  dismiss.className = 'app-notification-dismiss';
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss notification');
  dismiss.textContent = 'x';
  dismiss.addEventListener('click', () => dismissNotification(notification));
  notification.append(text, dismiss);
  region.replaceChildren(notification);
  activeNotification = notification;
  dismissTimer = window.setTimeout(() => dismissNotification(notification), NOTIFICATION_DURATION);
}

function dismissNotification(notification: HTMLDivElement): void {
  if (activeNotification !== notification) return;
  window.clearTimeout(dismissTimer);
  notification.classList.add('is-leaving');
  exitTimer = window.setTimeout(() => {
    if (activeNotification === notification) activeNotification = null;
    notification.remove();
  }, 170);
}

function inferNotificationTone(message: string): NotificationTone {
  if (/^no\b/i.test(message)) return 'info';
  if (/unable|could not|failed|not saved|not queued|invalid|missing|required|only available|cannot exceed|select at least|select one or more/i.test(message)) {
    return 'error';
  }
  if (/copied|saved|created|deleted|added|updated|initialized|test passed|queued for|sent successfully|imported|signed in/i.test(message)) {
    return 'success';
  }
  return 'info';
}

export function notifyStatus(status: Element | null, message: string, tone?: NotificationTone): void {
  if (status) {
    status.textContent = message;
    const oldTimer = statusTimers.get(status);
    if (oldTimer) window.clearTimeout(oldTimer);
    const timer = window.setTimeout(() => {
      if (status.textContent === message) status.textContent = '';
      statusTimers.delete(status);
    }, INLINE_STATUS_DURATION);
    statusTimers.set(status, timer);
  }
  showAppNotification(message, tone ?? inferNotificationTone(message));
}
