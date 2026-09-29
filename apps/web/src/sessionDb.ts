import type { ApiMessage, ApiSession } from "./api";

const DB_NAME = "openclaw-console-cache";
const DB_VERSION = 1;
const SESSIONS = "sessions";
const HISTORIES = "histories";

type CachedHistory = { sessionKey: string; agentId: string; messages: ApiMessage[]; sessionId?: string; updatedAt: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("IndexedDB indisponível"));
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS)) {
        const store = db.createObjectStore(SESSIONS, { keyPath: "key" });
        store.createIndex("agentId", "agentId", { unique: false });
      }
      if (!db.objectStoreNames.contains(HISTORIES)) db.createObjectStore(HISTORIES, { keyPath: "sessionKey" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Falha ao abrir cache local"));
  });
}

function transaction<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore, finish: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    run(tx.objectStore(storeName), resolve, reject);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error ?? new Error("Falha no cache local"));
  }));
}

export async function readCachedSessions(agentId: string): Promise<ApiSession[]> {
  return transaction<ApiSession[]>(SESSIONS, "readonly", (store, finish, fail) => {
    const request = store.index("agentId").getAll(agentId);
    request.onsuccess = () => finish((request.result as ApiSession[]).sort((a, b) => (b.lastActivityAt ?? b.updatedAt ?? 0) - (a.lastActivityAt ?? a.updatedAt ?? 0)));
    request.onerror = () => fail(request.error);
  });
}

export async function saveSessions(sessions: ApiSession[]): Promise<void> {
  if (!sessions.length) return;
  return transaction<void>(SESSIONS, "readwrite", (store, finish, fail) => {
    for (const session of sessions) store.put(session);
    finish(undefined);
    store.transaction.onerror = () => fail(store.transaction.error);
  });
}

export async function removeCachedSession(key: string): Promise<void> {
  return transaction<void>(SESSIONS, "readwrite", (store, finish) => { store.delete(key); finish(undefined); });
}

export async function saveCachedHistory(history: CachedHistory): Promise<void> {
  return transaction<void>(HISTORIES, "readwrite", (store, finish) => { store.put(history); finish(undefined); });
}

export async function readCachedHistory(sessionKey: string): Promise<CachedHistory | undefined> {
  return transaction<CachedHistory | undefined>(HISTORIES, "readonly", (store, finish, fail) => {
    const request = store.get(sessionKey);
    request.onsuccess = () => finish(request.result as CachedHistory | undefined);
    request.onerror = () => fail(request.error);
  });
}
