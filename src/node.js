/**
 * ContentNode = BlobStore (bytes) + Index (metadatos) + cuota/GC (Fase 1).
 * Sin red ni identidad: eso llega en Fases 2/3 (DISENO.md §11).
 */
import { mkdir } from 'node:fs/promises'
import { BlobStore, isValidCid } from './blobstore.js'
import { Index } from './db.js'

export { isValidCid }

export class ContentNode {
  /**
   * @param {{ dir: string, maxBytes?: number, maxBlobBytes?: number }} opts
   *   dir: raíz de datos · maxBytes: cuota total de disco (0 = sin límite)
   *   maxBlobBytes: tamaño máximo por blob (0 = sin límite)
   */
  constructor (opts) {
    if (!opts?.dir) throw new Error('falta opts.dir')
    this.dir = opts.dir
    this.maxBytes = opts.maxBytes || 0
    this.maxBlobBytes = opts.maxBlobBytes || 0
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
  async put (readable, { mime = 'application/octet-stream', enc = 0, ttl = null } = {}) {
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
    this.index.upsert({ cid, size, mime, enc, ttl })
    return { cid, size, mime, existed }
  }

  /** Metadatos de un blob (o null). */
  stat (cid) {
    return isValidCid(cid) ? this.index.get(cid) : null
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
