export type LocalSmsTemplate = {
  id: string;
  userId: string;
  title: string;
  message: string;
  createdAt: string;
  updatedAt: string;
};

type StoredSmsTemplate = LocalSmsTemplate & { key: string };

// A separate local database keeps reusable drafts off the remote SMS/contact database.
const DATABASE_NAME = 'mto-bulk-sms-local-templates';
const DATABASE_VERSION = 1;
const STORE_NAME = 'templates';
let databasePromise: Promise<IDBDatabase> | null = null;

function openTemplatesDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('byUserId', 'userId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open local SMS templates.'));
  });

  return databasePromise;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save local SMS templates.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local SMS template update was cancelled.'));
  });
}

export async function listLocalSmsTemplates(userId: string): Promise<LocalSmsTemplate[]> {
  const database = await openTemplatesDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const done = transactionDone(transaction);
  // The user index and compound key prevent one signed-in account from seeing another's drafts.
  const request = transaction.objectStore(STORE_NAME).index('byUserId').getAll(IDBKeyRange.only(userId));
  const templates = await new Promise<StoredSmsTemplate[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredSmsTemplate[]);
    request.onerror = () => reject(request.error ?? new Error('Unable to read local SMS templates.'));
  });
  await done;
  return templates
    .map(({ key: _key, ...template }) => template)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveLocalSmsTemplate(template: LocalSmsTemplate): Promise<void> {
  const database = await openTemplatesDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(transaction);
  // Compound keys make writes and deletes account-scoped even if template IDs collide.
  transaction.objectStore(STORE_NAME).put({ ...template, key: `${template.userId}:${template.id}` });
  await done;
}

export async function deleteLocalSmsTemplate(userId: string, templateId: string): Promise<void> {
  const database = await openTemplatesDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore(STORE_NAME).delete(`${userId}:${templateId}`);
  await done;
}
