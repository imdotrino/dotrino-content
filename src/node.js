/**
 * ContentNode = BlobStore (bytes) + Index (metadatos) + cuota/GC (Fase 1).
 *
 * Sigue sin saber de red: quien la pone es `agent.js` (Fase 2), que además le dice
 * qué `owner` representa —la huella de la maestra del vault, la mitad izquierda de
 * la referencia compartible `ownerId + cid` (DISENO.md §3)— y usa el `acl` para
 * decidir qué puede salir del node cuando llegue el modo público (§7.2).
 */
import { mkdir } from 'node:fs/promises'
import { BlobStore, isValidCid } from './blobstore.js'
import { Index } from './db.js'

export { isValidCid }

export class ContentNode {
  /**
   * @param {{ dir: string, maxBytes?: number, maxBlobBytes?: number, owner?: string|null,
   *           store?: any, log?: (m:string)=>void }} opts
   *   dir: raíz de datos · maxBytes: cuota total de disco (0 = sin límite)
   *   maxBlobBytes: tamaño máximo por blob (0 = sin límite)
   *   owner: `ownerId` de la maestra (lo pone el agente al enlazar; null sin vault)
   *   store: almacén ya montado (`storage.js`); por defecto, disco
   */
  constructor (opts) {
    if (!opts?.dir) throw new Error('opts.dir is required')
    this.dir = opts.dir
    this.maxBytes = opts.maxBytes || 0
    this.maxBlobBytes = opts.maxBlobBytes || 0
    this.owner = opts.owner || null
    // El almacén se puede INYECTAR (`storage.js` monta el de bucket cuando toca). Por
    // defecto, disco: sin configuración, un node funciona con lo que hay en la máquina.
    this.store = opts.store || new BlobStore(opts.dir)
    // Base de la URL pública del bucket (§15.13). Sin bucket público es null y lo
    // público viaja por la red, que es el camino que SIEMPRE existe.
    this.publicBase = opts.publicBase || null
    this.index = null
    /** Subidas al bucket en curso, por cid: para no lanzar dos veces la misma. */
    this._uploading = new Map()
    this.log = opts.log || (() => {})
  }

  async init () {
    await mkdir(this.dir, { recursive: true })
    await this.store.init()
    this.index = new Index(this.dir)
    return this
  }

  /**
   * Sube un stream. Si la cuota no alcanza, intenta GC de no-pineados; si aun
   * así no cabe, rechaza con code ENOSPC (no borra pineados jamás).
   */
  async put (readable, { mime = 'application/octet-stream', enc = 0, ttl = null, acl = null, meta = null } = {}) {
    const { cid, size, existed } = await this.store.put(readable, {
      maxBytes: this.maxBlobBytes || undefined
    })
    if (this.maxBytes && !existed) {
      // La cuota es del DISCO, así que cuenta lo que está cacheado aquí, no el
      // inventario: con bucket detrás, lo desalojado sigue existiendo (§15.11)
      // pero ya no ocupa nada — contarlo dejaría la cuota excedida para siempre.
      const over = (this.index.cachedBytes() + size) - this.maxBytes
      if (over > 0 && this.gc({ needBytes: over }).freed < over) {
        await this.store.remove(cid)
        throw Object.assign(new Error('disk quota exceeded'), { code: 'ENOSPC' })
      }
    }
    this.index.upsert({ cid, size, mime, owner: this.owner, enc, acl, ttl, meta })
    // Con bucket detrás, la subida va DESPUÉS de responder: quien sube no espera a la
    // red. Hasta que el bucket confirme, este blob no es desalojable (§15.11).
    if (!existed) this.backup(cid, { size, mime, public: acl === 'public' })
    return { cid, size, mime, existed }
  }

  /** Metadatos de un blob (o null). */
  stat (cid) {
    return isValidCid(cid) ? this.index.get(cid) : null
  }

  /**
   * La URL pública de un blob, o null. Es un ATAJO (§15.13), nunca el enlace: solo
   * existe si hay bucket público, el blob está marcado público y en claro, y el
   * bucket YA confirmó esos bytes (`remote`) — una URL que todavía da 404 no ayuda.
   */
  publicUrl (cid) {
    if (!this.publicBase || !this.store.backed || typeof this.store.urlFor !== 'function') return null
    const m = this.stat(cid)
    if (!m || m.acl !== 'public' || m.enc || !m.remote) return null
    return this.store.urlFor(cid, this.publicBase)
  }

  /**
   * Marca un blob como público o privado (`acl`). Es lo único que autoriza a que
   * los bytes salgan del node cuando esté encendido el modo público (DISENO.md
   * §7.2); sin `public` explícito, no sale.
   */
  setAcl (cid, acl) {
    const ok = this.index.setAcl(cid, acl)
    // Publicar mueve los bytes al bucket público, que es OTRO bucket (§15.1). Sin esto
    // el blob quedaría marcado público y sin estar donde se sirve lo público.
    if (ok && acl === 'public' && this.store.backed) {
      const m = this.index.get(cid)
      if (m && !m.enc) this.backup(cid, { size: m.size, mime: m.mime, public: true })
    }
    return ok
  }

  /**
   * Sube un blob a su bucket y lo marca `remote` **solo cuando el bucket confirma**.
   * Marcar al lanzar la subida es exactamente el error que deja perder contenido: un
   * GC oportuno se llevaría la única copia que existe.
   *
   * No espera nadie a esto (se lanza y se olvida), pero un fallo se REPORTA: lo que no
   * subió sigue siendo la cola pendiente del índice, y se reintenta al arrancar.
   */
  backup (cid, meta) {
    if (!this.store.backed) return null
    // Si ya hay una subida en curso (la privada, típicamente), esta va DETRÁS, no se
    // descarta: publicar a mitad de la subida tiene que terminar en el bucket público.
    const prev = this._uploading.get(cid)
    const p = (prev ? prev.catch(() => {}) : Promise.resolve())
      .then(() => this.store.upload(cid, meta))
      .then(() => { this.index.setRemote(cid, true) })
      .catch((e) => { this.log(`[storage] could not upload ${cid.slice(0, 14)}…: ${e.message}`) })
      .finally(() => this._uploading.delete(cid))
    this._uploading.set(cid, p)
    return p
  }

  /**
   * Reintenta lo que quedó sin subir. Se llama al arrancar: un reinicio a media subida
   * no debe perder el pendiente, y por eso la cola es una consulta al índice y no una
   * lista en memoria.
   */
  async backupPending (limit = 100) {
    if (!this.store.backed) return { pending: 0 }
    const rows = this.index.pendingUpload(limit)
    for (const r of rows) {
      const m = this.index.get(r.cid)
      if (m) await this.backup(r.cid, { size: m.size, mime: m.mime, public: m.acl === 'public' })
    }
    return { pending: rows.length }
  }

  /**
   * Metadatos de presentación (nombre/título/descripción). Es lo único con lo que
   * el permalink público arma su tarjeta (DISENO.md §7.3): sin esto una vista
   * previa solo puede decir el tipo y el tamaño.
   */
  setMeta (cid, meta) {
    return this.index.setMeta(cid, meta)
  }

  /** Enlaza la miniatura pública de un blob (la genera la app, no el node). */
  setThumbnail (cid, thumbnailCid) {
    return this.index.setThumbnail(cid, thumbnailCid)
  }

  /** Índice de lo servible al mundo (público y en claro). */
  listPublic (opts) {
    return this.index.listPublic(opts)
  }

  /**
   * ¿Puede este blob salir del node por el HTTP público? Dos condiciones, y las
   * dos se comprueban aquí —en el único sitio por donde salen los bytes— aunque
   * `ops.acl` ya impida marcar público lo cifrado: un índice traído de otra
   * versión, o tocado a mano, no debe poder abrir una puerta.
   * @returns {any|null} los metadatos si es servible, null si no.
   */
  publicStat (cid) {
    const meta = this.stat(cid)
    if (!meta || meta.acl !== 'public' || meta.enc) return null
    return meta
  }

  /**
   * ReadStream del blob; range = { start, end } inclusivo.
   *
   * Anota el acceso (`lastRead`), que es lo que ordena el desalojo de la caché
   * (§15.11): sin esto, el GC tira lo más antiguo, y lo antiguo y muy pedido es
   * justo lo que hay que conservar.
   */
  read (cid, range) {
    this.index.touch(cid)
    return this.store.read(cid, range)
  }

  async remove (cid) {
    await this.store.remove(cid)
    this.index.remove(cid)
  }

  list () {
    return this.index.list()
  }

  pin (cid, pinned = true) {
    return this.index.setPinned(cid, pinned)
  }

  stats () {
    const cached = this.index.cachedBytes()
    return {
      blobs: this.index.count(),
      // `bytes` es lo que ocupa el disco (lo que mira la cuota); `totalBytes` es
      // el inventario entero, que con bucket es mayor porque incluye lo desalojado.
      bytes: cached,
      totalBytes: this.index.totalBytes(),
      maxBytes: this.maxBytes || null,
      backed: this.store.backed === true,
      dir: this.dir
    }
  }

  /**
   * GC: borra vencidos (ttl) siempre; si `needBytes`, además desaloja
   * no-pineados más viejos hasta liberar esa cantidad.
   * Síncrono sobre el índice; el borrado de disco es fire-and-forget seguro
   * (los bytes huérfanos se re-borran en el próximo GC vía índice… el índice
   * es la fuente de verdad de qué existe).
   */
  /**
   * Libera espacio. Hace DOS cosas distintas y conviene no confundirlas (§15.11):
   *
   *  · **Caducar** (`ttl` vencido) es borrar de verdad: se va la fila, los bytes
   *    locales y —si hay bucket— también los de allí. Es lo que se pidió al subir.
   *  · **Desalojar** por cuota es tirar una copia caliente. Con bucket detrás solo
   *    toca lo que el bucket YA confirmó (`remote = 1`) y **la fila se queda** con
   *    `cached = 0`: si se fuera, el blob quedaría en el bucket sin ACL, sin dueño
   *    y sin tipo. Sin bucket no hay segunda copia, así que desalojar ES destruir
   *    y se comporta como hasta ahora.
   */
  gc ({ needBytes = 0, now = Date.now() } = {}) {
    let freed = 0
    const backed = this.store.backed === true

    const destroy = ({ cid, size }) => {
      this.index.remove(cid)
      this.store.remove(cid).catch(() => {})
      freed += size
    }
    const evict = ({ cid, size }) => {
      if (!backed) return destroy({ cid, size })
      this.store.evict(cid).catch(() => {})
      this.index.setCached(cid, false)
      freed += size
    }

    for (const b of this.index.expired(now)) destroy(b)
    if (needBytes > freed) {
      for (const b of this.index.evictable({ requireRemote: backed })) {
        if (freed >= needBytes) break
        evict(b)
      }
    }
    return { freed }
  }

  close () {
    this.index?.close()
  }
}
