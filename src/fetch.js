/**
 * fetch.js — el node ATIENDE a terceros (DISENO.md §16).
 *
 * Un aparato del acta entra por sesión cifrada (`ops.js`). Cualquier otro —quien
 * recibió un enlace— no tiene sesión ni la tendrá: manda un mensaje suelto por el
 * proxio, `content.fetch { cid }`, y recibe el blob si y solo si está marcado
 * `public` y en claro. Es la misma regla que el modo HTTP (§7.2): sin `public`
 * explícito, no sale nada, y un 'not-found' nunca distingue «no existe» de «no es
 * público» para no confirmar qué guarda el node.
 *
 * Lo que va en la respuesta:
 *  - `url`: el atajo del bucket (§15.13) si el node lo tiene y el bucket ya confirmó
 *    esos bytes. La app la usa para un `<img>`; si falla, vuelve a pedir por aquí.
 *  - `data`: los bytes en base64, salvo `head` o si no caben en un mensaje. Lo que no
 *    cabe se sirve solo por URL; sin bucket, 'too-large' — lo grande es P2P (§13).
 *
 * Límite por remitente (token) para que un enlace viral no convierta el node en un
 * CDN por el proxio: el proxio ya tiene el suyo, y este es el del node.
 */

import { isValidCid } from '../lib/ref.js'
import { MSG, FETCH_MAX_BYTES } from '../lib/public.js'

export { MSG, FETCH_MAX_BYTES }

/**
 * @param {{ client: any, node: import('./node.js').ContentNode, ratePerMin?: number, quiet?: boolean }} opts
 *   client: el `WebSocketProxyClient` YA conectado del agente (no se abre otro).
 * @returns {{ close: () => void, served: () => number }}
 */
export function startPublicFetch ({ client, node, ratePerMin = 60, quiet = false }) {
  if (!client || !node) throw new Error('startPublicFetch: client and node are required')
  /** token → { n, windowStart } */
  const buckets = new Map()
  let served = 0

  const allowed = (from) => {
    const now = Date.now()
    const b = buckets.get(from) || { n: 0, windowStart: now }
    if (now - b.windowStart >= 60_000) { b.n = 0; b.windowStart = now }
    b.n++
    buckets.set(from, b)
    if (buckets.size > 5000) buckets.clear()   // que la tabla no crezca sin techo
    return b.n <= ratePerMin
  }

  const send = (to, obj) => { try { client.send(to, obj) } catch (e) { if (!quiet) console.error('[content] fetch reply:', e.message) } }
  const fail = (to, rid, code, error) => send(to, { type: MSG.FETCH_ERR, rid, code, error })

  const handle = async (from, p) => {
    const rid = typeof p.rid === 'string' ? p.rid : null
    if (!rid) return
    if (!allowed(from)) return fail(from, rid, 'rate-limited', 'too many requests')
    if (!isValidCid(p.cid)) return fail(from, rid, 'bad-input', 'invalid cid')
    const meta = node.stat(p.cid)
    // Mismo 'not-found' para «no existe» y «no es público»: el mismo motivo que §7.2.
    if (!meta || meta.acl !== 'public' || meta.enc) return fail(from, rid, 'not-found', 'no such public cid')
    const url = node.publicUrl(p.cid)
    const out = { type: MSG.FETCH_OK, rid, cid: p.cid, mime: meta.mime, size: meta.size, url }
    if (!p.head) {
      if (meta.size > FETCH_MAX_BYTES) {
        if (!url) return fail(from, rid, 'too-large', `${meta.size} bytes do not fit in a message and this node has no public bucket`)
        // Cabe solo por URL: se contesta sin bytes y la app carga por ahí.
      } else {
        const chunks = []
        for await (const c of node.read(p.cid)) chunks.push(c)
        out.data = Buffer.concat(chunks).toString('base64')
      }
    }
    served++
    send(from, out)
  }

  const off = client.on('message', (from, p) => {
    if (!p || p.type !== MSG.FETCH) return
    handle(from, p).catch((e) => fail(from, p.rid, 'failed', e.message))
  })

  return {
    served: () => served,
    close () { try { off?.() } catch (_) {} }
  }
}

export default { startPublicFetch, MSG, FETCH_MAX_BYTES }
