import { initializeApp, getApps, FirebaseApp } from "firebase/app";
import {
  getStorage,
  ref,
  getDownloadURL,
  listAll,
  deleteObject,
} from "firebase/storage";
import {
  initializeAuth,
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithCredential,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  Auth,
  // getReactNativePersistence ships in the firebase RN build but is absent
  // from the default type entry (known firebase v12 typing gap).
  // @ts-expect-error - resolved at runtime by Metro's react-native condition
  getReactNativePersistence,
} from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  doc,
  setDoc,
  deleteDoc,
  Firestore,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import type { Utterance } from "./transcription";
import { firebaseConfig, isFirebaseConfigured } from "../firebaseConfig";
import { logEvent } from "./log";
import { Recording } from "./types";
import {
  audioPath,
  metaPath,
  transcriptPath,
  aaiJsonPath,
  normalizeRecording,
} from "./recordings";

export { isFirebaseConfigured };

function app(): FirebaseApp {
  return getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
}

let _auth: Auth | null = null;
function auth(): Auth {
  if (_auth) return _auth;
  try {
    _auth = initializeAuth(app(), {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } catch {
    _auth = getAuth(app());
  }
  return _auth;
}

export function isSignedIn(): boolean {
  return !!auth().currentUser;
}

export function currentEmail(): string | null {
  return auth().currentUser?.email ?? null;
}

function currentUid(): string {
  const uid = auth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

export async function signIn(
  email: string,
  password: string
): Promise<void> {
  await signInWithEmailAndPassword(auth(), email.trim(), password);
}

export async function signUp(
  email: string,
  password: string
): Promise<void> {
  await createUserWithEmailAndPassword(auth(), email.trim(), password);
}

export async function signInWithGoogleIdToken(
  idToken: string
): Promise<void> {
  const cred = GoogleAuthProvider.credential(idToken);
  await signInWithCredential(auth(), cred);
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth());
}

export function subscribeAuth(
  cb: (email: string | null) => void
): () => void {
  return onAuthStateChanged(auth(), (u) => cb(u?.email ?? null));
}

async function ensureSignedIn(): Promise<void> {
  if (!auth().currentUser) {
    throw new Error("Not signed in — sign in under Settings to use cloud");
  }
}

function storage() {
  return getStorage(app());
}

let _db: Firestore | null = null;
// Firestore's default WebChannel transport is unreliable in React Native;
// force long-polling so reads/writes actually go through.
function db(): Firestore {
  if (_db) return _db;
  try {
    _db = initializeFirestore(app(), { experimentalForceLongPolling: true });
  } catch {
    _db = getFirestore(app());
  }
  return _db;
}

function remotePath(r: Recording, ext: string): string {
  return `recordings/${currentUid()}/${r.folder}/${r.base}.${ext}`;
}

/** uid-namespaced cloud path for a recording's file (for downloads). */
export function remoteObjectPath(r: Recording, ext: string): string {
  return remotePath(r, ext);
}

async function putFile(localUri: string, dest: string, contentType: string) {
  const info = await FileSystem.getInfoAsync(localUri);
  if (!info.exists) return;
  const user = auth().currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();
  // Stream the file straight from disk via the Storage REST endpoint. The old
  // path (fetch(uri).blob() → uploadBytes) loaded the WHOLE file into memory,
  // which OOM-crashed the upload for long recordings — short clips uploaded,
  // long ones were lost. uploadAsync streams natively with no size ceiling.
  const url =
    `https://firebasestorage.googleapis.com/v0/b/${firebaseConfig.storageBucket}` +
    `/o?name=${encodeURIComponent(dest)}`;
  const res = await FileSystem.uploadAsync(url, localUri, {
    httpMethod: "POST",
    // Firebase Storage REST auth uses "Firebase <idToken>", NOT "Bearer".
    headers: { Authorization: `Firebase ${token}`, "Content-Type": contentType },
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
  });
  if (res.status >= 300) {
    throw new Error(`upload ${res.status} ${String(res.body).slice(0, 120)}`);
  }
  logEvent(`upload ok ${dest.split("/").pop()} size=${info.size ?? 0}`);
}

export async function uploadRecording(r: Recording): Promise<void> {
  await ensureSignedIn();
  await putFile(audioPath(r), remotePath(r, "m4a"), "audio/mp4");
  await putFile(metaPath(r), remotePath(r, "json"), "application/json");
  await putFile(transcriptPath(r), remotePath(r, "txt"), "text/plain");
  await putFile(aaiJsonPath(r), remotePath(r, "aai.json"), "application/json");
}

export async function deleteRemoteRecording(r: Recording): Promise<void> {
  await ensureSignedIn();
  for (const ext of ["m4a", "json", "txt", "aai.json"]) {
    try {
      await deleteObject(ref(storage(), remotePath(r, ext)));
    } catch {
      /* may not exist */
    }
  }
}

export type RemoteEntry = { folder: string; base: string; jsonPath: string };

export async function listRemote(): Promise<RemoteEntry[]> {
  await ensureSignedIn();
  const root = ref(storage(), `recordings/${currentUid()}`);
  const top = await listAll(root);
  const entries: RemoteEntry[] = [];
  for (const folderRef of top.prefixes) {
    const folder = folderRef.name;
    if (folder === "_live") continue; // internal live-segment temp files
    const inside = await listAll(folderRef);
    for (const item of inside.items) {
      if (!item.name.endsWith(".json") || item.name.endsWith(".aai.json"))
        continue;
      entries.push({
        folder,
        base: item.name.replace(/\.json$/, ""),
        jsonPath: item.fullPath,
      });
    }
  }
  return entries;
}

export async function fetchRemoteMeta(jsonPath: string): Promise<Recording> {
  await ensureSignedIn();
  const url = await getDownloadURL(ref(storage(), jsonPath));
  const res = await fetch(url);
  return normalizeRecording(await res.json());
}

export async function downloadRemoteFile(
  remote: string,
  destUri: string
): Promise<boolean> {
  try {
    await ensureSignedIn();
    const url = await getDownloadURL(ref(storage(), remote));
    await FileSystem.downloadAsync(url, destUri);
    return true;
  } catch {
    return false;
  }
}

/** Returns a fetchable download URL for a storage path (AAI can read it). */
export async function downloadUrlForPath(path: string): Promise<string> {
  await ensureSignedIn();
  return getDownloadURL(ref(storage(), path));
}

// Firebase Hosting default domain for this project — used for share links.
const SHARE_BASE = `https://${firebaseConfig.projectId}.web.app/r/`;

function randomId(): string {
  const c = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < 20; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

/** Publishes a recording to a public Firestore doc; returns the share URL. */
export async function publishShare(
  rec: Recording,
  utterances: Utterance[]
): Promise<{ shareId: string; url: string }> {
  await ensureSignedIn();
  const shareId = rec.shareId || randomId();
  await setDoc(doc(db(), "shares", shareId), {
    ownerUid: currentUid(),
    base: rec.base,
    recordedAt: rec.recordedAt,
    durationSeconds: rec.durationSeconds,
    language: rec.language ?? "",
    speakers: rec.speakers ?? [],
    speakerMap: rec.speakerMap ?? null,
    topic: rec.topic ?? null,
    summary: rec.summary ?? null,
    utterances: utterances ?? [],
    createdAt: new Date().toISOString(),
  });
  return { shareId, url: SHARE_BASE + shareId };
}

export async function unpublishShare(shareId: string): Promise<void> {
  await ensureSignedIn();
  await deleteDoc(doc(db(), "shares", shareId));
}

/** Creates a live share doc up-front; returns its id + URL. */
export async function createLiveShare(meta: {
  base: string;
  speakers: string[];
  language: string;
}): Promise<{ shareId: string; url: string }> {
  await ensureSignedIn();
  const shareId = randomId();
  await setDoc(doc(db(), "shares", shareId), {
    ownerUid: currentUid(),
    createdAt: new Date().toISOString(),
    live: true,
    base: meta.base,
    speakers: meta.speakers,
    speakerMap: null,
    language: meta.language,
    topic: null,
    summary: null,
    utterances: [],
    durationSeconds: 0,
    recordedAt: new Date().toISOString(),
  });
  return { shareId, url: SHARE_BASE + shareId };
}

/** Merges new data into an existing share doc (live updates). */
export async function updateShare(
  shareId: string,
  data: Record<string, unknown>
): Promise<void> {
  await ensureSignedIn();
  await setDoc(doc(db(), "shares", shareId), data, {
    merge: true,
  });
}

export function shareUrl(shareId: string): string {
  return SHARE_BASE + shareId;
}

/** Storage path scoped to the signed-in user. */
export function userPath(rel: string): string {
  return `recordings/${currentUid()}/${rel}`;
}

export async function uploadToPath(
  localUri: string,
  dest: string
): Promise<void> {
  await ensureSignedIn();
  await putFile(localUri, dest, "audio/mp4");
}

/** Concatenates uploaded segment files into one m4a via the Cloud Function. */
export async function mergeAudioSegments(
  segments: string[],
  dest: string
): Promise<string> {
  await ensureSignedIn();
  // long timeout — merging many segments can take minutes (default is 70s).
  const fn = httpsCallable(getFunctions(app(), "us-central1"), "mergeAudio", {
    timeout: 540000,
  });
  const res: any = await fn({ segments, dest });
  return res.data.path as string;
}

export async function uploadDebugLog(text: string): Promise<void> {
  if (!isSignedIn()) return;
  // Write to a temp file and stream it up — the old Blob+uploadBytes path is
  // unreliable in RN, which is why the cloud log kept going stale.
  try {
    const tmp = `${FileSystem.cacheDirectory}debug-log.txt`;
    await FileSystem.writeAsStringAsync(tmp, text);
    await putFile(tmp, userPath("_logs/log.txt"), "text/plain");
  } catch {
    /* best-effort */
  }
}

export function liveSegmentPath(id: string, index: number): string {
  return userPath(`_live/${id}/seg${String(index).padStart(4, "0")}.m4a`);
}
export function liveMergedPath(id: string): string {
  return userPath(`_live/${id}/merged.m4a`);
}

export type ApiKeyInfo = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
};

function fn(name: string) {
  return httpsCallable(getFunctions(app(), "us-central1"), name);
}

/** Creates an API key; the raw key is returned ONCE. */
export async function createApiKey(
  label: string,
  scopes: string[]
): Promise<{ key: string; prefix: string }> {
  await ensureSignedIn();
  const res: any = await fn("createApiKey")({ label, scopes });
  return res.data;
}

export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  await ensureSignedIn();
  const res: any = await fn("listApiKeys")({});
  return res.data.keys;
}

export async function revokeApiKey(id: string): Promise<void> {
  await ensureSignedIn();
  await fn("revokeApiKey")({ id });
}
