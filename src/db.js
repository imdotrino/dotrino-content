/**
 * Índice de metadatos (Fase 1, DISENO.md §3): SQLite embebido de Node
 * (`node:sqlite`, sin dependencias). Los bytes viven en el BlobStore;
 * aquí solo `cid, size, mime, createdAt, owner, enc, acl, ttl, pinned…`.
 */
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

/** @typedef {import('./types.js').BlobRow} BlobRow */

/**
 * La primera fila de una consulta que siempre devuelve una (un agregado `AS n`).
 * @param {import('node:sqlite').StatementSync} stmt
 * @param {...import('node:sqlite').SQLInputValue} args
 * @returns {number}
 */
const scalar = (stmt, ...args) => {
  const row = stmt.get(...args)
  if (!row) throw new Error('index: an aggregate query returned no row')
  return Number(row.n)
}

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

    // Columnas de la CACHÉ (DISENO.md §15.11). Existen aunque no haya bucket: sin
    // él, `remote` se queda en 0 y `cached` en 1 para siempre, y nada cambia.
    //
    //  · `remote`   — el bucket YA CONFIRMÓ estos bytes. Se pone a 1 con la
    //                 confirmación, nunca al lanzar la subida: es el cerrojo que
    //                 impide desalojar algo cuya única copia sigue siendo esta.
    //  · `cached`   — los bytes están en el disco de esta máquina. Al desalojar se
    //                 pone a 0 y la FILA SE QUEDA: si se fuera con los bytes, el
    //                 blob quedaría en el bucket sin dueño, sin ACL y sin tipo.
    //  · `lastRead` — para desalojar por último acceso y no por antigüedad. Un
    //                 almacén ordena por edad; una caché, por uso.
    for (const col of [
      'remote INTEGER NOT NULL DEFAULT 0',
      'cached INTEGER NOT NULL DEFAULT 1',
      'lastRead INTEGER'
    ]) {
      try { this.db.exec(`ALTER TABLE blobs ADD COLUMN ${col}`) } catch (_) { /* ya existía */ }
    }
    // `tag`: de qué colección de una app es el blob, para que otro aparato la encuentre sin
    // abrir todo lo que hay (las fichas de la biblioteca, por ejemplo).
    try { this.db.exec('ALTER TABLE blobs ADD COLUMN tag TEXT') } catch (_) { /* ya existía */ }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_blobs_tag ON blobs (tag) WHERE tag IS NOT NULL')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_blobs_evict ON blobs (pinned, cached, remote, lastRead)')
  }

  /** @param {import('./types.js').UpsertInput} b */
  upsert ({ cid, size, mime, owner = null, enc = 0, acl = null, ttl = null, meta = null, tag = null }) {
    this.db.prepare(`
      INSERT INTO blobs (cid, size, mime, createdAt, owner, enc, acl, ttl, meta, tag)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (cid) DO UPDATE SET
        mime = excluded.mime,
        ttl  = excluded.ttl,
        -- Volver a subir los mismos bytes NO borra la presentación que ya tenían.
        meta = COALESCE(excluded.meta, blobs.meta),
        tag  = COALESCE(excluded.tag, blobs.tag)
    `).run(cid, size, mime, Date.now(), owner, enc ? 1 : 0, acl, ttl, meta ? JSON.stringify(meta) : null, tag)
  }

  /**
   * @param {string} cid
   * @returns {BlobRow | null}
   */
  get (cid) {
    return /** @type {BlobRow | undefined} */ (this.db.prepare('SELECT * FROM blobs WHERE cid = ?').get(cid)) ?? null
  }

  /**
   * @param {string | null} [tag]
   * @returns {import('./types.js').BlobListRow[]}
   */
  list (tag = null) {
    const cols = 'cid, size, mime, createdAt, owner, enc, acl, ttl, pinned, meta, tag'
    if (tag) return /** @type {import('./types.js').BlobListRow[]} */ (this.db.prepare(`SELECT ${cols} FROM blobs WHERE tag = ? ORDER BY createdAt DESC`).all(tag))
    return /** @type {import('./types.js').BlobListRow[]} */ (this.db.prepare(`SELECT ${cols} FROM blobs ORDER BY createdAt DESC`).all())
  }

  /**
   * Cambia el `acl` de un blob (`public` | `private`). Devuelve false si no existe.
   * Se cambia aparte del `upsert` a propósito: volver a subir los mismos bytes NO
   * debe reabrir ni cerrar un blob por accidente.
   * @param {string} cid
   * @param {string | null} acl
   */
  setAcl (cid, acl) {
    const { changes } = this.db.prepare('UPDATE blobs SET acl = ? WHERE cid = ?').run(acl, cid)
    return changes > 0
  }

  /** @param {string} cid */
  remove (cid) {
    this.db.prepare('DELETE FROM blobs WHERE cid = ?').run(cid)
  }

  /**
   * @param {string} cid
   * @param {boolean} pinned
   */
  setPinned (cid, pinned) {
    const { changes } = this.db.prepare('UPDATE blobs SET pinned = ? WHERE cid = ?')
      .run(pinned ? 1 : 0, cid)
    return changes > 0
  }

  /** Suma de bytes indexados. @returns {number} */
  totalBytes () {
    return scalar(this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM blobs'))
  }

  /** @returns {number} */
  count () {
    return scalar(this.db.prepare('SELECT COUNT(*) AS n FROM blobs'))
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
   * Candidatos a liberar espacio por cuota: no pineados, con bytes en disco, y
   * **el menos usado primero** (DISENO.md §15.11). `COALESCE(lastRead, createdAt)`
   * porque lo que nunca se ha leído cuenta por su fecha de subida.
   *
   * @param {{ requireRemote?: boolean }} [opts] `requireRemote` lo pone el backend
   *   con bucket: entonces solo se desaloja lo que el bucket YA confirmó, porque
   *   desalojar es tirar una copia caliente y sin la otra copia sería destruir.
   * @returns {{ cid: string, size: number }[]}
   */
  evictable ({ requireRemote = false } = {}) {
    return /** @type {{ cid: string, size: number }[]} */ (this.db.prepare(`
      SELECT cid, size FROM blobs
      WHERE pinned = 0 AND cached = 1 ${requireRemote ? 'AND remote = 1' : ''}
      ORDER BY COALESCE(lastRead, createdAt) ASC
    `).all())
  }

  /**
   * Marca que estos bytes ya están confirmados en el bucket.
   * @param {string} cid
   * @param {boolean} [remote]
   */
  setRemote (cid, remote = true) {
    const { changes } = this.db.prepare('UPDATE blobs SET remote = ? WHERE cid = ?')
      .run(remote ? 1 : 0, cid)
    return changes > 0
  }

  /**
   * Marca si los bytes están (o ya no) en el disco de esta máquina.
   * @param {string} cid
   * @param {boolean} [cached]
   */
  setCached (cid, cached = true) {
    const { changes } = this.db.prepare('UPDATE blobs SET cached = ? WHERE cid = ?')
      .run(cached ? 1 : 0, cid)
    return changes > 0
  }

  /**
   * Anota que este blob se acaba de leer (es lo que ordena el desalojo).
   * @param {string} cid
   * @param {number} [now]
   */
  touch (cid, now = Date.now()) {
    this.db.prepare('UPDATE blobs SET lastRead = ? WHERE cid = ?').run(now, cid)
  }

  /**
   * Lo que aún NO está confirmado en el bucket: la cola de subida pendiente. Que
   * esto sea una consulta y no una lista en memoria es a propósito — un reinicio
   * a media subida no debe perder el pendiente.
   */
  pendingUpload (limit = 100) {
    return /** @type {{ cid: string, size: number }[]} */ (this.db.prepare(
      'SELECT cid, size FROM blobs WHERE remote = 0 AND cached = 1 ORDER BY createdAt ASC LIMIT ?'
    ).all(limit))
  }

  /** Bytes que ocupan disco AQUÍ (la cuota es de la caché, no del inventario). */
  cachedBytes () {
    return scalar(this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE cached = 1'))
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
   * @param {string} cid
   * @param {string} thumbnailCid
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
  /**
   * @param {{ limit?: number, offset?: number }} [opts]
   * @returns {import('./types.js').PublicRow[]}
   */
  listPublic ({ limit = 100, offset = 0 } = {}) {
    return /** @type {import('./types.js').PublicRow[]} */ (this.db.prepare(`
      SELECT cid, size, mime, createdAt, meta FROM blobs
      WHERE acl = 'public' AND enc = 0
      ORDER BY createdAt DESC LIMIT ? OFFSET ?
    `).all(limit, offset))
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

  /**
   * Bytes servidos ese día.
   * @param {string} day YYYY-MM-DD
   * @returns {number}
   */
  egressOn (day) {
    return Number(this.db.prepare('SELECT COALESCE(bytes, 0) AS n FROM egress WHERE day = ?').get(day)?.n || 0)
  }

  close () {
    this.db.close()
  }
}
