/* ============================================================
   db.js — minimal promise-based IndexedDB wrapper.

   Stores (v3):
     videos    metadata only: { id, title, createdAt, duration, mode,
                                trimStart, trimEnd, thumbnail, notes, views,
                                mimeType }
     blobs     { id, blob }  — the heavy payload, kept out of `videos` so that
                               metadata writes (title, view counter) never
                               rewrite hundreds of megabytes.
     recovery  { key, ... }  — in-progress recording chunks + session meta,
                               so a crash or a closed tab does not lose a take.
                               key = `<sessionId>#meta` | `<sessionId>#<seq>`
     backgrounds { id, name, blob, createdAt } — images the user added for
                               the Studio backdrop (see backgrounds.js).
   ============================================================ */

const PenguDB = (() => {
  const DB_NAME = 'pengu-recorder';
  const LEGACY_DB = 'loom-clone';   // name used before the project was renamed
  const MIGRATED_FLAG = 'pengu-recorder:legacy-imported';
  const DB_VERSION = 3;
  const VIDEOS = 'videos';
  const BLOBS = 'blobs';
  const RECOVERY = 'recovery';
  const BACKGROUNDS = 'backgrounds';

  let dbPromise = null;
  let readyPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = req.result;
        const upgradeTx = req.transaction;

        if (!db.objectStoreNames.contains(VIDEOS)) {
          db.createObjectStore(VIDEOS, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains(BLOBS)) {
          db.createObjectStore(BLOBS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(RECOVERY)) {
          db.createObjectStore(RECOVERY, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(BACKGROUNDS)) {
          db.createObjectStore(BACKGROUNDS, { keyPath: 'id' });
        }

        // v1 -> v2: lift inline blobs out of the video records.
        if (event.oldVersion > 0 && event.oldVersion < 2) {
          const videos = upgradeTx.objectStore(VIDEOS);
          const blobs = upgradeTx.objectStore(BLOBS);
          videos.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const rec = cursor.value;
            if (rec && rec.blob) {
              blobs.put({ id: rec.id, blob: rec.blob });
              delete rec.blob;
              cursor.update(rec);
            }
            cursor.continue();
          };
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  /* Run `fn(stores…)` in one transaction; resolve with whatever the last
     IDBRequest produced (or with `fn`'s own return value if it is not one). */
  async function run(storeNames, mode, fn) {
    const db = await ready();
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new Promise((resolve, reject) => {
      const t = db.transaction(names, mode);
      const stores = names.map((n) => t.objectStore(n));
      let out;
      try {
        out = fn(...stores);
      } catch (err) {
        reject(err);
        return;
      }
      t.oncomplete = () => {
        resolve(out instanceof IDBRequest ? out.result : out);
      };
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    });
  }

  /* ----------------------------------------------------------
     One-time import from the pre-rename database.

     Early versions stored everything under `loom-clone`. Renaming the project
     must not orphan somebody's library, so the first run copies every record
     across and only then drops the old database. A partial copy keeps the old
     one: losing a recording is worse than leaving a stale database behind.
     ---------------------------------------------------------- */
  async function migrateFromLegacy() {
    try {
      if (localStorage.getItem(MIGRATED_FLAG)) return;
      if (!indexedDB.databases) return;  // no way to probe without creating it
      const names = (await indexedDB.databases()).map((d) => d.name);
      if (!names.includes(LEGACY_DB)) {
        localStorage.setItem(MIGRATED_FLAG, '1');
        return;
      }

      const legacy = await new Promise((resolve, reject) => {
        const req = indexedDB.open(LEGACY_DB);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('legacy database is open elsewhere'));
      });
      const stores = Array.from(legacy.objectStoreNames);
      const readAll = (store) => new Promise((resolve) => {
        if (!stores.includes(store)) { resolve([]); return; }
        const req = legacy.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
      const videos = await readAll(VIDEOS);
      const blobs = await readAll(BLOBS);
      legacy.close();

      const db = await openDb();
      let copied = 0;
      for (const video of videos) {
        const meta = { ...video };
        const inline = meta.blob;           // v1 of the old database kept it here
        delete meta.blob;
        const row = blobs.find((b) => b.id === video.id);
        const blob = inline || (row && row.blob) || null;
        await new Promise((resolve, reject) => {
          const t = db.transaction([VIDEOS, BLOBS], 'readwrite');
          t.objectStore(VIDEOS).put(meta);
          if (blob) t.objectStore(BLOBS).put({ id: meta.id, blob });
          t.oncomplete = resolve;
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        });
        copied += 1;
      }

      if (copied === videos.length) {
        localStorage.setItem(MIGRATED_FLAG, '1');
        indexedDB.deleteDatabase(LEGACY_DB);
      }
    } catch {
      // Import is best effort: a failure must never block the app from opening.
    }
  }

  function ready() {
    if (!readyPromise) {
      readyPromise = migrateFromLegacy().catch(() => {}).then(openDb);
    }
    return readyPromise;
  }

  /* ---------------- videos + blobs ---------------- */

  /** Save metadata and (optionally) the video blob in one transaction. */
  async function save(meta, blob) {
    const record = { ...meta };
    delete record.blob; // never let a blob sneak into the metadata store
    if (blob) {
      return run([VIDEOS, BLOBS], 'readwrite', (videos, blobs) => {
        videos.put(record);
        blobs.put({ id: record.id, blob });
      });
    }
    return run(VIDEOS, 'readwrite', (videos) => videos.put(record));
  }

  /** Patch a few metadata fields without touching the blob. */
  async function patch(id, changes) {
    return run(VIDEOS, 'readwrite', (videos) => {
      const req = videos.get(id);
      req.onsuccess = () => {
        if (req.result) videos.put({ ...req.result, ...changes });
      };
    });
  }

  /** All metadata records, newest first. */
  async function getAll() {
    const items = await run(VIDEOS, 'readonly', (videos) => videos.getAll());
    return (items || []).sort((a, b) => b.createdAt - a.createdAt);
  }

  async function get(id) {
    const rec = await run(VIDEOS, 'readonly', (videos) => videos.get(id));
    return rec || null;
  }

  async function getBlob(id) {
    const rec = await run(BLOBS, 'readonly', (blobs) => blobs.get(id));
    return rec ? rec.blob : null;
  }

  async function remove(id) {
    return run([VIDEOS, BLOBS], 'readwrite', (videos, blobs) => {
      videos.delete(id);
      blobs.delete(id);
    });
  }

  /* ---------------- crash recovery ---------------- */

  const chunkKey = (sessionId, seq) => `${sessionId}#${String(seq).padStart(6, '0')}`;
  const metaKey = (sessionId) => `${sessionId}#meta`;

  async function startSession(sessionId, meta) {
    return run(RECOVERY, 'readwrite', (store) =>
      store.put({ key: metaKey(sessionId), sessionId, ...meta }));
  }

  async function touchSession(sessionId, changes) {
    return run(RECOVERY, 'readwrite', (store) => {
      const req = store.get(metaKey(sessionId));
      req.onsuccess = () => {
        if (req.result) store.put({ ...req.result, ...changes });
      };
    });
  }

  async function appendChunk(sessionId, seq, blob) {
    return run(RECOVERY, 'readwrite', (store) =>
      store.put({ key: chunkKey(sessionId, seq), blob }));
  }

  /** Chunk blobs for a session, in write order. */
  async function getChunks(sessionId) {
    const range = IDBKeyRange.bound(`${sessionId}#`, `${sessionId}#￿`);
    const rows = await run(RECOVERY, 'readonly', (store) => store.getAll(range));
    return (rows || [])
      .filter((r) => r.blob && !r.key.endsWith('#meta'))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((r) => r.blob);
  }

  /** Session meta records that still have chunks on disk. */
  async function listSessions() {
    const rows = await run(RECOVERY, 'readonly', (store) => store.getAll());
    const metas = (rows || []).filter((r) => r.key.endsWith('#meta'));
    const counts = new Map();
    for (const r of rows || []) {
      if (r.key.endsWith('#meta')) continue;
      const id = r.key.split('#')[0];
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return metas
      .map((m) => ({ ...m, chunks: counts.get(m.sessionId) || 0 }))
      .filter((m) => m.chunks > 0)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  async function clearSession(sessionId) {
    const range = IDBKeyRange.bound(`${sessionId}#`, `${sessionId}#￿`);
    return run(RECOVERY, 'readwrite', (store) => store.delete(range));
  }

  /* ---------------- Studio backgrounds ---------------- */

  async function addBackground(record) {
    return run(BACKGROUNDS, 'readwrite', (store) => store.put(record));
  }

  /** Uploaded backgrounds, newest first. */
  async function listBackgrounds() {
    const rows = await run(BACKGROUNDS, 'readonly', (store) => store.getAll());
    return (rows || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async function getBackground(id) {
    const rec = await run(BACKGROUNDS, 'readonly', (store) => store.get(id));
    return rec ? rec.blob : null;
  }

  async function removeBackground(id) {
    return run(BACKGROUNDS, 'readwrite', (store) => store.delete(id));
  }

  /* ---------------- storage headroom ---------------- */

  /** Ask for persistent storage so the browser cannot silently evict videos. */
  async function requestPersistence() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return false;
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  /** { usage, quota, freeBytes } in bytes, or null when unsupported. */
  async function estimate() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota, freeBytes: Math.max(0, quota - usage) };
    } catch {
      return null;
    }
  }

  return {
    save, patch, getAll, get, getBlob, remove,
    startSession, touchSession, appendChunk, getChunks, listSessions, clearSession,
    addBackground, listBackgrounds, getBackground, removeBackground,
    requestPersistence, estimate,
  };
})();
