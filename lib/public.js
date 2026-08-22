/**
 * public.js — leer contenido PÚBLICO de otro dueño por la red de Dotrino.
 *
 * Es el camino del tercero (DISENO.md §16): quien recibe una referencia
 * `ownerId + cid` no tiene sesión con ese node ni la va a tener —las sesiones son de
 * los aparatos del acta—. Lo que sí puede hacer es lo mismo que con un teléfono:
 * buscar al dueño en la guía (el canal `content_<owner>` del proxio, §3.1) y
 * pedirle el `cid` en un mensaje suelto. El node contesta SOLO lo marcado público y
 * en claro, y el que pide comprueba que los bytes cuadren con el `cid`: el node no
 * es autoridad de nada, el hash sí.
 *
 * Si el node tiene bucket, contesta además la URL pública (§15.13): es un ATAJO
 * para cargar la imagen con un `<img>` sin mover los bytes por el proxio. Nunca es
 * el enlace —el enlace sigue siendo `app/#owner/cid`— y si la URL falla, se vuelve
 * a pedir por la red.
 *
 * Isomórfico: el `client` es un `WebSocketProxyClient` ya conectado (el que la app
 * ya tiene; no se abre otro). Sin dependencias.
 */

import { isValidCid } from './ref.js'

/** Nombre del canal de un dueño dentro de un proxio (espejo de src/announce.js). */
export const channelFor = (nodeId, ownerId) => `${nodeId}/content_${ownerId}`

export const MSG = Object.freeze({
  FETCH: 'content.fetch',
  FETCH_OK: 'content.fetch.ok',
  FETCH_ERR: 'content.fetch.err'
})

/** Lo que cabe en un mensaje del proxio: el mismo tope que el plano de control. */
export const FETCH_MAX_BYTES = 256 * 1024

const b64ToBytes = (s) => /** @type {Uint8Array<ArrayBuffer>} */ (Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

async function cidOf (bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return 'sha256-' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const err = (code, msg) => Object.assign(new Error(msg), { code })

/**
 * Los nodes de un dueño que están en línea ahora mismo, como tokens del proxio.
 * Se mira en todos los proxios de la malla: un canal sin prefijo es local a cada
 * uno, y el node se anuncia en todos. Quitarse a uno mismo evita que una app con
 * node propio se pregunte a sí misma.
 * @param {{ client: any, owner: string }} opts
 * @returns {Promise<string[]>}
 */
export async function findNodes ({ client, owner }) {
  if (!client || !owner) throw new Error('findNodes: client and owner are required')
  const known = Array.isArray(client.knownNodes) && client.knownNodes.length
    ? client.knownNodes
    : (client.node ? [client.node] : [])
  const out = new Set()
  for (const nodeId of known) {
    try {
      for (const token of await client.list(channelFor(nodeId, owner))) out.add(token)
    } catch (_) { /* un proxio que no contesta no invalida al otro */ }
  }
  if (client.token) out.delete(client.token)
  return [...out]
}

let rid = 0

/**
 * Pide un `cid` público a un node concreto (por su token) y espera la respuesta.
 * @returns {Promise<{ cid: string, mime: string, size: number, url: string|null, bytes: Uint8Array<ArrayBuffer>|null }>}
 */
export async function fetchFrom ({ client, token, cid, head = false, full = false, timeoutMs = 8000 }) {
  const id = `f${++rid}`
  const reply = new Promise((resolve, reject) => {
    const done = (fn, v) => { off(); clearTimeout(t); fn(v) }
    const off = client.on('message', (_from, p) => {
      if (!p || p.rid !== id) return
      if (p.type === MSG.FETCH_OK) done(resolve, p)
      else if (p.type === MSG.FETCH_ERR) done(reject, err(p.code || 'failed', p.error || 'fetch failed'))
    })
    const t = setTimeout(() => done(reject, err('timeout', 'the node did not answer')), timeoutMs)
  })
  client.send(token, { type: MSG.FETCH, rid: id, cid, head: !!head, full: !!full })
  const p = await reply
  let bytes = null
  if (typeof p.data === 'string') {
    bytes = b64ToBytes(p.data)
    // El node no es autoridad: lo que diga que es el cid tiene que SERLO.
    if (await cidOf(bytes) !== cid) throw err('corrupt', 'the bytes do not match the cid')
  }
  return { cid, mime: p.mime || 'application/octet-stream', size: Number(p.size) || (bytes?.length ?? 0), url: p.url || null, bytes }
}

/**
 * Resuelve una referencia pública `ownerId + cid` por la red: encuentra un node
 * vivo del dueño y le pide el blob. Prueba los que haya hasta que uno conteste.
 *
 * @param {{ client: any, owner: string, cid: string, head?: boolean, full?: boolean, timeoutMs?: number }} opts
 *   head: solo metadatos y URL, sin bytes.
 *   full: los bytes aunque haya URL (por defecto, con URL el node no los manda:
 *   cargas por la URL y solo vuelves aquí con `full` si te falló).
 * @throws {Error & {code:'no-node'|'not-found'|'private'|'too-large'|'corrupt'|'timeout'}}
 */
export async function fetchPublic ({ client, owner, cid, head = false, full = false, timeoutMs = 8000 }) {
  if (!isValidCid(cid)) throw err('bad-input', 'invalid cid')
  const tokens = await findNodes({ client, owner })
  if (!tokens.length) throw err('no-node', 'no node of that owner is online')
  let last = null
  for (const token of tokens) {
    try {
      return await fetchFrom({ client, token, cid, head, full, timeoutMs })
    } catch (e) {
      last = e
      // Si el node CONTESTÓ que no (privado, no existe), otro node del mismo dueño
      // dirá lo mismo: no tiene sentido insistir. Solo se reintenta lo que fue ruido.
      if (e.code && e.code !== 'timeout' && e.code !== 'corrupt') throw e
    }
  }
  throw last || err('no-node', 'no node answered')
}

export default { channelFor, findNodes, fetchFrom, fetchPublic, MSG, FETCH_MAX_BYTES }
