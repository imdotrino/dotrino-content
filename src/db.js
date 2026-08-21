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
        thumbnailCid TEXT,
        meta         TEXT               -- JSON de presentación: { name, title, description }
      );
      CREATE TABLE IF NOT EXISTS egress (
        day   TEXT PRIMARY KEY,         -- YYYY-MM-DD (UTC)
        bytes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_blobs_ttl ON blobs (ttl) WHERE ttl IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_blobs_gc  ON blobs (pinned, createdAt);
      CREATE INDEX IF NOT EXISTS idx_blobs_acl ON blobs (acl, createdAt);
    `)
    // Migración de un índice creado antes de que existiera `meta`: añadir la
    // columna a una base ya escrita en disco. `ADD COLUMN` con default NULL es
    // barato y no reescribe la tabla; si ya está, SQLite tira y se ignora.
    try { this.db.exec('ALTER TABLE blobs ADD COLUMN meta TEXT') } catch (_) { /* ya existía */ }
  }

  upsert ({ cid, size, mime, owner = null, enc = 0, acl = null, ttl = null, meta = null }) {
    this.db.prepare(`
      INSERT INTO blobs (cid, size, mime, createdAt, owner, enc, acl, ttl, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (cid) DO UPDATE SET
        mime = excluded.mime,
        ttl  = excluded.ttl,
        -- Volver a subir los mismos bytes NO borra la presentación que ya tenían.
        meta = COALESCE(excluded.meta, blobs.meta)
    `).run(cid, size, mime, Date.now(), owner, enc ? 1 : 0, acl, ttl, meta ? JSON.stringify(meta) : null)
  }

  get (cid) {
    return this.db.prepare('SELECT * FROM blobs WHERE cid = ?').get(cid) ?? null
  }

  list () {
    return this.db.prepare(
      'SELECT cid, size, mime, createdAt, owner, enc, acl, ttl, pinned, meta FROM blobs ORDER BY createdAt DESC'
    ).all()
  }

  /**
   * Cambia el `acl` de un blob (`public` | `private`). Devuelve false si no existe.
   * Se cambia aparte del `upsert` a propósito: volver a subir los mismos bytes NO
   * debe reabrir ni cerrar un blob por accidente.
   */
  setAcl (cid, acl) {
    const { changes } = this.db.prepare('UPDATE blobs SET acl = ? WHERE cid = ?').run(acl, cid)
    return changes > 0
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

  /**
   * Metadatos de PRESENTACIÓN de un blob (nombre, título, descripción): lo único
   * que la vista previa pública (§7.3) tiene para armar la tarjeta. Se guarda
   * aparte de los bytes porque no forma parte del `cid` — dos nombres distintos
   * para el mismo archivo son el mismo blob.
   * @param {string} cid
   * @param {{name?:string,title?:string,description?:string}|null} meta
   */
  setMeta (cid, meta) {
    const { changes } = this.db.prepare('UPDATE blobs SET meta = ? WHERE cid = ?')
      .run(meta ? JSON.stringify(meta) : null, cid)
    return changes > 0
  }

  /**
   * Enlaza la MINIATURA de un blob (otro blob, con su propio `cid`). El node no
   * genera miniaturas: las hace la app al subir —el aparato pone el trabajo, que
   * es el patrón del ecosistema— y aquí solo se anota cuál es.
   */
  setThumbnail (cid, thumbnailCid) {
    const { changes } = this.db.prepare('UPDATE blobs SET thumbnailCid = ? WHERE cid = ?')
      .run(thumbnailCid, cid)
    return changes > 0
  }

  /**
   * Blobs servibles al mundo: `acl = public` y EN CLARO. Un blob cifrado no sale
   * por aquí ni marcado público (ops.js ya lo impide al marcarlo, esto es el
   * segundo cerrojo, en el sitio donde los bytes de verdad salen).
   */
  listPublic ({ limit = 100, offset = 0 } = {}) {
    return this.db.prepare(`
      SELECT cid, size, mime, createdAt, meta FROM blobs
      WHERE acl = 'public' AND enc = 0
      ORDER BY createdAt DESC LIMIT ? OFFSET ?
    `).all(limit, offset)
  }

  /**
   * Contabilidad de EGRESS del modo público (§7.2), por día UTC y persistida: un
   * techo que se reinicia con el proceso no es un techo — el reinicio es
   * exactamente lo que pasa cuando algo se descontrola.
   * @param {number} bytes @param {string} day YYYY-MM-DD
   */
  addEgress (bytes, day) {
    if (!(bytes > 0)) return
    this.db.prepare(`
      INSERT INTO egress (day, bytes) VALUES (?, ?)
      ON CONFLICT (day) DO UPDATE SET bytes = bytes + excluded.bytes
    `).run(day, Math.round(bytes))
  }

  /** Bytes servidos ese día. @returns {number} */
  egressOn (day) {
    return Number(this.db.prepare('SELECT COALESCE(bytes, 0) AS n FROM egress WHERE day = ?').get(day)?.n || 0)
  }

  close () {
    this.db.close()
  }
}
