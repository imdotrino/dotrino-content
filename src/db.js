/**
 * Índice de metadatos (Fase 1, DISENO.md §3): SQLite embebido de Node
 * (`node:sqlite`, sin dependencias). Los bytes viven en el BlobStore;
 * aquí solo `cid, size, mime, createdAt, owner, enc, acl, ttl, pinned…`.
 */
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

export class Index {
  /** @param {string} root directorio raíz de datos */
  constructor (root) {
    this.db = new DatabaseSync(path.join(root, 'index.db'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS blobs (
        cid          TEXT PRIMARY KEY,
        size         INTEGER NOT NULL,
        mime         TEXT NOT NULL DEFAULT 'application/octet-stream',
        createdAt    INTEGER NOT NULL,
        owner        TEXT,
        enc          INTEGER NOT NULL DEFAULT 0,
        acl          TEXT,
        ttl          INTEGER,            -- epoch ms de expiración (NULL = no expira)
        pinned       INTEGER NOT NULL DEFAULT 0,
        thumbnailCid TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_blobs_ttl ON blobs (ttl) WHERE ttl IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_blobs_gc  ON blobs (pinned, createdAt);
    `)
  }

  upsert ({ cid, size, mime, owner = null, enc = 0, acl = null, ttl = null }) {
    this.db.prepare(`
      INSERT INTO blobs (cid, size, mime, createdAt, owner, enc, acl, ttl)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (cid) DO UPDATE SET mime = excluded.mime, ttl = excluded.ttl
    `).run(cid, size, mime, Date.now(), owner, enc ? 1 : 0, acl, ttl)
  }

  get (cid) {
    return this.db.prepare('SELECT * FROM blobs WHERE cid = ?').get(cid) ?? null
  }

  list () {
    return this.db.prepare(
      'SELECT cid, size, mime, createdAt, enc, ttl, pinned FROM blobs ORDER BY createdAt DESC'
    ).all()
  }

  remove (cid) {
    this.db.prepare('DELETE FROM blobs WHERE cid = ?').run(cid)
  }

  setPinned (cid, pinned) {
    const { changes } = this.db.prepare('UPDATE blobs SET pinned = ? WHERE cid = ?')
      .run(pinned ? 1 : 0, cid)
    return changes > 0
  }

  /** Suma de bytes indexados. @returns {number} */
  totalBytes () {
    return Number(this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM blobs').get().n)
  }

  /** @returns {number} */
  count () {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n)
  }

  /**
   * Blobs con ttl vencido (candidatos a GC incondicional, aunque estén sin pin).
   * @returns {{ cid: string, size: number }[]}
   */
  expired (now = Date.now()) {
    return /** @type {{ cid: string, size: number }[]} */ (this.db.prepare(
      'SELECT cid, size FROM blobs WHERE ttl IS NOT NULL AND ttl <= ? AND pinned = 0'
    ).all(now))
  }

  /**
   * No-pineados más viejos primero (candidatos a GC por cuota).
   * @returns {{ cid: string, size: number }[]}
   */
  evictable () {
    return /** @type {{ cid: string, size: number }[]} */ (this.db.prepare(
      'SELECT cid, size FROM blobs WHERE pinned = 0 ORDER BY createdAt ASC'
    ).all())
  }

  close () {
    this.db.close()
  }
}
