/**
 * ops.js — las operaciones del PLANO DE CONTROL del node (DISENO.md §5.1 y §7).
 *
 * Es lo que tus propias apps pueden pedirle a este node a distancia: ver qué
 * guarda, retener, soltar, borrar y marcar qué es público. Módulo PURO: no sabe de
 * red, de sesiones ni de firmas — recibe un objeto ya descifrado y autorizado, y
 * devuelve la respuesta. Así se prueba entero sin levantar nada, y quien autoriza
 * (`agent.js`, vía `@dotrino/remote-agent`) queda en un solo sitio.
 *
 * SOBRE `put` Y `get`: existen, pero con un TOPE DURO de un mensaje (256 KB), y
 * eso no es una limitación técnica que haya que levantar después — es la frontera
 * (§7.1). El plano de control es el proxy del ecosistema: sus tramas son de 1 MB y
 * su cola es de mensajes, no un almacén, y meter contenido por ahí sería usar la
 * infraestructura de Dotrino como transporte, que es la regla dura 3. Por eso NO
 * hay subida por partes: si algo no cabe en un mensaje, es que no es un mensaje.
 *
 * Lo que sí es un mensaje y por eso pasa: **un post** (un eco pesa cientos de
 * bytes) y **una miniatura** (decenas de KB). Los originales suben en local por
 * HTTP y, entre aparatos, por P2P — que es lo que este tope deja pendiente a
 * propósito en vez de disimularlo con un troceado.
 *
 * El contrato de errores es `code`, no la frase: quien recibe compara `code`
 * (`bad-request`, `not-found`, `unknown-op`, `failed`), que es lo estable. La frase
 * es para un humano leyendo una bitácora.
 */

/** Valores admitidos de ACL. Público es OPT-IN explícito; lo que no se dice, privado. */
export const ACL = Object.freeze({ PUBLIC: 'public', PRIVATE: 'private' })

/**
 * Tope de lo que puede entrar o salir por el plano de control, en bytes crudos.
 * En base64 dentro del sobre cifrado son ~350 KB, cómodos bajo la trama de 1 MB
 * del proxy. **Es una frontera de diseño, no un parámetro a subir**: lo que no
 * cabe aquí no es un mensaje y va por el otro camino.
 */
export const CONTROL_PLANE_MAX_BYTES = 256 * 1024

import { Readable } from 'node:stream'
import { isValidCid } from './blobstore.js'

const ok = (rid, result) => ({ rid, ok: true, ...result })
const fail = (rid, code, error) => ({ rid, ok: false, code, error })

/**
 * Metadatos de presentación, quedándose SOLO con los campos conocidos y
 * recortados. Esto acaba en un HTML público (§7.3), así que no se guarda lo que
 * llegue: ni campos de más ni textos sin fin.
 * @returns {{name?:string,title?:string,description?:string}|null}
 */
function cleanMeta (src) {
  if (!src || typeof src !== 'object') return null
  const out = Object.fromEntries(['name', 'title', 'description']
    .map((k) => [k, typeof src[k] === 'string' ? src[k].trim().slice(0, 300) : null])
    .filter(([, v]) => v))
  return Object.keys(out).length ? out : null
}

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
    hello: async (msg) => ok(msg.rid, {
      owner, version, stats: node.stats(), maxBytes: CONTROL_PLANE_MAX_BYTES
    }),

    /**
     * Guardar algo pequeño desde otro aparato tuyo. Los bytes llegan en base64
     * dentro del sobre ya cifrado de la sesión, en UN mensaje: no hay subida por
     * partes y no la va a haber (ver la cabecera del archivo).
     *
     * Que el aparato esté autorizado ya lo comprobó `verifyChain` antes de que
     * esto se llame; aquí solo se comprueba la forma y el tamaño.
     */
    put: async (msg) => {
      if (typeof msg.data !== 'string') return fail(msg.rid, 'bad-request', 'data (base64) is required')
      let buf
      try { buf = Buffer.from(msg.data, 'base64') } catch { return fail(msg.rid, 'bad-request', 'data is not valid base64') }
      if (!buf.length) return fail(msg.rid, 'bad-request', 'empty payload')
      if (buf.length > CONTROL_PLANE_MAX_BYTES) {
        return fail(msg.rid, 'too-large',
          `the control plane carries up to ${CONTROL_PLANE_MAX_BYTES} bytes; upload larger blobs locally or peer to peer`)
      }
      const enc = msg.enc ? 1 : 0
      // Mismo cerrojo que en `acl`, y por lo mismo: decir que algo cifrado es
      // público solo engaña a quien lo mire, porque nadie sin la llave lo lee.
      const acl = msg.acl === ACL.PUBLIC && !enc ? ACL.PUBLIC : ACL.PRIVATE
      const ttlMs = Number(msg.ttl) || 0
      const out = await node.put(Readable.from(buf), {
        mime: typeof msg.mime === 'string' ? msg.mime : 'application/octet-stream',
        enc,
        acl,
        ttl: ttlMs > 0 ? Date.now() + ttlMs : null,
        meta: cleanMeta(msg.meta)
      })
      return ok(msg.rid, { ...out, acl })
    },

    /**
     * Leer algo pequeño de vuelta (otro aparato tuyo, o el mismo tras reinstalar).
     * Mismo tope, y por la misma razón: esto es el plano de control.
     */
    get: withBlob(async (msg, cid, meta) => {
      if (meta.size > CONTROL_PLANE_MAX_BYTES) {
        return fail(msg.rid, 'too-large',
          `${meta.size} bytes do not fit in the control plane; fetch it locally or peer to peer`)
      }
      const chunks = []
      for await (const c of node.read(cid)) chunks.push(c)
      return ok(msg.rid, {
        cid, size: meta.size, mime: meta.mime, enc: meta.enc, data: Buffer.concat(chunks).toString('base64')
      })
    }),

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
      if (msg.meta !== null && (!msg.meta || typeof msg.meta !== 'object')) {
        return fail(msg.rid, 'bad-request', 'meta must be an object or null')
      }
      const clean = cleanMeta(msg.meta)
      node.setMeta(cid, clean)
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

export default { createOps, ACL, CONTROL_PLANE_MAX_BYTES }
