/**
 * LA BIBLIOTECA: lo que tus aparatos subieron a este node y puedes abrir en esta máquina.
 *
 * Cada elemento son dos blobs: el archivo, cifrado por tramos (`lib/segments.js`) con una llave
 * propia, y su FICHA, un JSON pequeño con el nombre, el formato y esa llave, cerrado con la llave
 * de la cuenta (`sealAccount`). El node guarda los dos cifrados, y como es un aparato de tu acta
 * recibe la llave de la cuenta como cualquier otro: un node al que no se le envolvió no abre nada,
 * y lo dice.
 *
 * Las fichas son inmutables, porque un `cid` es un hash. Renombrar en el teléfono sube una ficha
 * nueva con el mismo `id`, y manda la de `updatedAt` más reciente.
 */
import { Readable } from 'node:stream'
import { readServiceIdentity } from '@dotrino/vault/service'
import { decryptWithKeyring } from '@dotrino/identity/content'
import { openSegment, plainSize, segmentCount, segmentSpan, SEGMENT_BYTES } from '../lib/segments.js'

export const LIBRARY_TAG = 'library'

const err = (code, message) => Object.assign(new Error(message), { code })

async function collect (stream) {
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return Buffer.concat(chunks)
}

/** La llave de cifrado de este aparato, de su identidad de servicio. */
export function loadEncKey (serviceDir) {
  const saved = readServiceIdentity(serviceDir)
  if (!saved) throw err('no-enc-key', `no readable service identity in ${serviceDir}`)
  if (!saved.enc?.privateJwk) throw err('no-enc-key', 'this node has no encryption key: enroll it again')
  return crypto.subtle.importKey('jwk', { ...saved.enc.privateJwk, key_ops: ['deriveBits'] }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
}

export class Library {
  /**
   * @param {{ node: import('./node.js').ContentNode,
   *           account: () => Promise<{ keyring: any[], myPub: string, myEncPrivateKey: CryptoKey }> }} o
   *   account: el llavero del acta vigente, leído cada vez porque cambia con ella.
   */
  constructor ({ node, account }) {
    this.node = node
    this.account = account
    /** Las fichas ya abiertas: un `cid` no cambia nunca. */
    this._opened = new Map()
  }

  async _open (blob, account) {
    const hit = this._opened.get(blob.cid)
    if (hit) return hit
    const raw = await collect(this.node.read(blob.cid))
    const plain = await decryptWithKeyring({ envelope: JSON.parse(raw.toString('utf8')), ...account })
    const card = { ...JSON.parse(plain), manifest: blob.cid }
    this._opened.set(blob.cid, card)
    return card
  }

  /**
   * Lo que hay. Una ficha que no abre NO se esconde: va en `problems`, porque esconderla sería
   * decirle al dueño que su grabación no existe.
   * @returns {Promise<{ items: any[], problems: {cid:string, error:string}[] }>}
   */
  async list () {
    const account = await this.account()
    const latest = new Map()
    const problems = []
    for (const blob of this.node.list(LIBRARY_TAG)) {
      try {
        const card = await this._open(blob, account)
        const prev = latest.get(card.id)
        if (!prev || card.updatedAt > prev.updatedAt) latest.set(card.id, card)
      } catch (e) {
        problems.push({ cid: blob.cid, error: e.message })
      }
    }
    const items = []
    for (const card of latest.values()) {
      const st = this.node.stat(card.cid)
      if (!st) { problems.push({ cid: card.cid, error: `the file of «${card.name}» is not in this node` }); continue }
      const { key, ...shown } = card
      items.push({ ...shown, size: plainSize(st.size) })
    }
    items.sort((a, b) => b.createdAt - a.createdAt)
    return { items, problems }
  }

  async find (id) {
    const account = await this.account()
    let found = null
    for (const blob of this.node.list(LIBRARY_TAG)) {
      const card = await this._open(blob, account).catch(() => null)
      if (card?.id === id && (!found || card.updatedAt > found.updatedAt)) found = card
    }
    if (!found) throw err('not-found', 'no such item')
    const st = this.node.stat(found.cid)
    if (!st) throw err('not-found', 'its file is not in this node')
    return { card: found, cipherSize: st.size, size: plainSize(st.size) }
  }

  /** Los bytes en claro de [start, end], tramo a tramo: un archivo de 1 GB no entra entero en memoria. */
  stream ({ card, cipherSize, size }, start = 0, end = size - 1) {
    const { node } = this
    const key = Buffer.from(card.key, 'base64')
    async function * gen () {
      const count = segmentCount(cipherSize)
      for (let i = Math.floor(start / SEGMENT_BYTES); i < count && i * SEGMENT_BYTES <= end; i++) {
        const span = segmentSpan(i, cipherSize)
        const cipher = await collect(node.read(card.cid, span))
        const plain = await openSegment(key, i, i === count - 1, cipher)
        const base = i * SEGMENT_BYTES
        yield Buffer.from(plain.subarray(Math.max(0, start - base), Math.min(plain.length, end - base + 1)))
      }
    }
    return Readable.from(gen(), { objectMode: false })
  }

  /** Borra el archivo y todas sus fichas de este node (cada ficha vieja pudo nombrar el suyo). El teléfono conserva su copia. */
  async remove (id) {
    await this.find(id)
    const account = await this.account()
    for (const blob of this.node.list(LIBRARY_TAG)) {
      const c = await this._open(blob, account).catch(() => null)
      if (c?.id !== id) continue
      if (this.node.stat(c.cid)) await this.node.remove(c.cid)
      await this.node.remove(blob.cid)
      this._opened.delete(blob.cid)
    }
  }
}

export default { Library, LIBRARY_TAG, loadEncKey }
