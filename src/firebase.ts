import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import { ChatSession, UserAccount } from './types';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Validate connection to Firestore on boot as required by firebase-integration-rpc
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

// Blueprint validation constants (synced verbatim with firebase-blueprint.json & firestore.rules)
export const USER_ID_PATTERN = /^[a-zA-Z0-9_\-]+$/;
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = 60;
export const SESSION_TITLE_MAX_LENGTH = 200;
export const MESSAGES_SUMMARY_MAX_LENGTH = 850000;

function sanitizeIdForFirestore(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_\-]/g, '-').slice(0, 128);
  return cleaned || 'default-id';
}

function serializeMessagesForFirestore(session: ChatSession): string {
  const compactMessages = session.messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
    mode: m.mode,
    sources: m.sources,
    error: m.error,
    attachments: m.attachments?.map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      mimeType: a.mimeType,
      categoryLabel: a.categoryLabel,
      kind: a.kind,
      extractedText:
        a.extractedText && a.extractedText.length < 30000 ? a.extractedText : undefined,
      base64Data:
        a.base64Data && a.base64Data.length < 150000 ? a.base64Data : undefined,
    })),
    generatedMedia: m.generatedMedia
      ? {
          type: m.generatedMedia.type,
          mimeType: m.generatedMedia.mimeType,
          prompt: m.generatedMedia.prompt,
          lyrics: m.generatedMedia.lyrics,
          aspectRatio: m.generatedMedia.aspectRatio,
          imageSize: m.generatedMedia.imageSize,
          duration: m.generatedMedia.duration,
          modelUsed: m.generatedMedia.modelUsed,
          base64Data:
            m.generatedMedia.base64Data && m.generatedMedia.base64Data.length < 250000
              ? m.generatedMedia.base64Data
              : undefined,
          uri: m.generatedMedia.uri,
        }
      : undefined,
  }));

  let json = JSON.stringify(compactMessages);
  if (json.length > MESSAGES_SUMMARY_MAX_LENGTH) {
    // Strip base64 payloads if total serialized array exceeds Firestore document budget
    const textOnly = compactMessages.map((m) => ({
      ...m,
      attachments: m.attachments?.map((a) => ({ ...a, base64Data: undefined })),
      generatedMedia: m.generatedMedia
        ? { ...m.generatedMedia, base64Data: undefined }
        : undefined,
    }));
    json = JSON.stringify(textOnly);
  }
  if (json.length > MESSAGES_SUMMARY_MAX_LENGTH) {
    json = json.slice(0, MESSAGES_SUMMARY_MAX_LENGTH);
  }
  return json;
}

export async function ensureFirestoreUserProfile(account: UserAccount): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== account.uid) return;

  const uid = sanitizeIdForFirestore(currentUser.uid);
  const userPath = `users/${uid}`;
  const userRef = doc(db, 'users', uid);

  const safeEmail = account.email.trim().toLowerCase().slice(0, 254);
  const safeUsername = account.username
    .trim()
    .slice(0, USERNAME_MAX_LENGTH)
    .padEnd(USERNAME_MIN_LENGTH, '_');

  try {
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      await setDoc(userRef, {
        ownerId: uid,
        email: safeEmail,
        username: safeUsername,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else if (snap.data()?.username !== safeUsername) {
      await updateDoc(userRef, {
        username: safeUsername,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    try {
      handleFirestoreError(err, OperationType.WRITE, userPath);
    } catch {
      // Non-fatal fallback to server/IndexedDB store
    }
  }
}

export async function syncSessionToFirestore(
  session: ChatSession,
  userEmail: string
): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) return;

  const uid = sanitizeIdForFirestore(currentUser.uid);
  const sessionId = sanitizeIdForFirestore(session.id);
  const sessionPath = `users/${uid}/sessions/${sessionId}`;
  const sessionRef = doc(db, 'users', uid, 'sessions', sessionId);

  const safeTitle = (session.title || 'New conversation')
    .trim()
    .slice(0, SESSION_TITLE_MAX_LENGTH) || 'New conversation';
  const safeEmail = userEmail.trim().toLowerCase().slice(0, 254);
  const messagesSummary = serializeMessagesForFirestore(session);
  const messageCount = Math.min(5000, Math.max(0, session.messages.length));

  try {
    const existingSnap = await getDoc(sessionRef);
    if (!existingSnap.exists()) {
      await setDoc(sessionRef, {
        id: sessionId,
        ownerId: uid,
        userEmail: safeEmail,
        title: safeTitle,
        messageCount,
        messagesSummary,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(sessionRef, {
        title: safeTitle,
        messageCount,
        messagesSummary,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    try {
      handleFirestoreError(err, OperationType.WRITE, sessionPath);
    } catch {
      // Non-fatal fallback to server/IndexedDB store
    }
  }
}

export async function deleteSessionFromFirestore(rawSessionId: string): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) return;

  const uid = sanitizeIdForFirestore(currentUser.uid);
  const sessionId = sanitizeIdForFirestore(rawSessionId);
  const sessionPath = `users/${uid}/sessions/${sessionId}`;
  const sessionRef = doc(db, 'users', uid, 'sessions', sessionId);

  try {
    const snap = await getDoc(sessionRef);
    if (snap.exists()) {
      await deleteDoc(sessionRef);
    }
  } catch (err) {
    try {
      handleFirestoreError(err, OperationType.DELETE, sessionPath);
    } catch {
      // Non-fatal
    }
  }
}

export async function loadSessionsFromFirestore(
  userEmail: string
): Promise<ChatSession[]> {
  const currentUser = auth.currentUser;
  if (!currentUser) return [];

  const uid = sanitizeIdForFirestore(currentUser.uid);
  const sessionsPath = `users/${uid}/sessions`;
  try {
    const q = query(
      collection(db, 'users', uid, 'sessions'),
      where('ownerId', '==', uid)
    );
    const snap = await getDocs(q);
    const loaded: ChatSession[] = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      try {
        const parsedMessages = JSON.parse(data.messagesSummary || '[]');
        loaded.push({
          id: data.id || docSnap.id,
          title: data.title || 'New conversation',
          createdAt: data.createdAt?.toMillis?.() || Date.now(),
          updatedAt: data.updatedAt?.toMillis?.() || Date.now(),
          messages: Array.isArray(parsedMessages) ? parsedMessages : [],
          userEmail: data.userEmail || userEmail,
        });
      } catch {
        // ignore malformed summary
      }
    });
    loaded.sort((a, b) => b.updatedAt - a.updatedAt);
    return loaded;
  } catch (err) {
    try {
      handleFirestoreError(err, OperationType.LIST, sessionsPath);
    } catch {
      return [];
    }
  }
}

export {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  firebaseSignOut,
  updateProfile,
};
