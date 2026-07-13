// IndexedDB-backed replay library. Two object stores in one DB:
//   meta  — ReplayMeta rows (header + bookkeeping), keyPath "id"
//   blobs — the whole .szr container Blob per id (export/import is a
//           pass-through of these bytes, never a re-encode)
//
// Retention: the newest MAX_REPLAYS unpinned replays are kept; saving beyond
// that evicts the oldest unpinned. Pinned replays never count and never age
// out. localStorage stays for tiny prefs; replays are far too big for it.

import type { ReplayHeader } from "./format";
import { readContainer } from "./format";

const DB_NAME = "sz-replays";
const DB_VERSION = 1;
export const MAX_REPLAYS = 10;

export interface ReplayMeta {
  id: string;
  header: ReplayHeader;
  sizeBytes: number;
  pinned: boolean;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("this browser has no IndexedDB — replays can't be saved"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("blobs")) {
          db.createObjectStore("blobs");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("failed to open replay store"));
    });
    // A failed open (private mode, quota) shouldn't poison later retries.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("replay store transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("replay store transaction aborted"));
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("replay store request failed"));
  });
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function saveReplay(header: ReplayHeader, blob: Blob): Promise<string> {
  const db = await openDb();
  const id = randomId();
  const meta: ReplayMeta = {
    id,
    header,
    sizeBytes: blob.size,
    pinned: false,
    savedAt: Date.now(),
  };
  const tx = db.transaction(["meta", "blobs"], "readwrite");
  tx.objectStore("meta").put(meta);
  tx.objectStore("blobs").put(blob, id);
  await done(tx);
  await evictOverCap(db);
  return id;
}

/** All replays, newest first. */
export async function listReplays(): Promise<ReplayMeta[]> {
  const db = await openDb();
  const tx = db.transaction("meta", "readonly");
  const all = await result(tx.objectStore("meta").getAll() as IDBRequest<ReplayMeta[]>);
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function getReplayMeta(id: string): Promise<ReplayMeta | null> {
  const db = await openDb();
  const tx = db.transaction("meta", "readonly");
  return (
    (await result(tx.objectStore("meta").get(id) as IDBRequest<ReplayMeta | undefined>)) ??
    null
  );
}

export async function getReplayBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  const tx = db.transaction("blobs", "readonly");
  return (
    (await result(tx.objectStore("blobs").get(id) as IDBRequest<Blob | undefined>)) ?? null
  );
}

export async function deleteReplay(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["meta", "blobs"], "readwrite");
  tx.objectStore("meta").delete(id);
  tx.objectStore("blobs").delete(id);
  await done(tx);
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("meta", "readwrite");
  const store = tx.objectStore("meta");
  const meta = await result(store.get(id) as IDBRequest<ReplayMeta | undefined>);
  if (meta) {
    meta.pinned = pinned;
    store.put(meta);
  }
  await done(tx);
}

/**
 * Validate and store an uploaded .szr file. Round-trips the whole container
 * (header + decompression + frame parse) so corrupt files are rejected here,
 * not when someone hits play.
 */
export async function importReplayFile(file: Blob): Promise<string> {
  const { header } = await readContainer(file);
  return saveReplay(header, file);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}

async function evictOverCap(db: IDBDatabase): Promise<void> {
  const tx = db.transaction("meta", "readonly");
  const all = await result(tx.objectStore("meta").getAll() as IDBRequest<ReplayMeta[]>);
  const unpinned = all.filter((m) => !m.pinned).sort((a, b) => a.savedAt - b.savedAt);
  const excess = unpinned.length - MAX_REPLAYS;
  for (let i = 0; i < excess; i++) {
    await deleteReplay(unpinned[i].id);
  }
}
