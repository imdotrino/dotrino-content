/**
 * El node que es la propia PWA (DISENO.md §2.1): los bytes del usuario en ESTE aparato,
 * direccionados por su hash (`cid`), en IndexedDB. Es el tier por defecto —cero
 * instalación— y el que responde con el node de verdad apagado. Un node aparte
 * (`ContentClient`) suma disponibilidad; no sustituye a esto.
 *
 * Lo guardado aquí es lo que la app dio, tal cual (§ archivos: nunca se modifica lo del
 * usuario). El índice —qué hay y con qué `cid`— va en el store; aquí solo los bytes.
 */
import { cidOf } from './cid.js'

const DB_NAME = 'dotrino-content-local'
const STORE = 'blobs'

const err = (code, message) => Object.assign(new Error(message), { code })

let opening = null

function db () {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'cid' })
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => { opening = null; reject(req.error) }
    })
  }
  return opening
}

function run (mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  }))
}

/**
 * Guarda un Blob (o bytes) en este aparato.
 * @param {Blob|ArrayBuffer|Uint8Array} data
 * @param {{ mime?: string }} [opts]
 * @returns {Promise<{ cid: string, mime: string, size: number }>}
 */
export async function putLocal (data, opts = {}) {
  const isBlob = typeof Blob !== 'undefined' && data instanceof Blob
  const bytes = isBlob ? await data.arrayBuffer() : data instanceof Uint8Array ? data.slice().buffer : data
  if (!(bytes instanceof ArrayBuffer)) throw err('bad-input', 'putLocal: data must be a Blob, ArrayBuffer or Uint8Array')
  const cid = await cidOf(bytes)
  const mime = opts.mime || (isBlob && data.type) || 'application/octet-stream'
  await run('readwrite', (s) => s.put({ cid, mime, bytes }))
  return { cid, mime, size: bytes.byteLength }
}

/** Los bytes de `cid` en este aparato, como Blob. Lanza `local-missing` si no están. */
export async function getLocal (cid) {
  const row = await run('readonly', (s) => s.get(cid))
  if (!row) throw err('local-missing', `${cid} is not on this device`)
  return new Blob([row.bytes], { type: row.mime })
}

/** ¿Están los bytes de `cid` en este aparato? */
export async function hasLocal (cid) {
  return (await run('readonly', (s) => s.count(cid))) > 0
}

export function removeLocal (cid) {
  return run('readwrite', (s) => s.delete(cid))
}

export { cidOf }
