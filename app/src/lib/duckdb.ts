/**
 * SQLite-WASM (sql.js) connection manager with OPFS persistence.
 *
 * Persistence strategy (ordered by preference):
 *   1. OPFS (Origin Private File System) — real disk file, fastest
 *   2. IndexedDB fallback — when OPFS is unavailable
 *
 * The SQLite database is serialized to a binary blob and written to
 * a file in the origin-private file system. On startup the file is
 * read and restored into sql.js.
 */

import initSqlJs, { type Database } from 'sql.js';

const DB_FILENAME = 'flowscope.sqlite';
const IDB_DB_NAME = 'flowscope-sqlite';
const IDB_STORE_NAME = 'database';
const IDB_KEY = 'main';

let db: Database | null = null;
let initPromise: Promise<Database> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let useOPFS = false;

// ── OPFS helpers ─────────────────────────────────────────────────────

async function opfsAvailable(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return false;
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

async function loadFromOPFS(): Promise<Uint8Array | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(DB_FILENAME);
    const file = await fileHandle.getFile();
    if (file.size === 0) return null;
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null; // file doesn't exist yet
  }
}

async function saveToOPFS(data: Uint8Array): Promise<void> {
  const root = await navigator.storage.getDirectory();
  // Atomic write: write to a temp file first, then move to the real file.
  // createWritable truncates on open — if the write fails mid-stream, the
  // existing data is lost forever. Using a temp+rename pattern avoids this.
  const tmpName = `${DB_FILENAME}.tmp`;
  let tmpHandle: FileSystemFileHandle;
  try {
    tmpHandle = await root.getFileHandle(tmpName, { create: true });
    const writable = await (tmpHandle as FileSystemFileHandle & {
      createWritable: () => Promise<WritableStream>;
    }).createWritable();
    const writer = writable.getWriter();
    await writer.write(data);
    await writer.close();
  } catch (e) {
    // Clean up temp file on write failure
    try { await root.removeEntry(tmpName); } catch (_) { /* best effort */ }
    throw e;
  }

  // Rename temp → real.  We try in-place swap: remove the old real file,
  // then move the temp file to that name.  If move() is unavailable we fall
  // back to a copy-then-remove (still safe because the temp copy is complete).
  let moved = false;
  const tmpMove = tmpHandle as FileSystemFileHandle & {
    move?: (newName: string) => Promise<void>;
  };
  if (typeof tmpMove.move === 'function') {
    try {
      await root.removeEntry(DB_FILENAME);
    } catch (_) {
      /* file may not exist yet — that's fine */
    }
    try {
      await tmpMove.move(DB_FILENAME);
      moved = true;
    } catch (e) {
      console.warn('[sqlite] OPFS move() failed, falling back to copy:', e);
    }
  }

  if (!moved) {
    const tempFile = await tmpHandle.getFile();
    const tempBuf = await tempFile.arrayBuffer();
    const realHandle = await root.getFileHandle(DB_FILENAME, { create: true });
    const writable = await (realHandle as FileSystemFileHandle & {
      createWritable: () => Promise<WritableStream>;
    }).createWritable();
    const writer = writable.getWriter();
    await writer.write(new Uint8Array(tempBuf));
    await writer.close();
    await root.removeEntry(tmpName);
  }
}

// ── IndexedDB fallback ───────────────────────────────────────────────

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(IDB_STORE_NAME)) {
        idb.createObjectStore(IDB_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadFromIDB(): Promise<Uint8Array | null> {
  try {
    const idb = await openIDB();
    const tx = idb.transaction(IDB_STORE_NAME, 'readonly');
    const store = tx.objectStore(IDB_STORE_NAME);
    const getReq = store.get(IDB_KEY);
    return new Promise((resolve, reject) => {
      getReq.onsuccess = () => resolve(getReq.result ?? null);
      getReq.onerror = () => reject(getReq.error);
    });
  } catch {
    return null;
  }
}

async function saveToIDB(data: Uint8Array): Promise<void> {
  const idb = await openIDB();
  const tx = idb.transaction(IDB_STORE_NAME, 'readwrite');
  const store = tx.objectStore(IDB_STORE_NAME);
  store.put(data, IDB_KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── unified load / save ──────────────────────────────────────────────

async function loadDbBytes(): Promise<Uint8Array | null> {
  if (useOPFS) {
    const data = await loadFromOPFS();
    if (data) return data;
  }
  // Fallback or primary: IndexedDB
  return loadFromIDB();
}

async function saveDbBytes(data: Uint8Array): Promise<void> {
  let opfsFail: unknown = null;
  if (useOPFS) {
    try {
      await saveToOPFS(data);
      return;
    } catch (error) {
      opfsFail = error;
      console.warn('[sqlite] OPFS write failed, falling back to IndexedDB:', error);
    }
  }
  try {
    await saveToIDB(data);
  } catch (idbError) {
    console.error('[sqlite] IndexedDB write also failed:', idbError, 'OPFS error was:', opfsFail);
    throw new Error(`数据库持久化失败: OPFS=${opfsFail ?? 'skipped'}, IDB=${idbError}`);
  }
}

// ── init ─────────────────────────────────────────────────────────────

/** Delete persisted DB from both OPFS and IndexedDB. */
async function deleteSavedDb(): Promise<void> {
  if (useOPFS) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(DB_FILENAME);
      await root.removeEntry(`${DB_FILENAME}.tmp`);
    } catch { /* ignore — file may not exist */ }
  }
  try {
    const idb = await openIDB();
    const tx = idb.transaction(IDB_STORE_NAME, 'readwrite');
    const store = tx.objectStore(IDB_STORE_NAME);
    store.delete(IDB_KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

async function init(): Promise<Database> {
  // Detect OPFS support
  useOPFS = await opfsAvailable();
  console.log(`[sqlite] Storage backend: ${useOPFS ? 'OPFS (disk)' : 'IndexedDB'}`);

  const base = import.meta.env.BASE_URL || './';
  const SQL = await initSqlJs({
    locateFile: () => `${base}sql.js/sql-wasm.wasm`,
  });

  // Restore from persistent storage — with corruption recovery
  const saved = await loadDbBytes();
  if (saved) {
    try {
      db = new SQL.Database(saved);
      // sql.js Database constructor does NOT validate the binary on load.
      // Corrupted bytes are loaded silently and only fail on first query.
      const check = db.exec('PRAGMA integrity_check');
      const ok = check.length > 0 && check[0]?.values?.[0]?.[0] === 'ok';
      if (!ok) {
        const detail = check[0]?.values?.map((r: unknown[]) => r[0]).join('; ') || 'unknown error';
        console.warn(`[sqlite] Integrity check failed: ${detail} — starting fresh`);
        db.close();
        await deleteSavedDb();
        db = new SQL.Database();
      }
    } catch (e) {
      console.warn('[sqlite] Restored database is corrupted — deleting and starting fresh:', e);
      await deleteSavedDb();
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode = MEMORY');
  db.run('PRAGMA synchronous = OFF');

  // ── schema ─────────────────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS project_files (
      project_id TEXT NOT NULL,
      file_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      path       TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      language   TEXT NOT NULL DEFAULT 'sql',
      PRIMARY KEY (project_id, file_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS schema_files (
      project_id TEXT NOT NULL,
      file_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      path       TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (project_id, file_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS analysis_cache (
      cache_key        TEXT PRIMARY KEY,
      result_json      TEXT NOT NULL,
      size_bytes       INTEGER NOT NULL,
      created_at       INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS project_file_results (
      project_id   TEXT NOT NULL,
      file_path    TEXT NOT NULL,
      result_json  TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, file_path)
    )
  `);

  // ── 血缘结构化表 ───────────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS lineage_statements (
      project_id       TEXT NOT NULL,
      file_path        TEXT NOT NULL,
      statement_index  INTEGER NOT NULL,
      statement_type   TEXT NOT NULL,
      source_name      TEXT,
      sql_text         TEXT,
      join_count       INTEGER NOT NULL DEFAULT 0,
      complexity_score INTEGER NOT NULL DEFAULT 0,
      updated_at       INTEGER NOT NULL,
      PRIMARY KEY (project_id, file_path, statement_index)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS lineage_nodes (
      project_id        TEXT NOT NULL,
      file_path         TEXT NOT NULL,
      node_id           TEXT NOT NULL,
      node_type         TEXT NOT NULL,
      label             TEXT NOT NULL,
      qualified_name    TEXT,
      statement_index   INTEGER NOT NULL,
      resolution_source TEXT,
      PRIMARY KEY (project_id, file_path, node_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS lineage_columns (
      project_id      TEXT NOT NULL,
      file_path       TEXT NOT NULL,
      column_id       TEXT NOT NULL,
      label           TEXT NOT NULL,
      qualified_name  TEXT,
      parent_node_id  TEXT,
      expression      TEXT,
      statement_index INTEGER NOT NULL,
      PRIMARY KEY (project_id, file_path, column_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS lineage_edges (
      project_id      TEXT NOT NULL,
      file_path       TEXT NOT NULL,
      edge_id         TEXT NOT NULL,
      from_id         TEXT NOT NULL,
      to_id           TEXT NOT NULL,
      edge_type       TEXT NOT NULL,
      expression      TEXT,
      statement_index INTEGER,
      PRIMARY KEY (project_id, file_path, edge_id)
    )
  `);

  // ── 源表→目标表映射 ─────────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS lineage_table_flows (
      project_id   TEXT NOT NULL,
      file_path    TEXT NOT NULL,
      source_table TEXT NOT NULL,
      target_table TEXT NOT NULL,
      PRIMARY KEY (project_id, file_path, source_table, target_table)
    )
  `);

  // ── Schema 解析结果 ─────────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS schema_tables (
      project_id   TEXT NOT NULL,
      table_name   TEXT NOT NULL,
      catalog      TEXT,
      schema_name  TEXT,
      short_name   TEXT NOT NULL,
      origin       TEXT,
      is_temporary INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, table_name)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS schema_columns (
      project_id     TEXT NOT NULL,
      table_name     TEXT NOT NULL,
      column_name    TEXT NOT NULL,
      data_type      TEXT,
      is_primary_key INTEGER NOT NULL DEFAULT 0,
      fk_table       TEXT,
      fk_column      TEXT,
      PRIMARY KEY (project_id, table_name, column_name)
    )
  `);

  // ── 层级信息 ───────────────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS lineage_hierarchy (
      project_id     TEXT NOT NULL,
      node_id        TEXT NOT NULL,
      node_type      TEXT NOT NULL,
      label          TEXT NOT NULL,
      qualified_name TEXT,
      parent_id      TEXT,
      depth          INTEGER NOT NULL DEFAULT 0,
      statement_refs TEXT,
      PRIMARY KEY (project_id, node_id)
    )
  `);

  await persistNow();

  return db;
}

// ── public API ───────────────────────────────────────────────────────

/**
 * Get the shared SQLite database instance. Initializes on first call.
 */
export async function getDb(): Promise<Database> {
  if (db) return db;
  if (!initPromise) {
    initPromise = init();
  }
  return initPromise;
}

/**
 * Debounced persist — schedules a flush within 500ms.
 * Multiple calls within the window are coalesced.
 */
export function persist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 500);
}

/** Runtime flag: when true, `persistNow` becomes a no-op to avoid frequent large writes. */
export let __FLOWSCOPE_DEFER_PERSIST = false;

/** Immediately flush the SQLite database to disk (OPFS) or IndexedDB. No-op when defer flag is set. */
export async function persistNow(): Promise<void> {
  if (!db) return;
  if ((globalThis as any).__FLOWSCOPE_DEFER_PERSIST) return;
  const data = db.export();
  await saveDbBytes(data);
}

/** Force a flush regardless of the defer flag. */
export async function flushPersistNow(): Promise<void> {
  if (!db) return;
  let data: Uint8Array;
  try {
    data = db.export();
  } catch (e) {
    console.error('[sqlite] db.export() failed (database may be corrupted):', e);
    throw new Error('数据库已损坏，请重新加载页面。');
  }
  await saveDbBytes(data);
}

/** Returns the current storage backend name. */
export function getStorageBackend(): string {
  return useOPFS ? 'OPFS (disk)' : 'IndexedDB';
}

// Flush on page hide (visibilitychange), NOT on beforeunload.
// beforeunload is fire-and-forget async — the page may unload before OPFS write
// completes, corrupting the database file on disk.
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && db) {
      const data = db.export();
      saveDbBytes(data).catch((e) =>
        console.warn('[sqlite] visibilitychange flush failed:', e)
      );
    }
  });

  // Safety net: on unload, write directly to IndexedDB (which completes
  // synchronously enough in Chrome to survive page teardown).  This only
  // matters if visibilitychange didn't fire (e.g. browser crash, force quit).
  window.addEventListener('beforeunload', () => {
    if (db) {
      const data = db.export();
      // Fire-and-forget to IDB — we can't await, but IDB writes are durable
      // in Chrome even during unload.
      saveToIDB(data).catch(() => {});
    }
  });
}

// ── shared helpers ───────────────────────────────────────────────────

/** Escape single quotes for SQL string literals */
export function esc(s: string): string {
  return s.replace(/'/g, "''");
}
