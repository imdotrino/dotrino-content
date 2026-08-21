/**
 * ops.js — las operaciones del PLANO DE CONTROL del node (DISENO.md §5.1 y §7).
 *
 * Es lo que tus propias apps pueden pedirle a este node a distancia: ver qué
 * guarda, retener, soltar, borrar y marcar qué es público. Módulo PURO: no sabe de
 * red, de sesiones ni de firmas — recibe un objeto ya descifrado y autorizado, y
 * devuelve la respuesta. Así se prueba entero sin levantar nada, y quien autoriza
 * (`agent.js`, vía `@dotrino/remote-agent`) queda en un solo sitio.
 *
 * LO QUE NO ESTÁ, Y NO ES UN OLVIDO: no hay `put`. Los bytes NO viajan por el
 * plano de control, porque el plano de control es el proxy del ecosistema: sus
 * tramas son de 1 MB y su cola es de mensajes, no un almacén (§7.1) — y meter
 * contenido por ahí sería usar la infraestructura de Dotrino como transporte, que
 * es justo la regla dura 3. Subir es local (HTTP en loopback) y, desde la Fase 3,
 * P2P por WebRTC.
 *
 * El contrato de errores es `code`, no la frase: quien recibe compara `code`
 * (`bad-request`, `not-found`, `unknown-op`, `failed`), que es lo estable. La frase
 * es para un humano leyendo una bitácora.
 */

/** Valores admitidos de ACL. Público es OPT-IN explícito; lo que no se dice, privado. */
export const ACL = Object.freeze({ PUBLIC: 'public', PRIVATE: 'private' })

import { isValidCid } from './blobstore.js'

const ok = (rid, result) => ({ rid, ok: true, ...result })
const fail = (rid, code, error) => ({ rid, ok: false, code, error })

/**
 * Construye el despachador de operaciones de un node.
 *
 * @param {import('./node.js').ContentNode} node
 * @param {{ owner?: string|null, version?: string }} [meta]
 *   owner: `ownerId` (huella de la maestra) que este node representa — es la mitad
 *   de la referencia compartible `ownerId + cid` (§3).
 * @returns {(msg: any) => Promise<any>}
 */
export function createOps (node, { owner = null, version = null } = {}) {
  /** Operaciones que exigen un `cid` válido y que el blob exista. */
  const withBlob = (fn) => async (msg) => {
    const cid = typeof msg.cid === 'string' ? msg.cid : null
    if (!cid) return fail(msg.rid, 'bad-request', 'cid is required')
    const meta = node.stat(cid)
    if (!meta) return fail(msg.rid, 'not-found', 'no such cid')
    return fn(msg, cid, meta)
  }

  const handlers = {
    /** Quién es este node: sirve de saludo y de comprobación de vida. */
    hello: async (msg) => ok(msg.rid, { owner, version, stats: node.stats() }),

    list: async (msg) => ok(msg.rid, { blobs: node.list() }),

    stats: async (msg) => ok(msg.rid, { stats: node.stats() }),

    stat: withBlob(async (msg, cid, meta) => ok(msg.rid, { blob: meta })),

    /** Retener: un blob pineado no lo borra el GC ni por cuota ni por ttl. */
    pin: withBlob(async (msg, cid) => ok(msg.rid, { pinned: node.pin(cid, true) })),

    unpin: withBlob(async (msg, cid) => ok(msg.rid, { pinned: !node.pin(cid, false) })),

    remove: withBlob(async (msg, cid) => {
      await node.remove(cid)
      return ok(msg.rid, { removed: cid })
    }),

    /**
     * Marcar un blob como público o privado. Es el interruptor que la Fase 3 mira
     * antes de servir algo por HTTP: sin `public` explícito, no sale del node.
     */
    acl: withBlob(async (msg, cid) => {
      const acl = msg.acl === ACL.PUBLIC ? ACL.PUBLIC : msg.acl === ACL.PRIVATE ? ACL.PRIVATE : null
      if (!acl) return fail(msg.rid, 'bad-request', `acl must be "${ACL.PUBLIC}" or "${ACL.PRIVATE}"`)
      const meta = node.stat(cid)
      // Un blob cifrado no se puede marcar público: nadie sin la llave podría leerlo,
      // así que decir que lo es solo engaña a quien lo mire.
      if (acl === ACL.PUBLIC && meta.enc) return fail(msg.rid, 'bad-request', 'an encrypted blob cannot be public')
      node.setAcl(cid, acl)
      return ok(msg.rid, { cid, acl })
    }),

    /**
     * Metadatos de PRESENTACIÓN (nombre, título, descripción). Es lo único con lo
     * que la vista previa pública arma su tarjeta (§7.3): sin esto, una tarjeta
     * solo puede decir el tipo y el tamaño. No forma parte del `cid` —dos nombres
     * para los mismos bytes son el mismo blob—, por eso se pone aparte.
     */
    meta: withBlob(async (msg, cid) => {
      const src = msg.meta && typeof msg.meta === 'object' ? msg.meta : null
      if (msg.meta !== null && !src) return fail(msg.rid, 'bad-request', 'meta must be an object or null')
      // Se copian SOLO los campos conocidos y recortados: esto acaba en un HTML
      // público, así que no se guarda lo que llegue.
      const clean = src
        ? Object.fromEntries(['name', 'title', 'description']
          .map((k) => [k, typeof src[k] === 'string' ? src[k].trim().slice(0, 300) : null])
          .filter(([, v]) => v))
        : null
      node.setMeta(cid, clean && Object.keys(clean).length ? clean : null)
      return ok(msg.rid, { cid, meta: clean })
    }),

    /**
     * Enlaza la miniatura de un blob. La miniatura es OTRO blob (subido por la
     * app) y tiene que ser pública por su cuenta: enlazarla no la publica.
     */
    thumb: withBlob(async (msg, cid) => {
      const t = msg.thumbnailCid
      if (t !== null && !isValidCid(t)) return fail(msg.rid, 'bad-request', 'thumbnailCid must be a valid cid or null')
      if (t && !node.stat(t)) return fail(msg.rid, 'not-found', 'the thumbnail is not in this node')
      node.setThumbnail(cid, t)
      return ok(msg.rid, { cid, thumbnailCid: t })
    }),

    /** Recolección de vencidos (lo que el temporizador hace solo, a pedido). */
    gc: async (msg) => ok(msg.rid, node.gc())
  }

  return async function dispatch (msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.op !== 'string') {
      return fail(msg?.rid, 'bad-request', 'op is required')
    }
    const handler = handlers[msg.op]
    if (!handler) return fail(msg.rid, 'unknown-op', `unknown op: ${msg.op}`)
    try {
      return await handler(msg)
    } catch (e) {
      return fail(msg.rid, e?.code === 'ENOSPC' ? 'no-space' : 'failed', e?.message || 'failed')
    }
  }
}

export default { createOps, ACL }
