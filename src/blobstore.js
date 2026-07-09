/**
 * Almacén de blobs direccionado por contenido (Fase 1, DISENO.md §3).
 *
 * - `cid = sha256-<hex>` (prefijo de algoritmo → extensible a blake3 después).
 *   Se usa SHA-256 de `node:crypto` porque no requiere dependencias nativas
 *   (el `.npmrc` del ecosistema bloquea los build scripts de npm).
 * - Disco: `blobs/<aa>/<bb>/<cid>` (sharding por los 4 primeros hex del hash).
 * - Escritura por streaming: se hashea MIENTRAS se escribe a un tmp y al final
 *   se renombra al path definitivo (dedup gratis: si ya existe, se descarta).
 */
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import path from 'node:path'

const CID_RE = /^sha256-[0-9a-f]{64}$/

export function isValidCid (cid) {
  return typeof cid === 'string' && CID_RE.test(cid)
}

export class BlobStore {
  /** @param {string} root directorio raíz de datos (contiene blobs/ y tmp/) */
  constructor (root) {
    this.root = root
    this.blobsDir = path.join(root, 'blobs')
    this.tmpDir = path.join(root, 'tmp')
  }

  async init () {
    await mkdir(this.blobsDir, { recursive: true })
    await mkdir(this.tmpDir, { recursive: true })
  }

  /** Path en disco de un cid (no comprueba existencia). */
  pathFor (cid) {
    if (!isValidCid(cid)) throw new Error(`cid inválido: ${cid}`)
    const hex = cid.slice('sha256-'.length)
    return path.join(this.blobsDir, hex.slice(0, 2), hex.slice(2, 4), cid)
  }

  /** ¿Existe el blob en disco? → size o null. */
  async sizeOf (cid) {
    try {
      const st = await stat(this.pathFor(cid))
      return st.size
    } catch {
      return null
    }
  }

  /**
   * Guarda un stream hasheando al vuelo.
   * @param {import('node:stream').Readable} readable
   * @param {{ maxBytes?: number }} [opts] límite duro de tamaño (corta el stream)
   * @returns {Promise<{ cid: string, size: number, existed: boolean }>}
   */
  async put (readable, opts = {}) {
    const tmp = path.join(this.tmpDir, `up-${randomBytes(8).toString('hex')}`)
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform (chunk, _enc, cb) {
        size += chunk.length
        if (opts.maxBytes && size > opts.maxBytes) {
          cb(Object.assign(new Error('blob demasiado grande'), { code: 'ETOOBIG' }))
          return
        }
        hash.update(chunk)
        cb(null, chunk)
      }
    })
    try {
      await pipeline(readable, meter, createWriteStream(tmp))
      const cid = `sha256-${hash.digest('hex')}`
      const dest = this.pathFor(cid)
      if (await this.sizeOf(cid) !== null) {
        // dedup: ya lo teníamos, descartar el tmp
        await rm(tmp, { force: true })
        return { cid, size, existed: true }
      }
      await mkdir(path.dirname(dest), { recursive: true })
      await rename(tmp, dest)
      return { cid, size, existed: false }
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
  }

  /**
   * Stream de lectura, con rango opcional [start, end] inclusivo.
   * @returns {import('node:fs').ReadStream}
   */
  read (cid, range) {
    const p = this.pathFor(cid)
    return range
      ? createReadStream(p, { start: range.start, end: range.end })
      : createReadStream(p)
  }

  async remove (cid) {
    await rm(this.pathFor(cid), { force: true })
  }
}
