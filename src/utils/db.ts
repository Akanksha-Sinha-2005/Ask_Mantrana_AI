import { ChatSession, UserAccount } from '../types';
import {
  deleteSessionFromFirestore,
  loadSessionsFromFirestore,
  syncSessionToFirestore,
} from '../firebase';

const DB_NAME = 'mantrana_ai_db';
const DB_VERSION = 2;
const STORE_SESSIONS = 'sessions';
const ACTIVE_ACCOUNT_STORAGE_KEY = 'mantrana-active-user-account';

export function getSavedUserAccount(): UserAccount | null {
  try {
    const raw = localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.email === 'string' && typeof parsed.username === 'string') {
      return {
        uid: parsed.uid || `user-${parsed.email}`,
        email: parsed.email.trim().toLowerCase(),
        username: parsed.username.trim(),
        createdAt: parsed.createdAt || Date.now(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function setSavedUserAccount(account: UserAccount | null): void {
  try {
    if (!account) {
      localStorage.removeItem(ACTIVE_ACCOUNT_STORAGE_KEY);
    } else {
      localStorage.setItem(
        ACTIVE_ACCOUNT_STORAGE_KEY,
        JSON.stringify({
          ...account,
          email: account.email.trim().toLowerCase(),
        })
      );
    }
  } catch {
    // ignore storage errors
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const store = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('userEmail', 'userEmail', { unique: false });
      } else {
        const tx = request.transaction;
        if (tx) {
          const store = tx.objectStore(STORE_SESSIONS);
          if (!store.indexNames.contains('userEmail')) {
            store.createIndex('userEmail', 'userEmail', { unique: false });
          }
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
}

async function getLocalSessionsByEmail(normalizedEmail: string): Promise<ChatSession[]> {
  try {
    const db = await openDatabase();
    return await new Promise<ChatSession[]>((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, 'readonly');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.getAll();
      req.onsuccess = () => {
        const all = (req.result as ChatSession[]) || [];
        const filtered = all.filter((s) => {
          const owner = (s.userEmail || 'guest').trim().toLowerCase();
          return owner === normalizedEmail;
        });
        filtered.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(filtered);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('IndexedDB load error:', err);
    return [];
  }
}

async function putLocalSession(session: ChatSession): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, 'readwrite');
      const store = tx.objectStore(STORE_SESSIONS);
      const sanitized: ChatSession = {
        ...session,
        messages: session.messages.map((m) => ({
          ...m,
          isStreaming: false,
        })),
      };
      const req = store.put(sanitized);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('IndexedDB save error:', err);
  }
}

export async function getAllSessions(userEmail?: string): Promise<ChatSession[]> {
  const normalizedEmail = (userEmail || 'guest').trim().toLowerCase();
  const localSessions = await getLocalSessionsByEmail(normalizedEmail);

  if (normalizedEmail === 'guest') {
    return localSessions;
  }

  // Merge local IndexedDB sessions with server-persisted and Firestore sessions for this email
  const mergedMap = new Map<string, ChatSession>();
  for (const s of localSessions) {
    mergedMap.set(s.id, { ...s, userEmail: normalizedEmail });
  }

  try {
    const resp = await fetch(
      `/api/account/sessions?email=${encodeURIComponent(normalizedEmail)}`
    );
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data.sessions)) {
        for (const s of data.sessions as ChatSession[]) {
          if (!s || !s.id) continue;
          const existing = mergedMap.get(s.id);
          if (!existing || (s.updatedAt || 0) > (existing.updatedAt || 0)) {
            mergedMap.set(s.id, { ...s, userEmail: normalizedEmail });
          }
        }
      }
    }
  } catch {
    // ignore offline fetch
  }

  try {
    const cloudSessions = await loadSessionsFromFirestore(normalizedEmail);
    for (const s of cloudSessions) {
      if (!s || !s.id) continue;
      const existing = mergedMap.get(s.id);
      if (!existing || (s.updatedAt || 0) > (existing.updatedAt || 0)) {
        mergedMap.set(s.id, { ...s, userEmail: normalizedEmail });
      }
    }
  } catch {
    // ignore cloud error
  }

  const finalSessions = Array.from(mergedMap.values()).sort(
    (a, b) => b.updatedAt - a.updatedAt
  );

  // Ensure local IndexedDB has all merged sessions
  for (const s of finalSessions) {
    await putLocalSession(s);
  }

  return finalSessions;
}

export async function saveSession(
  session: ChatSession,
  userEmail?: string
): Promise<void> {
  const normalizedEmail = (userEmail || session.userEmail || 'guest').trim().toLowerCase();
  const taggedSession: ChatSession = {
    ...session,
    userEmail: normalizedEmail,
    messages: session.messages.map((m) => ({
      ...m,
      isStreaming: false,
    })),
  };

  await putLocalSession(taggedSession);

  if (normalizedEmail !== 'guest') {
    // Sync to server-side per-email persistence
    fetch('/api/account/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: normalizedEmail,
        session: taggedSession,
      }),
    }).catch(() => {
      // ignore network error
    });

    // Sync to Firestore if Firebase Auth user is active
    syncSessionToFirestore(taggedSession, normalizedEmail).catch(() => {
      // ignore
    });
  }
}

export async function deleteSessionById(
  id: string,
  userEmail?: string
): Promise<void> {
  const normalizedEmail = (userEmail || 'guest').trim().toLowerCase();
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, 'readwrite');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('IndexedDB delete error:', err);
  }

  if (normalizedEmail !== 'guest') {
    fetch(
      `/api/account/sessions/${encodeURIComponent(id)}?email=${encodeURIComponent(
        normalizedEmail
      )}`,
      { method: 'DELETE' }
    ).catch(() => {
      // ignore
    });

    deleteSessionFromFirestore(id).catch(() => {
      // ignore
    });
  }
}
