/**
 * SUBIDAS GRANDES desde otro aparato tuyo, por la sesión cifrada (`up.*` de `ops.js`).
 *
 * Quien sube dice de antemano el `cid` y el tamaño, y lo que llega se va escribiendo en un
 * archivo con el nombre del `cid`. Si la conexión se corta, `begin` dice cuánto hay y se sigue
 * desde ahí: un archivo de 1 GB no vuelve a empezar. Al final se comprueba el hash: si no
 * cuadra, se borra y no entra nada.
 *
 * Lo grande no cruza la red de Dotrino (`lib/network.js`, DISENO.md §7.1): eso lo comprueba
 * `ops.js` en cada parte, porque el camino puede cambiar a mitad.
 */
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rm, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { isValidCid } from './blobstore.js'

/** Una subida abandonada se borra a la semana: el aparato que la dejó tuvo tiempo de sobra. */
const ABANDONED_MS = 7 * 24 * 3600 * 1000

const err = (code, message) => Object.assign(new Error(message), { code })

export class Uploads {
  /** @param {import('./node.js').ContentNode} node */
  constructor (node) {
    this.node = node
    this.dir = path.join(node.dir, 'uploads')
    /** @type {Map<string, {size:number, mime:string, enc:number, tag:string|null}>} */
    this.open = new Map()
  }

  async _sizeOnDisk (cid) {
    try { return (await stat(path.join(this.dir, cid))).size } catch (e) {
      if (e.code === 'ENOENT') return 0
      throw e
    }
  }

  async sweep (now = Date.now()) {
    let names
    try { names = await readdir(this.dir) } catch (e) {
      if (e.code === 'ENOENT') return
      throw e
    }
    for (const n of names) {
      const f = path.join(this.dir, n)
      if (now - (await stat(f)).mtimeMs > ABANDONED_MS) await rm(f, { force: true })
    }
  }

  /** @returns {Promise<{existed:true}|{existed:false, at:number}>} */
  async begin ({ cid, size, mime, enc, tag }) {
    if (!isValidCid(cid)) throw err('bad-request', 'cid is not valid')
    if (!Number.isSafeInteger(size) || size <= 0) throw err('bad-request', 'size must be a positive integer')
    const { maxBlobBytes } = this.node
    if (maxBlobBytes && size > maxBlobBytes) throw err('too-large', `this node accepts blobs up to ${maxBlobBytes} bytes`)
    if (this.node.stat(cid)) return { existed: true }
    await mkdir(this.dir, { recursive: true })
    await this.sweep()
    let at = await this._sizeOnDisk(cid)
    // Un resto más largo que lo anunciado no es de esta subida: se empieza de cero.
    if (at > size) { await rm(path.join(this.dir, cid), { force: true }); at = 0 }
    this.open.set(cid, { size, mime, enc, tag })
    return { existed: false, at }
  }

  /** Escribe lo que llega en `at`, que tiene que ser justo donde acabó lo anterior. */
  async part (cid, at, bytes) {
    const up = this.open.get(cid)
    if (!up) throw err('unknown-upload', 'no such upload: call up.begin')
    const f = path.join(this.dir, cid)
    const have = await this._sizeOnDisk(cid)
    if (at !== have) throw err('wrong-offset', `expected offset ${have}`)
    if (at + bytes.length > up.size) throw err('bad-request', 'more bytes than announced')
    const fh = await open(f, 'a')
    try { await fh.write(bytes) } finally { await fh.close() }
    const now = new Date()
    await utimes(f, now, now)
    return at + bytes.length
  }

  /** Comprueba el hash y mete el archivo en el node. */
  async finish (cid) {
    const up = this.open.get(cid)
    if (!up) throw err('unknown-upload', 'no such upload: call up.begin')
    const f = path.join(this.dir, cid)
    const have = await this._sizeOnDisk(cid)
    if (have !== up.size) throw err('incomplete', `got ${have} of ${up.size} bytes`)
    let out
    try {
      out = await this.node.put(createReadStream(f), { mime: up.mime, enc: up.enc, tag: up.tag })
    } catch (e) {
      // Sin espacio se conserva lo subido: cuando haya sitio no hace falta volver a mandarlo.
      if (e.code === 'ENOSPC') throw e
      await rm(f, { force: true })
      throw e
    }
    this.open.delete(cid)
    await rm(f, { force: true })
    if (out.cid !== cid) {
      await this.node.remove(out.cid)
      throw err('corrupt', 'the bytes do not match the cid')
    }
    return out
  }
}

export default { Uploads }
