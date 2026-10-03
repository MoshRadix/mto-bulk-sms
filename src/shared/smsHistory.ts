import type { SmsCursor, SmsItem } from '../app';

/** History pages are cached locally per user; remote cursors are preserved for pagination. */
export const SMS_HISTORY_PAGE_SIZE = 20;

export type StoredSmsHistoryPage = {
  userId: string;
  page: number;
  items: SmsItem[];
  hasMore: boolean;
  nextCursor: SmsCursor | null;
};

const DATABASE_NAME = 'mto-bulk-sms-local-history';
const DATABASE_VERSION = 1;
const STORE_NAME = 'history-pages';

let databasePromise: Promise<IDBDatabase> | null = null;

function openHistoryDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('byUser', 'userId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open local SMS history.'));
  });

  return databasePromise;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save local SMS history.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local SMS history update was cancelled.'));
  });
}

export async function getStoredSmsHistoryPage(userId: string, page: number): Promise<StoredSmsHistoryPage | null> {
  const database = await openHistoryDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const request = transaction.objectStore(STORE_NAME).get(`${userId}:${page}`);
  const result = await new Promise<StoredSmsHistoryPage | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredSmsHistoryPage | undefined);
    request.onerror = () => reject(request.error ?? new Error('Unable to read local SMS history.'));
  });
  return result ?? null;
}

export async function saveSmsHistoryPage(page: StoredSmsHistoryPage): Promise<void> {
  const database = await openHistoryDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put({ ...page, key: `${page.userId}:${page.page}` });
  await transactionDone(transaction);
}

export async function clearSmsHistoryPagesAfter(userId: string, page: number): Promise<void> {
  const database = await openHistoryDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const cursorRequest = store.index('byUser').openCursor(IDBKeyRange.only(userId));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    // A refreshed earlier page invalidates all cached cursors that followed it.
    if ((cursor.value as StoredSmsHistoryPage).page > page) cursor.delete();
    cursor.continue();
  };
  await transactionDone(transaction);
}

export async function prependSmsHistoryItems(userId: string, newItems: SmsItem[]): Promise<void> {
  if (!newItems.length) return;

  // Merge by ID before sorting so syncing the same message twice stays idempotent.
  const existingPage = await getStoredSmsHistoryPage(userId, 0);
  const itemsById = new Map<string, SmsItem>();
  for (const item of [...(existingPage?.items ?? []), ...newItems]) itemsById.set(item.id, item);
  const sortedItems = Array.from(itemsById.values()).sort((left, right) =>
    (right.createdAt ? Date.parse(right.createdAt) : 0) - (left.createdAt ? Date.parse(left.createdAt) : 0),
  );
  const items = sortedItems.slice(0, SMS_HISTORY_PAGE_SIZE);
  const hasMore = Boolean(existingPage?.hasMore || sortedItems.length > SMS_HISTORY_PAGE_SIZE);
  let nextCursor = existingPage?.nextCursor ?? null;
  if (sortedItems.length > SMS_HISTORY_PAGE_SIZE) {
    const lastItem = items.at(-1);
    nextCursor = lastItem?.createdAt ? { createdAt: lastItem.createdAt, id: lastItem.id } : null;
  }

  await clearSmsHistoryPagesAfter(userId, 0);
  await saveSmsHistoryPage({ userId, page: 0, items, hasMore, nextCursor });
}