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
   * @param {{ dir: string, maxBytes?: number, maxBlobBytes?: number, owner?: string|null }} opts
   *   dir: raíz de datos · maxBytes: cuota total de disco (0 = sin límite)
   *   maxBlobBytes: tamaño máximo por blob (0 = sin límite)
   *   owner: `ownerId` de la maestra (lo pone el agente al enlazar; null sin vault)
   */
  constructor (opts) {
    if (!opts?.dir) throw new Error('falta opts.dir')
    this.dir = opts.dir
    this.maxBytes = opts.maxBytes || 0
    this.maxBlobBytes = opts.maxBlobBytes || 0
    this.owner = opts.owner || null
    this.store = new BlobStore(opts.dir)
    this.index = null
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
      const over = (this.index.totalBytes() + size) - this.maxBytes
      if (over > 0 && this.gc({ needBytes: over }).freed < over) {
        await this.store.remove(cid)
        throw Object.assign(new Error('cuota de disco excedida'), { code: 'ENOSPC' })
      }
    }
    this.index.upsert({ cid, size, mime, owner: this.owner, enc, acl, ttl, meta })
    return { cid, size, mime, existed }
  }

  /** Metadatos de un blob (o null). */
  stat (cid) {
    return isValidCid(cid) ? this.index.get(cid) : null
  }

  /**
   * Marca un blob como público o privado (`acl`). Es lo único que autoriza a que
   * los bytes salgan del node cuando esté encendido el modo público (DISENO.md
   * §7.2); sin `public` explícito, no sale.
   */
  setAcl (cid, acl) {
    return this.index.setAcl(cid, acl)
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

  /** ReadStream del blob; range = { start, end } inclusivo. */
  read (cid, range) {
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
    return {
      blobs: this.index.count(),
      bytes: this.index.totalBytes(),
      maxBytes: this.maxBytes || null,
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
  gc ({ needBytes = 0, now = Date.now() } = {}) {
    let freed = 0
    const drop = ({ cid, size }) => {
      this.index.remove(cid)
      this.store.remove(cid).catch(() => {})
      freed += size
    }
    for (const b of this.index.expired(now)) drop(b)
    if (needBytes > freed) {
      for (const b of this.index.evictable()) {
        if (freed >= needBytes) break
        drop(b)
      }
    }
    return { freed }
  }

  close () {
    this.index?.close()
  }
}
