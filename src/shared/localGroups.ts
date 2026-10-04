export type LocalGroup = {
  id: string;
  userId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type LocalContact = {
  id: string;
  userId: string;
  name: string;
  mobile: string;
  department: string;
  groupId?: string;
  createdAt: string;
  updatedAt: string;
};

type StoredLocalGroup = LocalGroup & { key: string };
type StoredLocalContact = LocalContact & { key: string };

const DATABASE_NAME = 'mto-bulk-sms-local-data';
const DATABASE_VERSION = 1;
const GROUPS_STORE = 'groups';
const CONTACTS_STORE = 'contacts';
let databasePromise: Promise<IDBDatabase> | null = null;

function openLocalDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(GROUPS_STORE)) {
        const groupStore = database.createObjectStore(GROUPS_STORE, { keyPath: 'key' });
        groupStore.createIndex('byUserId', 'userId');
      }
      if (!database.objectStoreNames.contains(CONTACTS_STORE)) {
        const contactStore = database.createObjectStore(CONTACTS_STORE, { keyPath: 'key' });
        contactStore.createIndex('byUserId', 'userId');
        contactStore.createIndex('byUserAndGroup', ['userId', 'groupId']);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open local groups database.'));
  });

  return databasePromise;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save local data.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local data update was cancelled.'));
  });
}

export async function listLocalGroups(userId: string): Promise<LocalGroup[]> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(GROUPS_STORE, 'readonly');
  const done = transactionDone(transaction);
  const request = transaction.objectStore(GROUPS_STORE).index('byUserId').getAll(IDBKeyRange.only(userId));
  const groups = await new Promise<StoredLocalGroup[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredLocalGroup[]);
    request.onerror = () => reject(request.error ?? new Error('Unable to read local groups.'));
  });
  await done;
  return groups
    .map(({ key: _key, ...group }) => group)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function saveLocalGroup(group: LocalGroup): Promise<void> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(GROUPS_STORE, 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore(GROUPS_STORE).put({ ...group, key: `${group.userId}:${group.id}` });
  await done;
}

export async function deleteLocalGroup(userId: string, groupId: string): Promise<void> {
  const database = await openLocalDatabase();
  const transaction = database.transaction([GROUPS_STORE, CONTACTS_STORE], 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore(GROUPS_STORE).delete(`${userId}:${groupId}`);
  const contactStore = transaction.objectStore(CONTACTS_STORE);
  const index = contactStore.index('byUserAndGroup');
  const request = index.openCursor(IDBKeyRange.only([userId, groupId]));
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  await done;
}

export async function listLocalContacts(userId: string): Promise<LocalContact[]> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(CONTACTS_STORE, 'readonly');
  const done = transactionDone(transaction);
  const request = transaction.objectStore(CONTACTS_STORE).index('byUserId').getAll(IDBKeyRange.only(userId));
  const contacts = await new Promise<StoredLocalContact[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredLocalContact[]);
    request.onerror = () => reject(request.error ?? new Error('Unable to read local contacts.'));
  });
  await done;
  return contacts
    .map(({ key: _key, ...contact }) => contact)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function saveLocalContact(contact: LocalContact): Promise<void> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(CONTACTS_STORE, 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore(CONTACTS_STORE).put({ ...contact, key: `${contact.userId}:${contact.id}` });
  await done;
}

export async function deleteLocalContact(userId: string, contactId: string): Promise<void> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(CONTACTS_STORE, 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore(CONTACTS_STORE).delete(`${userId}:${contactId}`);
  await done;
}
